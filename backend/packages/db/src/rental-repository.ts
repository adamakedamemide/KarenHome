import { PostgresDatabase, type QueryExecutor } from './postgres-database';

/**
 * Gate P — Rental domain repository (Milestone 1: lease foundation).
 *
 * Frozen tables (base 0018_rental — the authority, UNMODIFIED):
 *   rental.leases          — property-anchored lease; landlord is user XOR org and
 *                            tenant is user XOR org (DB CHECKs); status vocabulary is
 *                            the frozen enum rental.lease_status; numeric(20,4) exact
 *                            money; date columns selected as ::text (exact YYYY-MM-DD,
 *                            never a TZ-sensitive JS Date); `leases_no_overlap`
 *                            EXCLUDE USING gist (property_id =, daterange '[)') &&
 *                            WHERE status IN ('pending_signature','active') is the
 *                            CONCURRENCY-SAFE overlap authority.
 *   rental.lease_parties   — role rows with canonical identity (user XOR org) and
 *                            name/contact snapshots.
 *   rental.rent_schedules  — per-lease due dates with exact decimal amounts and an
 *                            explicit currency FK; UNIQUE (lease_id, due_date).
 *   rental.rent_payments   — Milestone 2 writes confirmed receipts here through
 *                            the methods below (record + reconcile in ONE
 *                            transaction). The frozen RESTRICT FK guards
 *                            schedule deletes; the 0042 unique partial index
 *                            ux_rent_payments_external_payment is the
 *                            concurrency-safe idempotency authority for
 *                            external billing payment references.
 *
 * Money/decimal columns are NEVER converted through JS numbers: pg returns
 * numeric as string and this repository keeps them strings end-to-end.
 * No lifecycle transition trigger exists in the frozen schema — the transition
 * matrix is application-owned (service layer); the DB stays authoritative for
 * vocabulary, party/tenant XOR, date order and overlap.
 */

export interface RentalLeaseRow {
  id: string;
  property_id: string;
  source_listing_id: string | null;
  contract_id: string | null;
  landlord_user_id: string | null;
  landlord_organization_id: string | null;
  tenant_user_id: string | null;
  tenant_organization_id: string | null;
  status: string;
  currency_code: string;
  monthly_rent: string;
  deposit_amount: string | null;
  start_date: string;
  end_date: string;
  auto_renew: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface RentalLeasePartyRow {
  id: string;
  lease_id: string;
  role: string;
  user_id: string | null;
  organization_id: string | null;
  name_snapshot: string;
  contact_snapshot: Record<string, unknown>;
}

export interface RentScheduleRow {
  id: string;
  lease_id: string;
  due_date: string;
  amount: string;
  currency_code: string;
  status: string;
  paid_at: Date | null;
}

export interface RentPaymentRow {
  id: string;
  schedule_id: string;
  amount: string;
  currency_code: string;
  external_payment_id: string | null;
  paid_at: Date | null;
  created_at: Date;
}

const LEASE_COLS = `id, property_id, source_listing_id, contract_id, landlord_user_id, landlord_organization_id,
  tenant_user_id, tenant_organization_id, status::text AS status, currency_code, monthly_rent, deposit_amount,
  start_date::text AS start_date, end_date::text AS end_date, auto_renew, created_at, updated_at`;

const PARTY_COLS = `id, lease_id, role, user_id, organization_id, name_snapshot, contact_snapshot`;

const SCHEDULE_COLS = `id, lease_id, due_date::text AS due_date, amount, currency_code, status::text AS status, paid_at`;

export class RentalRepository {
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

