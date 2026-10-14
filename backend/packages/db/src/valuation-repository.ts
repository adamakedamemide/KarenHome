import { PostgresDatabase, type QueryExecutor } from './postgres-database';

/**
 * Gate 5.1 Phase E — Valuation domain repository.
 *
 * Frozen tables (base 0019) + 0040 additive governance:
 *   valuation.cases        — property-anchored valuation request; 0040 adds the
 *                            requesting-org binding (organization_id NOT NULL FK),
 *                            updated_at, org access index; status transitions are
 *                            DB-authoritative (valuation.status_values /
 *                            status_transitions + triggers, 0039 pattern).
 *   valuation.results      — ONE result per case (case_id UNIQUE); numeric(20,4)
 *                            exact money; sealed (immutable) once the parent case
 *                            is completed/expired (0040 G4 triggers).
 *   valuation.comparables  — evidence rows; explicit canonical currency_code
 *                            (0040 G6, inherited deterministically from the parent
 *                            result — no conversion, no FX logic anywhere).
 *
 * Money/decimal columns are NEVER converted through JS numbers: pg returns
 * numeric as string and this repository keeps them strings end-to-end.
 */

export interface ValuationCaseRow {
  id: string;
  property_id: string;
  requested_by_user_id: string | null;
  status: string;
  method: string;
  model_version: string | null;
  organization_id: string;
  requested_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
  updated_at: Date;
}

export interface ValuationResultRow {
  id: string;
  case_id: string;
  min_value: string;
  estimated_value: string;
  max_value: string;
  currency_code: string;
  confidence: string | null;
  price_per_m2: string | null;
  generated_at: Date;
}

export interface ValuationComparableRow {
  valuation_result_id: string;
  comparable_property_id: string;
  comparable_listing_id: string | null;
  similarity_score: string | null;
  distance_m: string | null;
  adjusted_price: string | null;
  currency_code: string;
}

/**
 * Milestone 2 — one answer row of the reverse comparable traceability: a case
 * that used the queried property as comparable evidence, flattened case columns
 * plus the evidence linkage (usage_* aliases; all money values stay strings).
 */
export interface ValuationComparableUsageRow {
  id: string;
  property_id: string;
  requested_by_user_id: string | null;
  status: string;
  method: string;
  model_version: string | null;
  organization_id: string;
  requested_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
  updated_at: Date;
  usage_result_id: string;
  usage_similarity_score: string | null;
  usage_distance_m: string | null;
  usage_adjusted_price: string | null;
  usage_currency_code: string;
}

const CASE_COLS = `id, property_id, requested_by_user_id, status::text AS status, method, model_version,
  organization_id, requested_at, completed_at, expires_at, updated_at`;

const RESULT_COLS = `id, case_id, min_value, estimated_value, max_value, currency_code, confidence, price_per_m2, generated_at`;

const COMPARABLE_COLS = `valuation_result_id, comparable_property_id, comparable_listing_id,
  similarity_score, distance_m, adjusted_price, currency_code`;

export class ValuationRepository {
  constructor(private readonly db: PostgresDatabase) {}

  // ---------------------------------------------------------------- existence lookups

