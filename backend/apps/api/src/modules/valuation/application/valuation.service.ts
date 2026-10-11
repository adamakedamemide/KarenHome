import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AuditRepository, IamRepository, OutboxRepository, PostgresDatabase, ValuationRepository, type ValuationCaseRow, type ValuationComparableRow, type ValuationResultRow } from '@platform/db';
import type { AuthenticatedUser } from '@platform/contracts';

/**
 * Gate 5.1 Phase E — Valuation domain service (Milestone 1: application layer).
 *
 * Layering (per Gate 5.1 governance — each invariant owned by ONE authoritative
 * layer, never by application code alone):
 *   DB trigger (0040)   → status vocabulary + allowed transitions + insert guard +
 *                         completed_at/expires_at consistency + finalized-result
 *                         immutability (results + comparables) + comparable currency
 *   DB constraint       → numeric(20,4) exact money, range CHECKs, FKs (RESTRICT)
 *   Service rule        → friendly pre-checks (404/403/422) before the DB
 *                         round-trip; DB error codes mapped to domain error codes
 *   Authorization rule  → valuation.view / valuation.create / valuation.update /
 *                         valuation.finalize (+ valuation.manage implies all),
 *                         org-scoped, exact 0040 seed vocabulary
 *   Organization scoping → binding-org members only for mutations; reads for
 *                         binding-org members + the original requester; out-of-scope
 *                         access = 404 (no existence leak)
 *   Events               → exactly the registered catalogue (design review §10):
 *                         ValuationRequested.v1 / ValuationCompleted.v1 /
 *                         ValuationFailed.v1 — written in the SAME transaction as
 *                         the mutation (transactional outbox, errata 0026 infra)
 *   Audit trail          → audit.logs rows for create / update / transition /
 *                         finalize / result / comparables with before/after jsonb
 *
 * Versioning/snapshot foundation (design review §4): one case per valuation;
 * a sealed (completed/expired) case is never mutated; revaluation = a NEW case
 * for the same property (history endpoint), preserving the full chain.
 *
 * Scope lock: no valuation formulas, no coefficients, no business percentages,
 * no FX rules, no IRR (TBD), no invented parameters. Money is exact decimal
 * end-to-end: numeric strings in, numeric(20,4) in the DB, numeric strings out.
 */

const CASE_STATUSES = ['requested', 'processing', 'completed', 'failed', 'expired'] as const;

type ValuationPermission = 'valuation.view' | 'valuation.create' | 'valuation.update' | 'valuation.finalize';

const isSealed = (status: string): boolean => status === 'completed' || status === 'expired';

@Injectable()
export class ValuationService {
  constructor(
    private readonly valuations: ValuationRepository,
    private readonly outbox: OutboxRepository,
    private readonly audit: AuditRepository,
    private readonly iam: IamRepository,
    private readonly db: PostgresDatabase,
  ) {}

  // ---------------------------------------------------------------- authorization