  async getContract(id: string, executor: QueryExecutor = this.db): Promise<{ id: string } | null> {
    const r = await executor.query<{ id: string }>(
      `SELECT id FROM legal.contracts WHERE id = $1::uuid`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async getUser(id: string, executor: QueryExecutor = this.db): Promise<{ id: string } | null> {
    const r = await executor.query<{ id: string }>(
      `SELECT id FROM iam.users WHERE id = $1::uuid`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async getOrganization(id: string, executor: QueryExecutor = this.db): Promise<{ id: string } | null> {
    const r = await executor.query<{ id: string }>(
      `SELECT id FROM org.organizations WHERE id = $1::uuid`,
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

  // ---------------------------------------------------------------- leases

  /**
   * Milestone 1 creation is organization-bound: the caller passes the landlord
   * organization (canonical identity/organization model); the frozen XOR CHECK
   * keeps landlord_user_id NULL. Tenant side is user XOR org exactly as the
   * frozen CHECK requires. Optional columns are only included when provided, so
   * the frozen DEFAULTs (status='draft', auto_renew=false) stay authoritative.
   */
  async createLease(input: {
    propertyId: string;
    landlordOrganizationId: string;
    tenantUserId?: string | null | undefined;
    tenantOrganizationId?: string | null | undefined;
    currencyCode: string;
    monthlyRent: string;
    depositAmount?: string | null | undefined;
    startDate: string;
    endDate: string;
    autoRenew?: boolean | null | undefined;
    sourceListingId?: string | null | undefined;
    contractId?: string | null | undefined;
    executor?: QueryExecutor | undefined;
  }): Promise<RentalLeaseRow> {
    const ex = input.executor ?? this.db;
    const cols = ['property_id', 'landlord_organization_id', 'currency_code', 'monthly_rent', 'start_date', 'end_date'];
    const casts = ['::uuid', '::uuid', '::char(3)', '::numeric', '::date', '::date'];
    const params: unknown[] = [
      input.propertyId, input.landlordOrganizationId, input.currencyCode,
      input.monthlyRent, input.startDate, input.endDate,
    ];
    if (input.tenantUserId) {
      params.push(input.tenantUserId);
      cols.push('tenant_user_id');
      casts.push('::uuid');
    }
    if (input.tenantOrganizationId) {
      params.push(input.tenantOrganizationId);
      cols.push('tenant_organization_id');
      casts.push('::uuid');
    }
    if (input.depositAmount != null) {
      params.push(input.depositAmount);
      cols.push('deposit_amount');
      casts.push('::numeric');
    }
    if (input.autoRenew != null) {
      params.push(input.autoRenew);
      cols.push('auto_renew');
      casts.push('::boolean');
    }
    if (input.sourceListingId != null) {
      params.push(input.sourceListingId);
      cols.push('source_listing_id');
      casts.push('::uuid');
    }
    if (input.contractId != null) {
      params.push(input.contractId);
      cols.push('contract_id');
      casts.push('::uuid');
    }
    const placeholders = params.map((_, i) => `$${i + 1}${casts[i]}`).join(', ');
    const r = await ex.query<RentalLeaseRow>(
      `INSERT INTO rental.leases (${cols.join(', ')})
       VALUES (${placeholders})
       RETURNING ${LEASE_COLS}`,
      params,
    );
    const row = r.rows[0];
    if (!row) throw new Error('LEASE_INSERT_FAILED');
    return row;
  }

  async getLease(id: string, executor: QueryExecutor = this.db): Promise<RentalLeaseRow | null> {
    const r = await executor.query<RentalLeaseRow>(
      `SELECT ${LEASE_COLS} FROM rental.leases WHERE id = $1::uuid`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Organization-scoped listing. Exactly one access root must be provided:
   *   - organizationId        → leases where that org is the LANDLORD org
   *                             (member pre-checked upstream)
   *   - memberOrganizationIds → leases of the actor's active landlord orgs
   * Cross-organization rows can never match any supported root. A lease without
   * a landlord organization (bare landlord user — the frozen schema allows it)
   * is outside the Milestone 1 organization-scoped API surface by design.
   */
  async listLeases(filter: {
    organizationId?: string | undefined;
    memberOrganizationIds?: string[] | undefined;
    propertyId?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
  }): Promise<RentalLeaseRow[]> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    let accessRoot: string | null = null;
    const params: unknown[] = [];
    if (filter.organizationId) {
      params.push(filter.organizationId);
      accessRoot = `landlord_organization_id = $${params.length}::uuid`;
    } else if (filter.memberOrganizationIds && filter.memberOrganizationIds.length > 0) {
      params.push(filter.memberOrganizationIds);
      accessRoot = `landlord_organization_id = ANY($${params.length}::uuid[])`;
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
      where.push(`status = $${params.length}::rental.lease_status`);
    }
    params.push(limit);
    const r = await this.db.query<RentalLeaseRow>(
      `SELECT ${LEASE_COLS} FROM rental.leases
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id ASC
        LIMIT $${params.length}`,
      params,
    );
    return r.rows;
  }

  /**
   * Permitted-field update with a mutability guard IN the statement: the row is
   * only written while it is still pre-commencement (draft | pending_signature).
   * Under READ COMMITTED, a concurrent lifecycle move that committed first makes
   * the row-level predicate re-check fail after the lock wait → 0 rows → the
   * caller maps that to a 409 (never a silent no-op). Only provided fields are
   * written; omitted columns keep their values.
   */
  async updateLeaseMeta(input: {
    id: string;
    monthlyRent?: string | null | undefined;
    depositAmount?: string | null | undefined;
    depositAmountProvided?: boolean | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
    autoRenew?: boolean | undefined;
    sourceListingId?: string | null | undefined;
    sourceListingIdProvided?: boolean | undefined;
    contractId?: string | null | undefined;
    contractIdProvided?: boolean | undefined;
    executor?: QueryExecutor | undefined;
  }): Promise<RentalLeaseRow | null> {
    const ex = input.executor ?? this.db;
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [input.id];
    const set = (expr: string, value: unknown, cast: string): void => {
      params.push(value);
      sets.push(`${expr} = $${params.length}${cast}`);
    };
    if (input.monthlyRent !== undefined) set('monthly_rent', input.monthlyRent, '::numeric');
    if (input.depositAmountProvided) set('deposit_amount', input.depositAmount ?? null, '::numeric');
    if (input.startDate !== undefined) set('start_date', input.startDate, '::date');
    if (input.endDate !== undefined) set('end_date', input.endDate, '::date');
    if (input.autoRenew !== undefined) set('auto_renew', input.autoRenew, '::boolean');
    if (input.sourceListingIdProvided) set('source_listing_id', input.sourceListingId ?? null, '::uuid');
    if (input.contractIdProvided) set('contract_id', input.contractId ?? null, '::uuid');
    const r = await ex.query<RentalLeaseRow>(
      `UPDATE rental.leases
          SET ${sets.join(', ')}
        WHERE id = $1::uuid AND status IN ('draft', 'pending_signature')
        RETURNING ${LEASE_COLS}`,
      params,
    );
    return r.rows[0] ?? null;
  }

  /**
   * Lifecycle transition with the CRM completeTask-style optimistic CAS guard:
   * the UPDATE fires only while the lifecycle state still equals the authorized
   * pre-read (expectedFromStatus). Under READ COMMITTED a concurrent transition
   * that committed first makes the row-level predicate re-check fail after the
   * lock wait → 0 rows = this caller lost the race (never a silent no-op).
   * Transition legality is application-owned (no frozen trigger); the DB stays
   * authority for vocabulary (enum) and overlap (leases_no_overlap fires when
   * the target is pending_signature/active — mapped upstream to a 409).
   */
  async updateLeaseStatus(input: {
    id: string;
    toStatus: string;
    expectedFromStatus: string;
    executor?: QueryExecutor | undefined;
  }): Promise<RentalLeaseRow | null> {
    const ex = input.executor ?? this.db;
    const r = await ex.query<RentalLeaseRow>(
      `UPDATE rental.leases
          SET status = $2::rental.lease_status, updated_at = now()
        WHERE id = $1::uuid AND status = $3::rental.lease_status
        RETURNING ${LEASE_COLS}`,
      [input.id, input.toStatus, input.expectedFromStatus],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Diagnostic preflight ONLY — the `leases_no_overlap` exclusion constraint is
   * the concurrency-safe authority; this read can never substitute it.
   */
  async listOverlappingLeases(input: {
    propertyId: string;
    startDate: string;
    endDate: string;
    executor?: QueryExecutor | undefined;
  }): Promise<RentalLeaseRow[]> {
    const ex = input.executor ?? this.db;
    const r = await ex.query<RentalLeaseRow>(
      `SELECT ${LEASE_COLS} FROM rental.leases
        WHERE property_id = $1::uuid
          AND status IN ('pending_signature', 'active')
          AND daterange(start_date, end_date, '[)') && daterange($2::date, $3::date, '[)')
        ORDER BY start_date ASC`,
      [input.propertyId, input.startDate, input.endDate],
    );
    return r.rows;
  }

  // ---------------------------------------------------------------- parties

  async addLeaseParty(input: {
    leaseId: string;
    role: string;
    userId?: string | null | undefined;
    organizationId?: string | null | undefined;
    nameSnapshot: string;
    contactSnapshot?: Record<string, unknown> | null | undefined;
    executor?: QueryExecutor | undefined;
  }): Promise<RentalLeasePartyRow> {
    const ex = input.executor ?? this.db;
    const r = await ex.query<RentalLeasePartyRow>(
      `INSERT INTO rental.lease_parties (lease_id, role, user_id, organization_id, name_snapshot, contact_snapshot)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::jsonb)
       RETURNING ${PARTY_COLS}`,
      [input.leaseId, input.role, input.userId ?? null, input.organizationId ?? null, input.nameSnapshot, input.contactSnapshot ? JSON.stringify(input.contactSnapshot) : '{}'],
    );
    const row = r.rows[0];
    if (!row) throw new Error('LEASE_PARTY_INSERT_FAILED');
    return row;
  }

  async listLeaseParties(leaseId: string, executor: QueryExecutor = this.db): Promise<RentalLeasePartyRow[]> {
    const r = await executor.query<RentalLeasePartyRow>(
      `SELECT ${PARTY_COLS} FROM rental.lease_parties
        WHERE lease_id = $1::uuid
        ORDER BY role ASC, id ASC`,
      [leaseId],
    );
    return r.rows;
  }

  // ---------------------------------------------------------------- rent schedules

  async addRentSchedule(input: {
    leaseId: string;
    dueDate: string;
    amount: string;
    currencyCode: string;
    executor?: QueryExecutor | undefined;
  }): Promise<RentScheduleRow> {
    const ex = input.executor ?? this.db;
    const r = await ex.query<RentScheduleRow>(
      `INSERT INTO rental.rent_schedules (lease_id, due_date, amount, currency_code)
       VALUES ($1::uuid, $2::date, $3::numeric, $4::char(3))
       RETURNING ${SCHEDULE_COLS}`,
      [input.leaseId, input.dueDate, input.amount, input.currencyCode],
    );
    const row = r.rows[0];
    if (!row) throw new Error('LEASE_SCHEDULE_INSERT_FAILED');
    return row;
  }

  async listRentSchedules(leaseId: string, executor: QueryExecutor = this.db): Promise<RentScheduleRow[]> {
    const r = await executor.query<RentScheduleRow>(
      `SELECT ${SCHEDULE_COLS} FROM rental.rent_schedules
        WHERE lease_id = $1::uuid
        ORDER BY due_date ASC, id ASC`,
      [leaseId],
    );
    return r.rows;
  }

  async getRentSchedule(leaseId: string, scheduleId: string, executor: QueryExecutor = this.db): Promise<RentScheduleRow | null> {
    const r = await executor.query<RentScheduleRow>(
      `SELECT ${SCHEDULE_COLS} FROM rental.rent_schedules WHERE lease_id = $1::uuid AND id = $2::uuid`,
      [leaseId, scheduleId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Remove a schedule row. rental.rent_payments.schedule_id is ON DELETE RESTRICT
   * (frozen authority): a schedule that already carries a payment cannot be
   * removed — PG surfaces 23503 and the caller maps it to a 409.
   */
  async deleteRentSchedule(leaseId: string, scheduleId: string, executor: QueryExecutor = this.db): Promise<RentScheduleRow | null> {
    const ex = executor ?? this.db;
    const r = await ex.query<RentScheduleRow>(
      `DELETE FROM rental.rent_schedules WHERE lease_id = $1::uuid AND id = $2::uuid
       RETURNING ${SCHEDULE_COLS}`,
      [leaseId, scheduleId],
    );
    return r.rows[0] ?? null;
  }

  // ---------------------------------------------------------------- rent payments (Milestone 2)

  /**
   * Lock the schedule row FOR UPDATE inside the recording transaction. This is
   * the row-level concurrency guard for same-schedule updates: concurrent
   * payment INSERTs take FOR KEY SHARE on the schedule row (frozen FK), which
   * conflicts with FOR UPDATE — so concurrent recorders serialize here and each
   * re-reads a committed state before validating (no lost reconciliation, no
   * double 'paid', overpayment deterministically rejected by the loser).
   */
  async getRentScheduleLocked(leaseId: string, scheduleId: string, executor: QueryExecutor = this.db): Promise<RentScheduleRow | null> {
    const r = await executor.query<RentScheduleRow>(
      `SELECT ${SCHEDULE_COLS} FROM rental.rent_schedules WHERE lease_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
      [leaseId, scheduleId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Exact SUM over the schedule's recorded payments. PG numeric addition is
   * exact (no float ever enters the pipeline); the result is a numeric string.
   */
  async sumRentPayments(scheduleId: string, executor: QueryExecutor = this.db): Promise<string> {
    const r = await executor.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM rental.rent_payments WHERE schedule_id = $1::uuid`,
      [scheduleId],
    );
    return r.rows[0]!.total;
  }

  async insertRentPayment(input: {
    scheduleId: string;
    amount: string;
    currencyCode: string;
    paidAt?: string | null | undefined;
    executor?: QueryExecutor | undefined;
  }): Promise<RentPaymentRow> {
    const ex = input.executor ?? this.db;
    // external_payment_id stays NULL in Milestone 2 (the frozen column exists,
    // but the billing schema provides no rent-specific provenance link — see
    // RentalService.recordRentPayment). COALESCE keeps 'paid at' explicit: the
    // frozen column has no DEFAULT.
    const r = await ex.query<RentPaymentRow>(
      `INSERT INTO rental.rent_payments (schedule_id, amount, currency_code, external_payment_id, paid_at)
       VALUES ($1::uuid, $2::numeric, $3::char(3), NULL::uuid, COALESCE($4::timestamptz, now()))
       RETURNING id, schedule_id, amount::text AS amount, currency_code, external_payment_id, paid_at, created_at`,
      [input.scheduleId, input.amount, input.currencyCode, input.paidAt ?? null],
    );
    const row = r.rows[0];
    if (!row) throw new Error('RENT_PAYMENT_INSERT_FAILED');
    return row;
  }

  async listRentPayments(scheduleId: string, executor: QueryExecutor = this.db): Promise<RentPaymentRow[]> {
    const r = await executor.query<RentPaymentRow>(
      `SELECT id, schedule_id, amount::text AS amount, currency_code, external_payment_id, paid_at, created_at
         FROM rental.rent_payments
        WHERE schedule_id = $1::uuid
        ORDER BY paid_at DESC NULLS LAST, created_at ASC, id ASC`,
      [scheduleId],
    );
    return r.rows;
  }

  async getRentPayment(scheduleId: string, paymentId: string, executor: QueryExecutor = this.db): Promise<RentPaymentRow | null> {
    const r = await executor.query<RentPaymentRow>(
      `SELECT id, schedule_id, amount::text AS amount, currency_code, external_payment_id, paid_at, created_at
         FROM rental.rent_payments WHERE schedule_id = $1::uuid AND id = $2::uuid`,
      [scheduleId, paymentId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Reconcile the schedule from confirmed payment facts: the new status is
   * written together with the payment row in the SAME transaction. paid_at is
   * set only when the schedule becomes fully 'paid' (the completing receipt's
   * paid_at); the frozen rent_payment_status enum is the vocabulary authority.
   */
  async updateRentScheduleStatus(input: {
    scheduleId: string;
    toStatus: string;
    paidAt?: Date | null | undefined;
    executor?: QueryExecutor | undefined;
  }): Promise<RentScheduleRow | null> {
    const ex = input.executor ?? this.db;
    const r = await ex.query<RentScheduleRow>(
      `UPDATE rental.rent_schedules
          SET status = $2::rental.rent_payment_status, paid_at = $3::timestamptz
        WHERE id = $1::uuid
        RETURNING ${SCHEDULE_COLS}`,
      [input.scheduleId, input.toStatus, input.paidAt ?? null],
    );
    return r.rows[0] ?? null;
  }

  // ---------------------------------------------------------------- external billing payment provenance (Milestone 2)

  /**
   * The complete billing-side provenance row for an external payment reference:
   * the frozen billing.payments row plus its owning billing.orders row
   * (payments.order_id is NOT NULL — every payment belongs to exactly one
   * order). Amounts/currencies are exact numeric strings; statuses are the
   * frozen billing.payment_status / billing.order_status vocabularies. The
   * frozen billing schema has NO rent-specific link to rental (no lease or
   * schedule reference anywhere in billing.orders / payments / order_items) —
   * ownership + status + amount/currency equality is ALL the repository
   * evidence that exists, which is why the service fails closed (see service).
   */
  async getBillingPaymentWithOrder(paymentId: string, executor: QueryExecutor = this.db): Promise<{
    id: string;
    order_id: string;
    amount: string;
    currency_code: string;
    status: string;
    order_status: string;
    order_user_id: string | null;
    order_organization_id: string | null;
  } | null> {
    const r = await executor.query<{
      id: string; order_id: string; amount: string; currency_code: string;
      status: string; order_status: string; order_user_id: string | null; order_organization_id: string | null;
    }>(
      `SELECT p.id, p.order_id, p.amount::text AS amount, p.currency_code, p.status::text AS status,
              o.status::text AS order_status, o.user_id AS order_user_id, o.organization_id AS order_organization_id
         FROM billing.payments p
         JOIN billing.orders o ON o.id = p.order_id
        WHERE p.id = $1::uuid`,
      [paymentId],
    );
    return r.rows[0] ?? null;
  }
}