  async getProperty(id: string, executor: QueryExecutor = this.db): Promise<{ id: string } | null> {
    const r = await executor.query<{ id: string }>(
      `SELECT id FROM property.properties WHERE id = $1::uuid`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async getListing(id: string, executor: QueryExecutor = this.db): Promise<{ id: string } | null> {
    const r = await executor.query<{ id: string }>(
      `SELECT id FROM marketplace.listings WHERE id = $1::uuid`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  /** Active memberships of a user (org-scope basis for leak-free listing). */
  async listActiveOrganizationIds(userId: string, executor: QueryExecutor = this.db): Promise<string[]> {
    const r = await executor.query<{ organization_id: string }>(
      `SELECT om.organization_id FROM org.organization_members om
        JOIN org.organizations o ON o.id = om.organization_id
       WHERE om.user_id = $1::uuid AND om.status = 'active' AND o.status = 'active'`,
      [userId],
    );
    return r.rows.map((row) => row.organization_id);
  }

  // ---------------------------------------------------------------- cases

  async createCase(input: {
    organizationId: string;
    propertyId: string;
    requestedByUserId: string;
    method?: string | null | undefined;
    modelVersion?: string | null | undefined;
    executor?: QueryExecutor | undefined;
  }): Promise<ValuationCaseRow> {
    const ex = input.executor ?? this.db;
    // Optional columns are only included when provided, so the frozen schema
    // DEFAULTs (status='requested', method='comparables') stay authoritative.
    const cols = ['property_id', 'requested_by_user_id', 'organization_id'];
    const params: unknown[] = [input.propertyId, input.requestedByUserId, input.organizationId];
    if (input.method != null) {
      params.push(input.method);
      cols.push('method');
    }
    if (input.modelVersion != null) {
      params.push(input.modelVersion);
      cols.push('model_version');
    }
    const placeholders = params.map((_, i) => `$${i + 1}${i < 3 ? '::uuid' : ''}`).join(', ');
    const r = await ex.query<ValuationCaseRow>(
      `INSERT INTO valuation.cases (${cols.join(', ')})
       VALUES (${placeholders})
       RETURNING ${CASE_COLS}`,
      params,
    );
    const row = r.rows[0];
    if (!row) throw new Error('VALUATION_CASE_INSERT_FAILED');
    return row;
  }

  async getCase(id: string, executor: QueryExecutor = this.db): Promise<ValuationCaseRow | null> {
    const r = await executor.query<ValuationCaseRow>(
      `SELECT ${CASE_COLS} FROM valuation.cases WHERE id = $1::uuid`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Organization-scoped listing. Exactly one access root must be provided:
   *   - organizationId            → cases of that one org (member pre-checked upstream)
   *   - memberOrganizationIds     → cases of the actor's active orgs UNION cases the
   *                                 actor personally requested (read-scope rule)
   *   - requestedByUserId (alone) → cases the actor personally requested
   * Cross-organization rows can never match any supported root.
   */
  async listCases(filter: {
    organizationId?: string | undefined;
    memberOrganizationIds?: string[] | undefined;
    requestedByUserId?: string | undefined;
    propertyId?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
  }): Promise<ValuationCaseRow[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    // Access root (exactly one, OR-ed internally) — a row is visible when it
    // matches the root; refiners (property/status) are AND-ed on top.
    let accessRoot: string | null = null;
    const params: unknown[] = [];
    if (filter.organizationId) {
      params.push(filter.organizationId);
      accessRoot = `organization_id = $${params.length}::uuid`;
    } else if (filter.memberOrganizationIds && filter.memberOrganizationIds.length > 0) {
      params.push(filter.memberOrganizationIds);
      const orgs = `organization_id = ANY($${params.length}::uuid[])`;
      params.push(filter.requestedByUserId ?? null);
      accessRoot = `(${orgs} OR requested_by_user_id = $${params.length}::uuid)`;
    } else if (filter.requestedByUserId) {
      params.push(filter.requestedByUserId);
      accessRoot = `requested_by_user_id = $${params.length}::uuid`;
    }
    if (!accessRoot) {
      // No access root → deterministic empty scope (never a full-table read).
      return [];
    }
    const where = [accessRoot];
    if (filter.propertyId) {
      params.push(filter.propertyId);
      where.push(`property_id = $${params.length}::uuid`);
    }
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}::valuation.valuation_status`);
    }
    params.push(limit);
    const r = await this.db.query<ValuationCaseRow>(
      `SELECT ${CASE_COLS} FROM valuation.cases
        WHERE ${where.join(' AND ')}
        ORDER BY requested_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  }

  async updateCaseMeta(input: {
    id: string;
    method?: string | null | undefined;
    modelVersion?: string | null | undefined;
    executor?: QueryExecutor | undefined;
  }): Promise<ValuationCaseRow | null> {
    const ex = input.executor ?? this.db;
    const r = await ex.query<ValuationCaseRow>(
      `UPDATE valuation.cases
          SET method = COALESCE($2::text, method),
              model_version = COALESCE($3::text, model_version)
        WHERE id = $1::uuid
        RETURNING ${CASE_COLS}`,
      [input.id, input.method ?? null, input.modelVersion ?? null],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Transition authority stays in the DB (0040 triggers); this only carries the payload.
   *
   * Milestone 2 — optimistic concurrency (CRM completeTask precedent): the UPDATE fires
   * only while the lifecycle state still equals the authorized pre-read
   * (expectedFromStatus). Under READ COMMITTED a concurrent transition that committed
   * first makes the row-level predicate re-check fail after the lock wait, so exactly
   * ONE finalizer wins; zero rows = this caller lost the race and maps that to the
   * established 409 conflict response (never a silent no-op, never duplicate effects).
   */
  async updateCaseStatus(input: {
    id: string;
    toStatus: string;
    expectedFromStatus: string;
    expiresAt?: Date | null | undefined;
    executor?: QueryExecutor | undefined;
  }): Promise<ValuationCaseRow | null> {
    const ex = input.executor ?? this.db;
    const r = await ex.query<ValuationCaseRow>(
      `UPDATE valuation.cases
          SET status = $2::valuation.valuation_status,
              expires_at = COALESCE($3::timestamptz, expires_at)
        WHERE id = $1::uuid AND status = $4::valuation.valuation_status
        RETURNING ${CASE_COLS}`,
      [input.id, input.toStatus, input.expiresAt ?? null, input.expectedFromStatus],
    );
    return r.rows[0] ?? null;
  }

  // ---------------------------------------------------------------- results (one per case)

  async getResultByCaseId(caseId: string, executor: QueryExecutor = this.db): Promise<ValuationResultRow | null> {
    const r = await executor.query<ValuationResultRow>(
      `SELECT ${RESULT_COLS} FROM valuation.results WHERE case_id = $1::uuid`,
      [caseId],
    );
    return r.rows[0] ?? null;
  }

  async upsertResult(input: {
    caseId: string;
    minValue: string;
    estimatedValue: string;
    maxValue: string;
    currencyCode: string;
    confidence?: string | null | undefined;
    pricePerM2?: string | null | undefined;
    executor?: QueryExecutor | undefined;
  }): Promise<ValuationResultRow> {
    const ex = input.executor ?? this.db;
    const r = await ex.query<ValuationResultRow>(
      `INSERT INTO valuation.results
         (case_id, min_value, estimated_value, max_value, currency_code, confidence, price_per_m2)
       VALUES ($1::uuid, $2, $3, $4, $5::char(3), $6, $7)
       ON CONFLICT (case_id) DO UPDATE SET
         min_value = EXCLUDED.min_value,
         estimated_value = EXCLUDED.estimated_value,
         max_value = EXCLUDED.max_value,
         currency_code = EXCLUDED.currency_code,
         confidence = EXCLUDED.confidence,
         price_per_m2 = EXCLUDED.price_per_m2
       RETURNING ${RESULT_COLS}`,
      [input.caseId, input.minValue, input.estimatedValue, input.maxValue, input.currencyCode, input.confidence ?? null, input.pricePerM2 ?? null],
    );
    const row = r.rows[0];
    if (!row) throw new Error('VALUATION_RESULT_UPSERT_FAILED');
    return row;
  }

  // ---------------------------------------------------------------- comparables (evidence)

  async listComparables(resultId: string, executor: QueryExecutor = this.db): Promise<ValuationComparableRow[]> {
    const r = await executor.query<ValuationComparableRow>(
      `SELECT ${COMPARABLE_COLS} FROM valuation.comparables
        WHERE valuation_result_id = $1::uuid
        ORDER BY comparable_property_id ASC`,
      [resultId],
    );
    return r.rows;
  }

  /**
   * Milestone 2 — reverse comparable traceability: "which valuation cases used
   * property X as a comparable?". Reads ONLY the frozen schema through the
   * comparables → results → cases join path (one result per case, comparables PK
   * (valuation_result_id, comparable_property_id) ⇒ at most one row per case, no
   * DISTINCT needed); the equality on comparable_property_id is served by the 0040
   * G7 traceability index idx_valuation_comparables_property. No new data model,
   * no migration.
   *
   * Access-root discipline is identical to listCases — exactly one supported root
   * (organizationId | memberOrganizationIds(+requester) | requestedByUserId); without
   * a root the answer is a deterministic empty scope. The comparable property itself
   * never grants read access, so cross-organization evidence cannot leak.
   */
  async listCasesUsingComparable(filter: {
    comparablePropertyId: string;
    organizationId?: string | undefined;
    memberOrganizationIds?: string[] | undefined;
    requestedByUserId?: string | undefined;
    limit?: number | undefined;
  }): Promise<ValuationComparableUsageRow[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    let accessRoot: string | null = null;
    const params: unknown[] = [filter.comparablePropertyId];
    if (filter.organizationId) {
      params.push(filter.organizationId);
      accessRoot = `cs.organization_id = $${params.length}::uuid`;
    } else if (filter.memberOrganizationIds && filter.memberOrganizationIds.length > 0) {
      params.push(filter.memberOrganizationIds);
      const orgs = `cs.organization_id = ANY($${params.length}::uuid[])`;
      params.push(filter.requestedByUserId ?? null);
      accessRoot = `(${orgs} OR cs.requested_by_user_id = $${params.length}::uuid)`;
    } else if (filter.requestedByUserId) {
      params.push(filter.requestedByUserId);
      accessRoot = `cs.requested_by_user_id = $${params.length}::uuid`;
    }
    if (!accessRoot) {
      // No access root → deterministic empty scope (never a full-table read).
      return [];
    }
    params.push(limit);
    const r = await this.db.query<ValuationComparableUsageRow>(
      `SELECT cs.id, cs.property_id, cs.requested_by_user_id, cs.status::text AS status, cs.method,
              cs.model_version, cs.organization_id, cs.requested_at, cs.completed_at, cs.expires_at, cs.updated_at,
              c.valuation_result_id AS usage_result_id, c.similarity_score AS usage_similarity_score,
              c.distance_m AS usage_distance_m, c.adjusted_price AS usage_adjusted_price,
              c.currency_code AS usage_currency_code
         FROM valuation.comparables c
         JOIN valuation.results r ON r.id = c.valuation_result_id
         JOIN valuation.cases cs ON cs.id = r.case_id
        WHERE c.comparable_property_id = $1::uuid AND ${accessRoot}
        ORDER BY cs.requested_at DESC, cs.id ASC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  }

  /**
   * currency_code is written explicitly from the ONLY deterministic source —
   * the parent result (0040 G6). The DB trigger re-validates it; no conversion,
   * no FX logic anywhere.
   */
  async addComparable(input: {
    resultId: string;
    comparablePropertyId: string;
    comparableListingId?: string | null | undefined;
    currencyCode: string;
    similarityScore?: string | null | undefined;
    distanceM?: string | null | undefined;
    adjustedPrice?: string | null | undefined;
    executor?: QueryExecutor | undefined;
  }): Promise<ValuationComparableRow> {
    const ex = input.executor ?? this.db;
    const r = await ex.query<ValuationComparableRow>(
      `INSERT INTO valuation.comparables
         (valuation_result_id, comparable_property_id, comparable_listing_id, currency_code,
          similarity_score, distance_m, adjusted_price)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::char(3), $5, $6, $7)
       ON CONFLICT (valuation_result_id, comparable_property_id) DO UPDATE SET
         comparable_listing_id = EXCLUDED.comparable_listing_id,
         currency_code = EXCLUDED.currency_code,
         similarity_score = EXCLUDED.similarity_score,
         distance_m = EXCLUDED.distance_m,
         adjusted_price = EXCLUDED.adjusted_price
       RETURNING ${COMPARABLE_COLS}`,
      [input.resultId, input.comparablePropertyId, input.comparableListingId ?? null, input.currencyCode, input.similarityScore ?? null, input.distanceM ?? null, input.adjustedPrice ?? null],
    );
    const row = r.rows[0];
    if (!row) throw new Error('VALUATION_COMPARABLE_INSERT_FAILED');
    return row;
  }
}