  private async requirePermission(actor: AuthenticatedUser, permission: ValuationPermission, organizationId?: string): Promise<void> {
    const permissions = await this.iam.listPermissionCodesForUser(actor.id, organizationId);
    const accepted = permissions.includes(permission) || permissions.includes('valuation.manage');
    if (!accepted) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: `Required permission is missing: ${permission}` });
    }
  }

  /** Mutations are binding-org-only; out-of-org access = 404 (no existence leak). */
  private async requireCaseMutationAccess(caseRow: ValuationCaseRow, actor: AuthenticatedUser, permission: ValuationPermission): Promise<void> {
    const member = await this.iam.isActiveOrganizationMember(actor.id, caseRow.organization_id);
    if (!member) {
      throw new NotFoundException({ code: 'VALUATION_CASE_NOT_FOUND', message: 'Valuation case not found' });
    }
    await this.requirePermission(actor, permission, caseRow.organization_id);
  }

  /** Read scope = binding-org members + the original requester (design review §1). */
  private async requireCaseReadAccess(caseRow: ValuationCaseRow, actor: AuthenticatedUser): Promise<void> {
    if (caseRow.requested_by_user_id === actor.id) {
      await this.requirePermission(actor, 'valuation.view');
      return;
    }
    const member = await this.iam.isActiveOrganizationMember(actor.id, caseRow.organization_id);
    if (!member) {
      throw new NotFoundException({ code: 'VALUATION_CASE_NOT_FOUND', message: 'Valuation case not found' });
    }
    await this.requirePermission(actor, 'valuation.view', caseRow.organization_id);
  }

  private static assertNotSealed(caseRow: ValuationCaseRow): void {
    if (isSealed(caseRow.status)) {
      throw new UnprocessableEntityException({
        code: 'VALUATION_CASE_SEALED',
        message: `case is ${caseRow.status}; finalized valuation results are immutable — revaluation requires a new case`,
      });
    }
  }

  // ---------------------------------------------------------------- creation / retrieval

  async createCase(input: {
    organizationId: string;
    propertyId: string;
    method?: string | undefined;
    modelVersion?: string | undefined;
  }, actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    await this.requirePermission(actor, 'valuation.create', input.organizationId);
    const member = await this.iam.isActiveOrganizationMember(actor.id, input.organizationId);
    if (!member) throw new NotFoundException({ code: 'ORG_NOT_FOUND', message: 'Organization not found' });
    const property = await this.valuations.getProperty(input.propertyId);
    if (!property) throw new NotFoundException({ code: 'PROPERTY_NOT_FOUND', message: 'Property not found' });

    const created = await this.db.transaction(async (client) => {
      const row = await this.valuations.createCase({
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        requestedByUserId: actor.id,
        method: input.method,
        modelVersion: input.modelVersion,
        executor: client,
      });
      await this.outbox.append({
        aggregateType: 'valuation_case', aggregateId: row.id, eventType: 'ValuationRequested.v1', eventVersion: 1,
        payload: {
          caseId: row.id, propertyId: row.property_id, organizationId: row.organization_id,
          method: row.method, requestedByUserId: row.requested_by_user_id, requestedAt: row.requested_at,
          actorUserId: actor.id,
        },
      }, client);
      await this.audit.append({
        actorUserId: actor.id, organizationId: row.organization_id,
        action: 'valuation.case_created', entityType: 'valuation.case', entityId: row.id,
        afterData: { propertyId: row.property_id, method: row.method, modelVersion: row.model_version, status: row.status },
      }, client);
      return row;
    }, { actorUserId: actor.id });
    return this.toCaseApi(created);
  }

  async getCase(caseId: string, actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    const caseRow = await this.getCaseRowOrNotFound(caseId);
    await this.requireCaseReadAccess(caseRow, actor);
    const result = await this.valuations.getResultByCaseId(caseRow.id);
    const comparables = result ? await this.valuations.listComparables(result.id) : [];
    return {
      ...this.toCaseApi(caseRow),
      result: result ? this.toResultApi(result) : null,
      comparables: comparables.map((c) => this.toComparableApi(c)),
    };
  }

  async listCases(actor: AuthenticatedUser, filter: {
    organizationId?: string | undefined;
    propertyId?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
  } = {}): Promise<Array<Record<string, unknown>>> {
    if (filter.organizationId) {
      const member = await this.iam.isActiveOrganizationMember(actor.id, filter.organizationId);
      if (!member) throw new NotFoundException({ code: 'ORG_NOT_FOUND', message: 'Organization not found' });
      await this.requirePermission(actor, 'valuation.view', filter.organizationId);
      const rows = await this.valuations.listCases({
        organizationId: filter.organizationId, propertyId: filter.propertyId,
        status: filter.status, limit: filter.limit,
      });
      return rows.map((c) => this.toCaseApi(c));
    }
    await this.requirePermission(actor, 'valuation.view');
    const memberOrganizationIds = await this.valuations.listActiveOrganizationIds(actor.id);
    const rows = await this.valuations.listCases({
      memberOrganizationIds, requestedByUserId: actor.id,
      propertyId: filter.propertyId, status: filter.status, limit: filter.limit,
    });
    return rows.map((c) => this.toCaseApi(c));
  }

  /** Version-chain surface: every case ever requested for a property, newest first. */
  async listPropertyCaseHistory(propertyId: string, actor: AuthenticatedUser, filter: {
    organizationId?: string | undefined;
    limit?: number | undefined;
  } = {}): Promise<Array<Record<string, unknown>>> {
    return this.listCases(actor, { ...filter, propertyId });
  }

  // ---------------------------------------------------------------- case updates

  async updateCaseMeta(caseId: string, input: {
    method?: string | undefined;
    modelVersion?: string | undefined;
  }, actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    const caseRow = await this.getCaseRowOrNotFound(caseId);
    await this.requireCaseMutationAccess(caseRow, actor, 'valuation.update');
    ValuationService.assertNotSealed(caseRow);
    if (input.method === undefined && input.modelVersion === undefined) {
      throw new UnprocessableEntityException({ code: 'VALUATION_NO_CHANGES', message: 'at least one of method or modelVersion is required' });
    }
    const updated = await this.db.transaction(async (client) => {
      const row = await this.valuations.updateCaseMeta({
        id: caseRow.id, method: input.method, modelVersion: input.modelVersion, executor: client,
      });
      if (!row) throw new NotFoundException({ code: 'VALUATION_CASE_NOT_FOUND', message: 'Valuation case not found' });
      await this.audit.append({
        actorUserId: actor.id, organizationId: row.organization_id,
        action: 'valuation.case_updated', entityType: 'valuation.case', entityId: row.id,
        beforeData: { method: caseRow.method, modelVersion: caseRow.model_version },
        afterData: { method: row.method, modelVersion: row.model_version },
      }, client);
      return row;
    }, { actorUserId: actor.id });
    return this.toCaseApi(updated);
  }

  // ---------------------------------------------------------------- lifecycle transitions

  async changeCaseStatus(caseId: string, toStatus: string, actor: AuthenticatedUser, input: {
    reason?: string | undefined;
    expiresAt?: string | undefined;
  } = {}): Promise<Record<string, unknown>> {
    if (!(CASE_STATUSES as readonly string[]).includes(toStatus)) {
      throw new UnprocessableEntityException({ code: 'VALUATION_UNKNOWN_STATUS', message: `valuation status '${toStatus}' is not registered` });
    }
    if (toStatus === 'requested') {
      throw new UnprocessableEntityException({ code: 'VALUATION_INVALID_TRANSITION', message: 'cases are created as requested; there is no transition back to requested' });
    }
    const caseRow = await this.getCaseRowOrNotFound(caseId);
    if (toStatus === caseRow.status) {
      throw new UnprocessableEntityException({ code: 'VALUATION_NO_OP_TRANSITION', message: `case is already ${toStatus}` });
    }
    // Permission by target (0040 G8 vocabulary; valuation.manage implies all):
    //   processing/failed → valuation.update
    //   completed/expired → valuation.finalize (system/worker authority)
    const permission: ValuationPermission = (toStatus === 'completed' || toStatus === 'expired')
      ? 'valuation.finalize'
      : 'valuation.update';
    await this.requireCaseMutationAccess(caseRow, actor, permission);

    // G5: expires_at is meaningful only for completed/expired snapshots.
    let expiresAt: Date | null = null;
    if (input.expiresAt !== undefined) {
      if (toStatus !== 'completed' && toStatus !== 'expired') {
        throw new UnprocessableEntityException({ code: 'VALUATION_EXPIRES_AT_INVALID', message: 'expiresAt is only allowed when completing or expiring a case' });
      }
      expiresAt = new Date(input.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        throw new UnprocessableEntityException({ code: 'VALUATION_EXPIRES_AT_INVALID', message: 'expiresAt is not a valid timestamp' });
      }
    }

    const updated = await this.db.transaction(async (client) => {
      let row: ValuationCaseRow | null;
      try {
        row = await this.valuations.updateCaseStatus({
          id: caseRow.id, toStatus, expiresAt, executor: client,
        });
      } catch (error) {
        throw ValuationService.mapCaseError(error);
      }
      if (!row) throw new NotFoundException({ code: 'VALUATION_CASE_NOT_FOUND', message: 'Valuation case not found' });
      // Registered event catalogue (design review §10) — same transaction.
      if (toStatus === 'completed') {
        const result = await this.valuations.getResultByCaseId(caseRow.id, client);
        await this.outbox.append({
          aggregateType: 'valuation_case', aggregateId: row.id, eventType: 'ValuationCompleted.v1', eventVersion: 1,
          payload: {
            caseId: row.id, propertyId: row.property_id, organizationId: row.organization_id,
            resultId: result?.id ?? null,
            minValue: result?.min_value ?? null, estimatedValue: result?.estimated_value ?? null,
            maxValue: result?.max_value ?? null, currencyCode: result?.currency_code ?? null,
            expiresAt: row.expires_at, actorUserId: actor.id, completedAt: row.completed_at,
          },
        }, client);
      }
      if (toStatus === 'failed') {
        await this.outbox.append({
          aggregateType: 'valuation_case', aggregateId: row.id, eventType: 'ValuationFailed.v1', eventVersion: 1,
          payload: {
            caseId: row.id, propertyId: row.property_id, organizationId: row.organization_id,
            fromStatus: caseRow.status, reason: input.reason ?? null, actorUserId: actor.id,
          },
        }, client);
      }
      await this.audit.append({
        actorUserId: actor.id, organizationId: row.organization_id,
        action: 'valuation.case_status_changed', entityType: 'valuation.case', entityId: row.id,
        beforeData: { status: caseRow.status },
        afterData: { status: row.status, reason: input.reason ?? null, expiresAt: row.expires_at },
      }, client);
      return row;
    }, { actorUserId: actor.id, statusChangeReason: input.reason });
    return this.toCaseApi(updated);
  }

  // ---------------------------------------------------------------- results (exact decimal, one per case)

  async recordResult(caseId: string, input: {
    minValue: string;
    estimatedValue: string;
    maxValue: string;
    currencyCode: string;
    confidence?: string | undefined;
    pricePerM2?: string | undefined;
  }, actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    const caseRow = await this.getCaseRowOrNotFound(caseId);
    await this.requireCaseMutationAccess(caseRow, actor, 'valuation.update');
    ValuationService.assertNotSealed(caseRow);
    const previous = await this.valuations.getResultByCaseId(caseRow.id);
    const result = await this.db.transaction(async (client) => {
      let row: ValuationResultRow;
      try {
        row = await this.valuations.upsertResult({
          caseId: caseRow.id,
          minValue: input.minValue, estimatedValue: input.estimatedValue, maxValue: input.maxValue,
          currencyCode: input.currencyCode, confidence: input.confidence, pricePerM2: input.pricePerM2,
          executor: client,
        });
      } catch (error) {
        throw ValuationService.mapResultError(error);
      }
      await this.audit.append({
        actorUserId: actor.id, organizationId: caseRow.organization_id,
        action: 'valuation.result_recorded', entityType: 'valuation.result', entityId: row.id,
        beforeData: previous
          ? { minValue: previous.min_value, estimatedValue: previous.estimated_value, maxValue: previous.max_value, currencyCode: previous.currency_code, confidence: previous.confidence, pricePerM2: previous.price_per_m2 }
          : null,
        afterData: { caseId: caseRow.id, minValue: row.min_value, estimatedValue: row.estimated_value, maxValue: row.max_value, currencyCode: row.currency_code, confidence: row.confidence, pricePerM2: row.price_per_m2 },
      }, client);
      return row;
    }, { actorUserId: actor.id });
    return this.toResultApi(result);
  }

  // ---------------------------------------------------------------- comparables (evidence + traceability)

  async addComparables(caseId: string, items: Array<{
    comparablePropertyId: string;
    comparableListingId?: string | undefined;
    similarityScore?: string | undefined;
    distanceM?: string | undefined;
    adjustedPrice?: string | undefined;
  }>, actor: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
    const caseRow = await this.getCaseRowOrNotFound(caseId);
    await this.requireCaseMutationAccess(caseRow, actor, 'valuation.update');
    ValuationService.assertNotSealed(caseRow);
    const result = await this.valuations.getResultByCaseId(caseRow.id);
    if (!result) {
      throw new UnprocessableEntityException({ code: 'VALUATION_RESULT_REQUIRED', message: 'a valuation result must exist before comparables can be attached' });
    }
    for (const item of items) {
      const property = await this.valuations.getProperty(item.comparablePropertyId);
      if (!property) {
        throw new UnprocessableEntityException({ code: 'VALUATION_COMPARABLE_PROPERTY_INVALID', message: `comparable property ${item.comparablePropertyId} does not exist` });
      }
      if (item.comparableListingId) {
        const listing = await this.valuations.getListing(item.comparableListingId);
        if (!listing) {
          throw new UnprocessableEntityException({ code: 'VALUATION_COMPARABLE_LISTING_INVALID', message: `comparable listing ${item.comparableListingId} does not exist` });
        }
      }
    }
    return this.db.transaction(async (client) => {
      for (const item of items) {
        // currency is inherited deterministically from the parent result (G6).
        try {
          await this.valuations.addComparable({
            resultId: result.id,
            comparablePropertyId: item.comparablePropertyId,
            comparableListingId: item.comparableListingId,
            currencyCode: result.currency_code,
            similarityScore: item.similarityScore,
            distanceM: item.distanceM,
            adjustedPrice: item.adjustedPrice,
            executor: client,
          });
        } catch (error) {
          throw ValuationService.mapResultError(error);
        }
      }
      await this.audit.append({
        actorUserId: actor.id, organizationId: caseRow.organization_id,
        action: 'valuation.comparables_added', entityType: 'valuation.result', entityId: result.id,
        afterData: {
          caseId: caseRow.id, count: items.length,
          items: items.map((i) => ({ comparablePropertyId: i.comparablePropertyId, comparableListingId: i.comparableListingId ?? null })),
        },
      }, client);
      const rows = await this.valuations.listComparables(result.id, client);
      return rows.map((c) => this.toComparableApi(c));
    }, { actorUserId: actor.id });
  }

  // ---------------------------------------------------------------- error mapping

  /** DB is the transition/status authority (0040) — its violations surface as 422. */
  private static mapCaseError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('VALUATION_INVALID_TRANSITION')) {
      return new UnprocessableEntityException({ code: 'VALUATION_INVALID_TRANSITION', message: 'transition is not allowed by the lifecycle authority' });
    }
    if (message.includes('VALUATION_UNKNOWN_STATUS')) {
      return new UnprocessableEntityException({ code: 'VALUATION_UNKNOWN_STATUS', message: 'status is not a registered valuation status' });
    }
    if (message.includes('VALUATION_EXPIRES_AT_INVALID')) {
      return new UnprocessableEntityException({ code: 'VALUATION_EXPIRES_AT_INVALID', message: 'expires_at is not allowed for this status' });
    }
    if (message.includes('VALUATION_COMPLETED_AT_INVALID')) {
      return new UnprocessableEntityException({ code: 'VALUATION_COMPLETED_AT_INVALID', message: 'completed_at consistency rule violated' });
    }
    if (message.includes('VALUATION_RESULT_IMMUTABLE') || message.includes('VALUATION_COMPARABLE_IMMUTABLE')) {
      return new UnprocessableEntityException({ code: 'VALUATION_CASE_SEALED', message: 'finalized valuation results are immutable — revaluation requires a new case' });
    }
    return error as Error;
  }

  private static mapResultError(error: unknown): Error {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === '23514') {
      return new UnprocessableEntityException({ code: 'VALUATION_RESULT_RANGE_INVALID', message: 'result values violate the valuation range constraints (0 <= min <= estimated <= max, confidence 0..100, price_per_m2 >= 0)' });
    }
    if (code === '23503') {
      return new UnprocessableEntityException({ code: 'VALUATION_CURRENCY_UNKNOWN', message: 'currencyCode is not a registered currency' });
    }
    if (message.includes('VALUATION_RESULT_IMMUTABLE') || message.includes('VALUATION_COMPARABLE_IMMUTABLE')) {
      return new UnprocessableEntityException({ code: 'VALUATION_CASE_SEALED', message: 'finalized valuation results are immutable — revaluation requires a new case' });
    }
    if (message.includes('VALUATION_CURRENCY_MISMATCH')) {
      return new UnprocessableEntityException({ code: 'VALUATION_CURRENCY_MISMATCH', message: 'comparable currency must match the parent result currency' });
    }
    return error as Error;
  }

  // ---------------------------------------------------------------- shared helpers

  private async getCaseRowOrNotFound(caseId: string): Promise<ValuationCaseRow> {
    const caseRow = await this.valuations.getCase(caseId);
    if (!caseRow) throw new NotFoundException({ code: 'VALUATION_CASE_NOT_FOUND', message: 'Valuation case not found' });
    return caseRow;
  }

  // ---------------------------------------------------------------- api shaping (numeric → string, untouched)

  private toCaseApi(c: ValuationCaseRow): Record<string, unknown> {
    return {
      id: c.id, propertyId: c.property_id, organizationId: c.organization_id,
      requestedByUserId: c.requested_by_user_id, status: c.status, method: c.method,
      modelVersion: c.model_version, requestedAt: c.requested_at,
      completedAt: c.completed_at, expiresAt: c.expires_at, updatedAt: c.updated_at,
    };
  }

  private toResultApi(r: ValuationResultRow): Record<string, unknown> {
    return {
      id: r.id, caseId: r.case_id,
      minValue: r.min_value, estimatedValue: r.estimated_value, maxValue: r.max_value,
      currencyCode: r.currency_code, confidence: r.confidence, pricePerM2: r.price_per_m2,
      generatedAt: r.generated_at,
    };
  }

  private toComparableApi(c: ValuationComparableRow): Record<string, unknown> {
    return {
      comparablePropertyId: c.comparable_property_id, comparableListingId: c.comparable_listing_id,
      similarityScore: c.similarity_score, distanceM: c.distance_m, adjustedPrice: c.adjusted_price,
      currencyCode: c.currency_code,
    };
  }

  // exposed for controller DTOs / OpenAPI documentation
  static readonly allowedCaseStatuses = CASE_STATUSES;
}
