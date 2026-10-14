import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AuditRepository, IamRepository, OutboxRepository, PostgresDatabase, RentalRepository, type RentalLeasePartyRow, type RentalLeaseRow, type RentPaymentRow, type RentScheduleRow } from '@platform/db';
import type { AuthenticatedUser } from '@platform/contracts';

/**
 * Gate P — Rental domain service (Milestone 1: lease foundation).
 *
 * Layering (per established governance — each invariant owned by ONE
 * authoritative layer, never by application code alone):
 *   DB (frozen 0018)    → status vocabulary (rental.lease_status enum), landlord/
 *                         tenant user-XOR-org CHECKs, end_date > start_date CHECK,
 *                         non-negative exact money CHECKs, currency FKs, and the
 *                         CONCURRENCY-SAFE overlap authority (`leases_no_overlap`
 *                         EXCLUDE USING gist WHERE status IN
 *                         ('pending_signature','active')) — a preflight query can
 *                         never substitute it; violations surface as PG 23P01 and
 *                         map to 409 LEASE_OVERLAP_CONFLICT.
 *   Service rule        → transition matrix (the frozen schema has NO lease
 *                         transition trigger — application-owned, minimal
 *                         documented lifecycle), mutability window (draft |
 *                         pending_signature), friendly pre-checks (404/403/422)
 *                         before the DB round-trip, DB error codes mapped to
 *                         domain error codes.
 *   Authorization rule  → rental.view / rental.create / rental.update
 *                         (+ rental.manage implies all), org-scoped, exact 0041
 *                         seed vocabulary.
 *   Organization scoping → mutations and reads are binding-org (landlord-org)
 *                         members only; out-of-scope access = 404 (no existence
 *                         leak, IDOR-safe).
 *   Events               → LeaseCreated.v1 / LeaseStatusChanged.v1 (aggregate
 *                         rental_lease) written in the SAME transaction as the
 *                         mutation (transactional outbox); sub-resource changes
 *                         (meta/parties/schedules) are audit-recorded with
 *                         before/after data, mirroring the valuation precedent
 *                         (meta updates and comparables carried audit only).
 *   Audit                → audit.logs before/after rows in the same transaction
 *                         as every mutation.
 *
 * Milestone 2 (rent payments) adds, on the SAME layering discipline:
 *   DB (frozen 0018 + additive 0042)
 *                      → rent_payments amount CHECK (> 0), the payment-vs-
 *                         schedule currency trigger (trg_rent_payment_currency),
 *                         the RESTRICT FK guarding schedule deletes and the 0042
 *                         unique partial index ux_rent_payments_external_payment
 *                         (the concurrency-safe "same external billing payment
 *                         can never be applied twice" idempotency authority).
 *   Service rule       → the exact numeric(20,4) amount contract
 *                         (assertPositiveDecimalString — Review Fix 1: at most
 *                         4 fractional digits, at most 16 integer digits after
 *                         deterministic leading-zero handling, strictly
 *                         positive; a value that would need rounding is
 *                         REJECTED, never rounded or truncated), the schedule
 *                         status gate (receipts reconcile scheduled | pending |
 *                         late | partially_paid; waived/cancelled are NEVER
 *                         reopened — no grace periods, nothing is ever marked
 *                         'late' automatically), overpayment rejection (exact
 *                         string comparison — never capped, split, refunded or
 *                         absorbed) and payment-fact-derived reconciliation
 *                         (paid / partially_paid from the exact paid total,
 *                         written in the SAME transaction as the payment row —
 *                         a failed transaction leaves NO payment row, NO outbox
 *                         event and NO audit record).
 *   External provenance (Review Fix 2) → an externalPaymentId is verified
 *                         against the real frozen billing evidence: the payment
 *                         must exist, be 'succeeded' (an unsuccessful billing
 *                         payment can never become a completed rent receipt),
 *                         match the schedule currency and the receipt amount
 *                         exactly, carry a 'paid' order, and that order must be
 *                         owned by the lease tenant (billing.orders.user_id /
 *                         organization_id — the applicable identity model).
 *                         The frozen billing schema provides NO rent-specific
 *                         link between billing orders and rental leases (no
 *                         lease/schedule reference exists in billing.orders,
 *                         billing.payments or billing.order_items, and no
 *                         application convention creates rent orders), so
 *                         rent-payment intent can NOT be established from
 *                         amount/currency/status matching — the external path
 *                         FAILS CLOSED with RENT_PAYMENT_EXTERNAL_PROVENANCE_
 *                         UNVERIFIABLE and manual recording of an
 *                         already-confirmed receipt (without externalPaymentId)
 *                         remains the supported model. Documented limitation;
 *                         no payment-provider transaction is ever initiated.
 *
 * Scope lock: no FX conversion, no rent escalation, no late fees, no tax rates,
 * no deposit percentages, no renewal notice periods, no jurisdiction-specific
 * legal conditions, no electronic-signature claims, no ledger posting and no
 * deposit accounting (the frozen billing ledger model defines no account
 * mapping, ownership rules or reversal behavior for rent deposits — recorded
 * as explicit unresolved scope), no payment-provider initiation, no invented
 * rent-intent inference. Money is exact decimal end-to-end: numeric strings
 * in, numeric(20,4) in the DB, numeric strings out — a single canonical value
 * flows into comparisons, persistence, audit and events. Date columns are
 * exact 'YYYY-MM-DD' strings.
 */

const LEASE_STATUSES = ['draft', 'pending_signature', 'active', 'expired', 'terminated', 'cancelled'] as const;

/** Application-owned transition matrix (minimal documented lifecycle). */
const LEASE_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ['pending_signature', 'cancelled'],
  pending_signature: ['active', 'cancelled'],
  active: ['expired', 'terminated'],
  expired: [],
  terminated: [],
  cancelled: [],
};

/** Pre-commencement states in which lease meta/parties/schedules stay mutable. */
const MUTABLE_LEASE_STATUSES: readonly string[] = ['draft', 'pending_signature'];

/**
 * Schedule statuses a rent receipt can be recorded against (Milestone 2).
 * 'waived' / 'cancelled' are NEVER reopened by a payment; 'paid' is fully
 * settled — any further positive receipt is overpayment and is rejected.
 * 'late' is only ever WRITTEN by an operator workflow (none exists in this
 * milestone — nothing here marks a schedule late automatically); a receipt
 * recorded against a late schedule reconciles it from confirmed payment facts.
 */
const PAYABLE_SCHEDULE_STATUSES: readonly string[] = ['scheduled', 'pending', 'late', 'partially_paid'];

// -------------------------------------------------------------------------------------------
// Exact numeric(20,4) money contract (Review Fix 1) — pure string arithmetic, no JS number
// ever touches a payment amount. Canonical form: leading zeros stripped from the integer
// part, fractional part padded to exactly 4 digits — byte-identical to what numeric(20,4)
// persists and returns, so the SAME exact value flows through comparisons, persistence,
// audit and event payloads.
// -------------------------------------------------------------------------------------------

/** Digits only, optional fractional part — signs, exponents, grouping and whitespace rejected. */
const EXACT_DECIMAL_SHAPE = /^\d+(\.\d+)?$/;

const AMOUNT_MAX_INTEGER_DIGITS = 16; // numeric(20,4) max = 9999999999999999.9999
const AMOUNT_MAX_FRACTION_DIGITS = 4;

function rejectAmount(raw: unknown, message: string): never {
  throw new UnprocessableEntityException({ code: 'RENT_PAYMENT_AMOUNT_INVALID', message });
}

/**
 * Validate a receipt amount against the frozen numeric(20,4) column contract
 * and return its canonical exact form. A value that would require rounding
 * when persisted (more than 4 fractional digits) or that exceeds the column
 * range (more than 16 integer digits after harmless leading zeros are stripped
 * deterministically) is rejected with an explicit client domain error BEFORE
 * anything is inserted — never silently rounded, truncated or capped.
 */
export function assertPositiveDecimalString(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64 || !EXACT_DECIMAL_SHAPE.test(raw)) {
    rejectAmount(raw, 'payment amount must be an exact positive decimal string (digits, optional fractional part; no sign, exponent, grouping or whitespace)');
  }
  const [intPart = '', fracPart = ''] = raw.split('.');
  if (fracPart.length > AMOUNT_MAX_FRACTION_DIGITS) {
    rejectAmount(raw, `payment amount '${raw}' has ${fracPart.length} fractional digits; numeric(20,4) persists exactly ${AMOUNT_MAX_FRACTION_DIGITS} — a value that would require rounding is rejected, never rounded or truncated`);
  }
  const intDigits = intPart.replace(/^0+/, '') || '0';
  if (intDigits.length > AMOUNT_MAX_INTEGER_DIGITS) {
    rejectAmount(raw, `payment amount '${raw}' exceeds the numeric(20,4) range (at most ${AMOUNT_MAX_INTEGER_DIGITS} integer digits; leading zeros are ignored)`);
  }
  if (intDigits === '0' && (fracPart === '' || /^0*$/.test(fracPart))) {
    rejectAmount(raw, 'payment amount must be strictly positive (the frozen CHECK amount > 0 is the authority)');
  }
  return `${intDigits}.${fracPart.padEnd(AMOUNT_MAX_FRACTION_DIGITS, '0')}`;
}

/** Exact value of a canonical decimal20_4 string as a BigInt (scale fixed at 4). */
function decimal20_4ToBigInt(canonical: string): bigint {
  const [int, frac = ''] = canonical.split('.');
  return BigInt(int + frac.padEnd(4, '0'));
}

/** Canonical decimal20_4 string of an exact BigInt value (scale 4). */
function bigIntToDecimal20_4(value: bigint): string {
  const digits = (value < 0n ? -value : value).toString().padStart(5, '0');
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

/** Canonicalize any exact numeric string coming back from PG (already scale-4 for numeric(20,4) sums). */
export function canonicalizeDecimal20_4(raw: string): string {
  return bigIntToDecimal20_4(decimal20_4ToBigInt(assertPositiveDecimalStringShape(raw)));
}

function assertPositiveDecimalStringShape(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64 || !EXACT_DECIMAL_SHAPE.test(raw)) {
    rejectAmount(raw, 'stored payment value is not an exact decimal string');
  }
  return raw;
}

/** Exact addition of two canonical decimal20_4 strings. */
export function addExactDecimal20_4(a: string, b: string): string {
  return bigIntToDecimal20_4(decimal20_4ToBigInt(a) + decimal20_4ToBigInt(b));
}

/** Exact three-way comparison of two canonical decimal20_4 strings. */
export function compareExactDecimal20_4(a: string, b: string): number {
  const left = decimal20_4ToBigInt(a);
  const right = decimal20_4ToBigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

type RentalPermission = 'rental.view' | 'rental.create' | 'rental.update';

type LeaseLikeInput = {
  tenantUserId?: string | undefined;
  tenantOrganizationId?: string | undefined;
  sourceListingId?: string | undefined;
  contractId?: string | undefined;
};

@Injectable()
export class RentalService {
  constructor(
    private readonly rentals: RentalRepository,
    private readonly outbox: OutboxRepository,
    private readonly audit: AuditRepository,
    private readonly iam: IamRepository,
    private readonly db: PostgresDatabase,
  ) {}

  // ---------------------------------------------------------------- authorization

  private async requirePermission(actor: AuthenticatedUser, permission: RentalPermission, organizationId?: string): Promise<void> {
    const permissions = await this.iam.listPermissionCodesForUser(actor.id, organizationId);
    const accepted = permissions.includes(permission) || permissions.includes('rental.manage');
    if (!accepted) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: `Required permission is missing: ${permission}` });
    }
  }

  /**
   * Mutations and reads are binding-org (landlord-org) only; out-of-org access
   * = 404 (no existence leak — IDOR-safe).
   */
  private async requireLeaseAccess(leaseRow: RentalLeaseRow, actor: AuthenticatedUser, permission: RentalPermission): Promise<void> {
    if (!leaseRow.landlord_organization_id) {
      // Bare-landlord-user leases have no organization binding and are outside
      // the Milestone 1 organization-scoped surface (registered scope boundary).
      throw new NotFoundException({ code: 'LEASE_NOT_FOUND', message: 'Lease not found' });
    }
    const member = await this.iam.isActiveOrganizationMember(actor.id, leaseRow.landlord_organization_id);
    if (!member) {
      throw new NotFoundException({ code: 'LEASE_NOT_FOUND', message: 'Lease not found' });
    }
    await this.requirePermission(actor, permission, leaseRow.landlord_organization_id);
  }

  private static assertMutable(leaseRow: RentalLeaseRow): void {
    if (!MUTABLE_LEASE_STATUSES.includes(leaseRow.status)) {
      throw new UnprocessableEntityException({
        code: 'LEASE_NOT_MUTABLE',
        message: `lease is ${leaseRow.status}; meta, parties and schedules are only mutable before commencement (draft | pending_signature)`,
      });
    }
  }

  // ---------------------------------------------------------------- creation

  async createLease(input: LeaseLikeInput & {
    organizationId: string;
    propertyId: string;
    currencyCode: string;
    monthlyRent: string;
    depositAmount?: string | undefined;
    startDate: string;
    endDate: string;
    autoRenew?: boolean | undefined;
    parties?: Array<{
      role: string;
      userId?: string | undefined;
      organizationId?: string | undefined;
      nameSnapshot: string;
      contactSnapshot?: Record<string, unknown> | undefined;
    }> | undefined;
  }, actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    await this.requirePermission(actor, 'rental.create', input.organizationId);
    const member = await this.iam.isActiveOrganizationMember(actor.id, input.organizationId);
    if (!member) throw new NotFoundException({ code: 'ORG_NOT_FOUND', message: 'Organization not found' });
    const property = await this.rentals.getProperty(input.propertyId);
    if (!property) throw new NotFoundException({ code: 'PROPERTY_NOT_FOUND', message: 'Property not found' });
    if (!input.tenantUserId === !input.tenantOrganizationId) {
      throw new UnprocessableEntityException({ code: 'LEASE_TENANT_PARTY_INVALID', message: 'exactly one of tenantUserId or tenantOrganizationId is required' });
    }
    if (new Date(input.endDate) <= new Date(input.startDate)) {
      throw new UnprocessableEntityException({ code: 'LEASE_DATE_RANGE_INVALID', message: 'endDate must be after startDate' });
    }
    if (input.sourceListingId) {
      const listing = await this.rentals.getListing(input.sourceListingId);
      if (!listing) throw new UnprocessableEntityException({ code: 'LEASE_LISTING_INVALID', message: `source listing ${input.sourceListingId} does not exist` });
    }
    if (input.contractId) {
      const contract = await this.rentals.getContract(input.contractId);
      if (!contract) throw new UnprocessableEntityException({ code: 'LEASE_CONTRACT_INVALID', message: `contract ${input.contractId} does not exist` });
    }
    if (input.tenantUserId) {
      const tenant = await this.rentals.getUser(input.tenantUserId);
      if (!tenant) throw new UnprocessableEntityException({ code: 'LEASE_TENANT_IDENTITY_INVALID', message: `tenant user ${input.tenantUserId} does not exist` });
    }
    if (input.tenantOrganizationId) {
      const tenantOrg = await this.rentals.getOrganization(input.tenantOrganizationId);
      if (!tenantOrg) throw new UnprocessableEntityException({ code: 'LEASE_TENANT_IDENTITY_INVALID', message: `tenant organization ${input.tenantOrganizationId} does not exist` });
    }
    for (const party of input.parties ?? []) {
      RentalService.assertPartyIdentity(party.role, party.userId, party.organizationId);
      if (party.userId) {
        const u = await this.rentals.getUser(party.userId);
        if (!u) throw new UnprocessableEntityException({ code: 'LEASE_PARTY_IDENTITY_INVALID', message: `party user ${party.userId} does not exist` });
      }
      if (party.organizationId) {
        const o = await this.rentals.getOrganization(party.organizationId);
        if (!o) throw new UnprocessableEntityException({ code: 'LEASE_PARTY_IDENTITY_INVALID', message: `party organization ${party.organizationId} does not exist` });
      }
    }

    const created = await this.db.transaction(async (client) => {
      let row: RentalLeaseRow;
      try {
        row = await this.rentals.createLease({
          propertyId: input.propertyId,
          landlordOrganizationId: input.organizationId,
          tenantUserId: input.tenantUserId,
          tenantOrganizationId: input.tenantOrganizationId,
          currencyCode: input.currencyCode,
          monthlyRent: input.monthlyRent,
          depositAmount: input.depositAmount,
          startDate: input.startDate,
          endDate: input.endDate,
          autoRenew: input.autoRenew,
          sourceListingId: input.sourceListingId,
          contractId: input.contractId,
          executor: client,
        });
      } catch (error) {
        throw RentalService.mapLeaseWriteError(error);
      }
      for (const party of input.parties ?? []) {
        try {
          await this.rentals.addLeaseParty({
            leaseId: row.id, role: party.role, userId: party.userId, organizationId: party.organizationId,
            nameSnapshot: party.nameSnapshot, contactSnapshot: party.contactSnapshot, executor: client,
          });
        } catch (error) {
          throw RentalService.mapPartyWriteError(error);
        }
      }
      await this.outbox.append({
        aggregateType: 'rental_lease', aggregateId: row.id, eventType: 'LeaseCreated.v1', eventVersion: 1,
        payload: {
          leaseId: row.id, propertyId: row.property_id, organizationId: row.landlord_organization_id,
          tenantUserId: row.tenant_user_id, tenantOrganizationId: row.tenant_organization_id,
          currencyCode: row.currency_code, monthlyRent: row.monthly_rent,
          startDate: row.start_date, endDate: row.end_date, actorUserId: actor.id,
        },
      }, client);
      await this.audit.append({
        actorUserId: actor.id, organizationId: input.organizationId,
        action: 'rental.lease_created', entityType: 'rental.lease', entityId: row.id,
        afterData: {
          propertyId: row.property_id, status: row.status, currencyCode: row.currency_code,
          monthlyRent: row.monthly_rent, depositAmount: row.deposit_amount,
          startDate: row.start_date, endDate: row.end_date, autoRenew: row.auto_renew,
          partyCount: (input.parties ?? []).length,
        },
      }, client);
      return row;
    }, { actorUserId: actor.id });
    return this.toLeaseApi(created);
  }

  // ---------------------------------------------------------------- retrieval / listing

  async getLease(leaseId: string, actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    const leaseRow = await this.getLeaseRowOrNotFound(leaseId);
    await this.requireLeaseAccess(leaseRow, actor, 'rental.view');
    const parties = await this.rentals.listLeaseParties(leaseRow.id);
    const schedules = await this.rentals.listRentSchedules(leaseRow.id);
    return {
      ...this.toLeaseApi(leaseRow),
      parties: parties.map((p) => this.toPartyApi(p)),
      schedules: schedules.map((s) => this.toScheduleApi(s)),
    };
  }

  async listLeases(actor: AuthenticatedUser, filter: {
    organizationId?: string | undefined;
    propertyId?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
  } = {}): Promise<Array<Record<string, unknown>>> {
    if (filter.organizationId) {
      const member = await this.iam.isActiveOrganizationMember(actor.id, filter.organizationId);
      if (!member) throw new NotFoundException({ code: 'ORG_NOT_FOUND', message: 'Organization not found' });
      await this.requirePermission(actor, 'rental.view', filter.organizationId);
      const rows = await this.rentals.listLeases({
        organizationId: filter.organizationId, propertyId: filter.propertyId,
        status: filter.status, limit: filter.limit,
      });
      return rows.map((l) => this.toLeaseApi(l));
    }
    await this.requirePermission(actor, 'rental.view');
    const memberOrganizationIds = await this.rentals.listActiveOrganizationIds(actor.id);
    const rows = await this.rentals.listLeases({
      memberOrganizationIds, propertyId: filter.propertyId, status: filter.status, limit: filter.limit,
    });
    return rows.map((l) => this.toLeaseApi(l));
  }

  // ---------------------------------------------------------------- lease updates

  async updateLease(leaseId: string, input: {
    monthlyRent?: string | undefined;
    depositAmount?: string | null | undefined;
    startDate?: string | undefined;
    endDate?: string | undefined;
    autoRenew?: boolean | undefined;
    sourceListingId?: string | null | undefined;
    contractId?: string | null | undefined;
  }, actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    const leaseRow = await this.getLeaseRowOrNotFound(leaseId);
    await this.requireLeaseAccess(leaseRow, actor, 'rental.update');
    RentalService.assertMutable(leaseRow);
    const hasAny = input.monthlyRent !== undefined || input.depositAmount !== undefined
      || input.startDate !== undefined || input.endDate !== undefined || input.autoRenew !== undefined
      || input.sourceListingId !== undefined || input.contractId !== undefined;
    if (!hasAny) {
      throw new UnprocessableEntityException({ code: 'LEASE_NO_CHANGES', message: 'at least one updatable field is required' });
    }
    // friendly pair pre-check (DB CHECK end_date > start_date stays the authority)
    if (input.startDate !== undefined || input.endDate !== undefined) {
      const effectiveStart = input.startDate ?? leaseRow.start_date;
      const effectiveEnd = input.endDate ?? leaseRow.end_date;
      if (new Date(effectiveEnd) <= new Date(effectiveStart)) {
        throw new UnprocessableEntityException({ code: 'LEASE_DATE_RANGE_INVALID', message: 'endDate must be after startDate' });
      }
    }
    const updated = await this.db.transaction(async (client) => {
      let row: RentalLeaseRow | null;
      try {
        row = await this.rentals.updateLeaseMeta({
          id: leaseRow.id,
          monthlyRent: input.monthlyRent,
          depositAmount: input.depositAmount,
          depositAmountProvided: input.depositAmount !== undefined,
          startDate: input.startDate,
          endDate: input.endDate,
          autoRenew: input.autoRenew,
          sourceListingId: input.sourceListingId,
          sourceListingIdProvided: input.sourceListingId !== undefined,
          contractId: input.contractId,
          contractIdProvided: input.contractId !== undefined,
          executor: client,
        });
      } catch (error) {
        throw RentalService.mapLeaseWriteError(error);
      }
      if (!row) {
        // the mutability guard inside the UPDATE matched zero rows — the lease
        // moved lifecycle concurrently (stale pre-read); never a silent no-op.
        throw new ConflictException({
          code: 'LEASE_CONCURRENT_MODIFICATION',
          message: `lease lifecycle moved concurrently (expected ${leaseRow.status}); re-read the lease and retry`,
        });
      }
      await this.audit.append({
        actorUserId: actor.id, organizationId: leaseRow.landlord_organization_id!, // guaranteed by requireLeaseAccess
        action: 'rental.lease_updated', entityType: 'rental.lease', entityId: row.id,
        beforeData: {
          monthlyRent: leaseRow.monthly_rent, depositAmount: leaseRow.deposit_amount,
          startDate: leaseRow.start_date, endDate: leaseRow.end_date,
          autoRenew: leaseRow.auto_renew, sourceListingId: leaseRow.source_listing_id, contractId: leaseRow.contract_id,
        },
        afterData: {
          monthlyRent: row.monthly_rent, depositAmount: row.deposit_amount,
          startDate: row.start_date, endDate: row.end_date,
          autoRenew: row.auto_renew, sourceListingId: row.source_listing_id, contractId: row.contract_id,
        },
      }, client);
      return row;
    }, { actorUserId: actor.id });
    return this.toLeaseApi(updated);
  }

  // ---------------------------------------------------------------- lifecycle transitions

  async changeLeaseStatus(leaseId: string, toStatus: string, actor: AuthenticatedUser, input: {
    reason?: string | undefined;
  } = {}): Promise<Record<string, unknown>> {
    if (!(LEASE_STATUSES as readonly string[]).includes(toStatus)) {
      throw new UnprocessableEntityException({ code: 'LEASE_UNKNOWN_STATUS', message: `lease status '${toStatus}' is not registered` });
    }
    if (toStatus === 'draft') {
      throw new UnprocessableEntityException({ code: 'LEASE_INVALID_TRANSITION', message: 'leases are created as draft; there is no transition back to draft' });
    }
    const leaseRow = await this.getLeaseRowOrNotFound(leaseId);
    // access FIRST (404 no-leak) — state-derived errors (no-op / matrix) must
    // never reveal lease existence or lifecycle to an out-of-scope caller.
    await this.requireLeaseAccess(leaseRow, actor, 'rental.update');
    if (toStatus === leaseRow.status) {
      throw new UnprocessableEntityException({ code: 'LEASE_NO_OP_TRANSITION', message: `lease is already ${toStatus}` });
    }
    if (!LEASE_TRANSITIONS[leaseRow.status]?.includes(toStatus)) {
      throw new UnprocessableEntityException({ code: 'LEASE_INVALID_TRANSITION', message: `transition ${leaseRow.status} -> ${toStatus} is not allowed by the lease lifecycle` });
    }

    const updated = await this.db.transaction(async (client) => {
      let row: RentalLeaseRow | null;
      try {
        row = await this.rentals.updateLeaseStatus({
          id: leaseRow.id, toStatus, expectedFromStatus: leaseRow.status, executor: client,
        });
      } catch (error) {
        throw RentalService.mapLeaseWriteError(error);
      }
      if (!row) {
        // Optimistic-concurrency loser (CRM completeTask precedent): the
        // authorized pre-read was stale — a concurrent transition moved the
        // lifecycle state first, so the CAS UPDATE matched zero rows. The loser
        // throws HERE, before any event/audit emission (never a silent no-op).
        throw new ConflictException({
          code: 'LEASE_STATUS_CONFLICT',
          message: `lease lifecycle moved concurrently (expected ${leaseRow.status}); re-read the lease and retry`,
        });
      }
      await this.outbox.append({
        aggregateType: 'rental_lease', aggregateId: row.id, eventType: 'LeaseStatusChanged.v1', eventVersion: 1,
        payload: {
          leaseId: row.id, propertyId: row.property_id, organizationId: row.landlord_organization_id,
          fromStatus: leaseRow.status, toStatus: row.status, reason: input.reason ?? null, actorUserId: actor.id,
        },
      }, client);
      await this.audit.append({
        actorUserId: actor.id, organizationId: leaseRow.landlord_organization_id!, // guaranteed by requireLeaseAccess
        action: 'rental.lease_status_changed', entityType: 'rental.lease', entityId: row.id,
        beforeData: { status: leaseRow.status },
        afterData: { status: row.status, reason: input.reason ?? null },
      }, client);
      return row;
    }, { actorUserId: actor.id, statusChangeReason: input.reason });
    return this.toLeaseApi(updated);
  }

  // ---------------------------------------------------------------- parties

  async addParties(leaseId: string, items: Array<{
    role: string;
    userId?: string | undefined;
    organizationId?: string | undefined;
    nameSnapshot: string;
    contactSnapshot?: Record<string, unknown> | undefined;
  }>, actor: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
    const leaseRow = await this.getLeaseRowOrNotFound(leaseId);
    await this.requireLeaseAccess(leaseRow, actor, 'rental.update');
    RentalService.assertMutable(leaseRow);
    for (const item of items) {
      RentalService.assertPartyIdentity(item.role, item.userId, item.organizationId);
      if (item.userId) {
        const u = await this.rentals.getUser(item.userId);
        if (!u) throw new UnprocessableEntityException({ code: 'LEASE_PARTY_IDENTITY_INVALID', message: `party user ${item.userId} does not exist` });
      }
      if (item.organizationId) {
        const o = await this.rentals.getOrganization(item.organizationId);
        if (!o) throw new UnprocessableEntityException({ code: 'LEASE_PARTY_IDENTITY_INVALID', message: `party organization ${item.organizationId} does not exist` });
      }
    }
    return this.db.transaction(async (client) => {
      for (const item of items) {
        try {
          await this.rentals.addLeaseParty({
            leaseId: leaseRow.id, role: item.role, userId: item.userId, organizationId: item.organizationId,
            nameSnapshot: item.nameSnapshot, contactSnapshot: item.contactSnapshot, executor: client,
          });
        } catch (error) {
          throw RentalService.mapPartyWriteError(error);
        }
      }
      await this.audit.append({
        actorUserId: actor.id, organizationId: leaseRow.landlord_organization_id!, // guaranteed by requireLeaseAccess
        action: 'rental.party_added', entityType: 'rental.lease', entityId: leaseRow.id,
        afterData: {
          count: items.length,
          items: items.map((i) => ({ role: i.role, userId: i.userId ?? null, organizationId: i.organizationId ?? null, nameSnapshot: i.nameSnapshot })),
        },
      }, client);
      const rows = await this.rentals.listLeaseParties(leaseRow.id, client);
      return rows.map((p) => this.toPartyApi(p));
    }, { actorUserId: actor.id });
  }

  async listParties(leaseId: string, actor: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
    const leaseRow = await this.getLeaseRowOrNotFound(leaseId);
    await this.requireLeaseAccess(leaseRow, actor, 'rental.view');
    const rows = await this.rentals.listLeaseParties(leaseRow.id);
    return rows.map((p) => this.toPartyApi(p));
  }

  // ---------------------------------------------------------------- rent schedules

  async addSchedules(leaseId: string, items: Array<{
    dueDate: string;
    amount: string;
    currencyCode: string;
  }>, actor: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
    const leaseRow = await this.getLeaseRowOrNotFound(leaseId);
    await this.requireLeaseAccess(leaseRow, actor, 'rental.update');
    RentalService.assertMutable(leaseRow);
    // Currency consistency: every schedule carries the lease's own canonical
    // currency — no conversion, no FX logic; a mismatching request is rejected.
    for (const item of items) {
      if (item.currencyCode !== leaseRow.currency_code) {
        throw new UnprocessableEntityException({ code: 'LEASE_SCHEDULE_CURRENCY_MISMATCH', message: `schedule currency must equal the lease currency ${leaseRow.currency_code}` });
      }
    }
    return this.db.transaction(async (client) => {
      for (const item of items) {
        try {
          await this.rentals.addRentSchedule({
            leaseId: leaseRow.id, dueDate: item.dueDate, amount: item.amount, currencyCode: item.currencyCode, executor: client,
          });
        } catch (error) {
          throw RentalService.mapScheduleWriteError(error);
        }
      }
      await this.audit.append({
        actorUserId: actor.id, organizationId: leaseRow.landlord_organization_id!, // guaranteed by requireLeaseAccess
        action: 'rental.schedules_added', entityType: 'rental.lease', entityId: leaseRow.id,
        afterData: {
          count: items.length,
          items: items.map((i) => ({ dueDate: i.dueDate, amount: i.amount, currencyCode: i.currencyCode })),
        },
      }, client);
      const rows = await this.rentals.listRentSchedules(leaseRow.id, client);
      return rows.map((s) => this.toScheduleApi(s));
    }, { actorUserId: actor.id });
  }

  async listSchedules(leaseId: string, actor: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
    const leaseRow = await this.getLeaseRowOrNotFound(leaseId);
    await this.requireLeaseAccess(leaseRow, actor, 'rental.view');
    const rows = await this.rentals.listRentSchedules(leaseRow.id);
    return rows.map((s) => this.toScheduleApi(s));
  }

  async removeSchedule(leaseId: string, scheduleId: string, actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    const leaseRow = await this.getLeaseRowOrNotFound(leaseId);
    await this.requireLeaseAccess(leaseRow, actor, 'rental.update');
    RentalService.assertMutable(leaseRow);
    const existing = await this.rentals.getRentSchedule(leaseRow.id, scheduleId);
    if (!existing) {
      throw new NotFoundException({ code: 'LEASE_SCHEDULE_NOT_FOUND', message: 'Rent schedule not found' });
    }
    return this.db.transaction(async (client) => {
      let row: RentScheduleRow | null;
      try {
        row = await this.rentals.deleteRentSchedule(leaseRow.id, scheduleId, client);
      } catch (error) {
        throw RentalService.mapScheduleWriteError(error);
      }
      if (!row) {
        throw new NotFoundException({ code: 'LEASE_SCHEDULE_NOT_FOUND', message: 'Rent schedule not found' });
      }
      await this.audit.append({
        actorUserId: actor.id, organizationId: leaseRow.landlord_organization_id!, // guaranteed by requireLeaseAccess
        action: 'rental.schedule_removed', entityType: 'rental.lease_schedule', entityId: row.id,
        beforeData: { leaseId: leaseRow.id, dueDate: row.due_date, amount: row.amount, currencyCode: row.currency_code, status: row.status },
        afterData: null,
      }, client);
      return this.toScheduleApi(row);
    }, { actorUserId: actor.id });
  }

  // ---------------------------------------------------------------- rent payments (Milestone 2)

  /**
   * Record an already-confirmed rent receipt and reconcile the schedule in ONE
   * transaction. The API records a receipt the actor asserts has happened — it
   * never initiates a payment-provider transaction, and submitting the request
   * is not itself evidence that money moved (the actor and facts are audited).
   *
   * Concurrency: the schedule row is locked FOR UPDATE inside the transaction,
   * every invariant is re-validated against the locked row, and the exact paid
   * total is re-summed — a concurrent recorder that committed first is fully
   * visible to the loser, whose overpayment check then rejects deterministically.
   * A failed transaction leaves NO payment row, NO outbox event and NO audit
   * record (single-transaction atomicity).
   */
  async recordRentPayment(leaseId: string, scheduleId: string, input: {
    amount: string;
    currencyCode: string;
    externalPaymentId?: string | undefined;
    paidAt?: string | undefined;
  }, actor: AuthenticatedUser): Promise<Record<string, unknown>> {
    // Review Fix 1 — exact numeric(20,4) contract BEFORE any DB round-trip:
    // precision/range violations are explicit client domain errors and can
    // never reach an INSERT (or anything else that could leave a trace).
    const amount = assertPositiveDecimalString(input.amount);

    const leaseRow = await this.getLeaseRowOrNotFound(leaseId);
    await this.requireLeaseAccess(leaseRow, actor, 'rental.update');
    const scheduleRow = await this.rentals.getRentSchedule(leaseRow.id, scheduleId);
    if (!scheduleRow) {
      throw new NotFoundException({ code: 'LEASE_SCHEDULE_NOT_FOUND', message: 'Rent schedule not found' });
    }
    // Currency consistency between payment and schedule (friendly pre-check;
    // the frozen trg_rent_payment_currency trigger stays the DB authority).
    if (input.currencyCode !== scheduleRow.currency_code) {
      throw new UnprocessableEntityException({ code: 'RENT_PAYMENT_CURRENCY_MISMATCH', message: `payment currency must equal the schedule currency ${scheduleRow.currency_code}` });
    }
    // Status gate: never reopen waived/cancelled; a fully paid schedule can
    // only overpay (the exact sum check below is the general authority).
    if (scheduleRow.status === 'waived' || scheduleRow.status === 'cancelled') {
      throw new UnprocessableEntityException({ code: 'RENT_PAYMENT_SCHEDULE_NOT_PAYABLE', message: `schedule is ${scheduleRow.status} and is never reopened by a payment` });
    }

    // Review Fix 2 — external billing payment provenance. The frozen billing
    // schema establishes NO rent-specific link between billing orders and
    // rental leases, so rent-payment intent cannot be verified from repository
    // evidence: this path FAILS CLOSED (documented limitation — manual
    // recording without externalPaymentId remains the supported model).
    if (input.externalPaymentId) {
      await this.assertExternalPaymentProvenance(leaseRow, scheduleRow, input.externalPaymentId, amount);
    }

    return this.db.transaction(async (client) => {
      const locked = await this.rentals.getRentScheduleLocked(leaseRow.id, scheduleRow.id, client);
      if (!locked) {
        throw new NotFoundException({ code: 'LEASE_SCHEDULE_NOT_FOUND', message: 'Rent schedule not found' });
      }
      if (locked.status === 'waived' || locked.status === 'cancelled') {
        throw new UnprocessableEntityException({ code: 'RENT_PAYMENT_SCHEDULE_NOT_PAYABLE', message: `schedule is ${locked.status} and is never reopened by a payment` });
      }
      if (input.currencyCode !== locked.currency_code) {
        throw new UnprocessableEntityException({ code: 'RENT_PAYMENT_CURRENCY_MISMATCH', message: `payment currency must equal the schedule currency ${locked.currency_code}` });
      }
      const paidTotalBefore = canonicalizeDecimal20_4(await this.rentals.sumRentPayments(locked.id, client));
      const paidTotalAfter = addExactDecimal20_4(paidTotalBefore, amount);
      if (compareExactDecimal20_4(paidTotalAfter, canonicalizeDecimal20_4(locked.amount)) > 0) {
        // Overpayment is REJECTED — never silently capped, split, refunded,
        // absorbed or parked (exact decimal comparison, no rounding anywhere).
        throw new UnprocessableEntityException({
          code: 'RENT_PAYMENT_OVERPAYMENT',
          message: `receipt of ${paidTotalAfter} would exceed the scheduled amount ${canonicalizeDecimal20_4(locked.amount)} (already paid ${paidTotalBefore}); overpayment is rejected, not capped`,
        });
      }
      let paymentRow: RentPaymentRow;
      try {
        paymentRow = await this.rentals.insertRentPayment({
          scheduleId: locked.id, amount, currencyCode: input.currencyCode, paidAt: input.paidAt ?? null, executor: client,
        });
      } catch (error) {
        throw RentalService.mapPaymentWriteError(error);
      }
      const fullyPaid = compareExactDecimal20_4(paidTotalAfter, canonicalizeDecimal20_4(locked.amount)) === 0;
      const scheduleStatusAfter = fullyPaid ? 'paid' : 'partially_paid';
      const updatedSchedule = await this.rentals.updateRentScheduleStatus({
        scheduleId: locked.id, toStatus: scheduleStatusAfter, paidAt: fullyPaid ? (paymentRow.paid_at ?? new Date()) : null, executor: client,
      });
      const paidAtIso = paymentRow.paid_at ? paymentRow.paid_at.toISOString() : null;
      await this.outbox.append({
        aggregateType: 'rental_rent_payment', aggregateId: paymentRow.id, eventType: 'RentPaymentRecorded.v1', eventVersion: 1,
        payload: {
          paymentId: paymentRow.id, leaseId: leaseRow.id, scheduleId: locked.id,
          amount, currencyCode: input.currencyCode, paidAt: paidAtIso, externalPaymentId: null,
          scheduleStatusBefore: locked.status, scheduleStatusAfter, paidTotal: paidTotalAfter, actorUserId: actor.id,
        },
      }, client);
      await this.audit.append({
        actorUserId: actor.id, organizationId: leaseRow.landlord_organization_id!, // guaranteed by requireLeaseAccess
        action: 'rental.rent_payment_recorded', entityType: 'rental.rent_payment', entityId: paymentRow.id,
        beforeData: {
          scheduleId: locked.id, leaseId: leaseRow.id, scheduleStatus: locked.status,
          schedulePaidAt: locked.paid_at, paidTotalBefore,
        },
        afterData: {
          paymentId: paymentRow.id, scheduleId: locked.id, leaseId: leaseRow.id,
          amount, currencyCode: input.currencyCode, paidAt: paidAtIso, externalPaymentId: null,
          scheduleStatusBefore: locked.status, scheduleStatusAfter, paidTotalAfter,
        },
      }, client);
      return {
        payment: this.toPaymentApi(paymentRow, leaseRow.id),
        schedule: updatedSchedule ? this.toScheduleApi(updatedSchedule) : null,
        paidTotal: paidTotalAfter,
        scheduleStatusBefore: locked.status,
      };
    }, { actorUserId: actor.id });
  }

  async listRentPayments(leaseId: string, scheduleId: string, actor: AuthenticatedUser): Promise<Array<Record<string, unknown>>> {
    const leaseRow = await this.getLeaseRowOrNotFound(leaseId);
    await this.requireLeaseAccess(leaseRow, actor, 'rental.view');
    const scheduleRow = await this.rentals.getRentSchedule(leaseRow.id, scheduleId);
    if (!scheduleRow) {
      throw new NotFoundException({ code: 'LEASE_SCHEDULE_NOT_FOUND', message: 'Rent schedule not found' });
    }
    const rows = await this.rentals.listRentPayments(scheduleRow.id);
    return rows.map((p) => this.toPaymentApi(p, leaseRow.id));
  }

  /**
   * Review Fix 2 — external billing payment provenance chain over real frozen
   * billing evidence (billing.payments JOIN billing.orders). Every step maps
   * to its own explicit client domain error; ownership uses the applicable
   * identity model (lease tenant is user XOR org by the frozen CHECK; the
   * order must be owned by that same tenant identity). The chain ALWAYS ends
   * in the documented fail-closed error: no schema-level rent-specific link
   * exists, so acceptance would be exactly the invented inference the review
   * forbids. This method never returns normally.
   */
  private async assertExternalPaymentProvenance(leaseRow: RentalLeaseRow, scheduleRow: RentScheduleRow, externalPaymentId: string, amount: string): Promise<never> {
    const billing = await this.rentals.getBillingPaymentWithOrder(externalPaymentId);
    if (!billing) {
      throw new UnprocessableEntityException({ code: 'RENT_PAYMENT_EXTERNAL_INVALID', message: 'referenced external billing payment does not exist' });
    }
    if (billing.status !== 'succeeded') {
      // An unsuccessful billing payment can never become a completed rent receipt.
      throw new UnprocessableEntityException({ code: 'RENT_PAYMENT_EXTERNAL_NOT_CONFIRMED', message: `external billing payment status is '${billing.status}', not 'succeeded'` });
    }
    if (billing.currency_code !== scheduleRow.currency_code) {
      throw new UnprocessableEntityException({ code: 'RENT_PAYMENT_CURRENCY_MISMATCH', message: `external billing payment currency ${billing.currency_code} does not match the schedule currency ${scheduleRow.currency_code}` });
    }
    if (compareExactDecimal20_4(canonicalizeDecimal20_4(billing.amount), amount) !== 0) {
      throw new UnprocessableEntityException({ code: 'RENT_PAYMENT_EXTERNAL_AMOUNT_MISMATCH', message: `external billing payment amount ${canonicalizeDecimal20_4(billing.amount)} does not equal the receipt amount ${amount}` });
    }
    if (billing.order_status !== 'paid') {
      throw new UnprocessableEntityException({ code: 'RENT_PAYMENT_EXTERNAL_ORDER_NOT_PAID', message: `the billing order carrying the external payment is '${billing.order_status}', not 'paid'` });
    }
    const tenantOwned = (leaseRow.tenant_user_id !== null && billing.order_user_id === leaseRow.tenant_user_id)
      || (leaseRow.tenant_organization_id !== null && billing.order_organization_id === leaseRow.tenant_organization_id);
    if (!tenantOwned) {
      throw new UnprocessableEntityException({ code: 'RENT_PAYMENT_EXTERNAL_ORDER_NOT_TENANT_OWNED', message: 'the billing order carrying the external payment is not owned by the lease tenant' });
    }
    // Fail closed: ownership + status + amount/currency equality is ALL the
    // evidence the frozen billing schema can offer — none of it establishes
    // that the order is a RENT payment. Recording the reference would invent
    // rent-payment intent, so the external path stays closed until a
    // trustworthy rent-specific link exists (documented milestone limitation).
    throw new UnprocessableEntityException({
      code: 'RENT_PAYMENT_EXTERNAL_PROVENANCE_UNVERIFIABLE',
      message: 'the billing schema provides no rent-specific link between billing orders and rental leases, so rent-payment intent cannot be verified; record the confirmed receipt manually (omit externalPaymentId)',
    });
  }

  /** PG error codes mapped to domain error codes for payment writes. */
  private static mapPaymentWriteError(error: unknown): Error {
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      // 0042 ux_rent_payments_external_payment — the concurrency-safe idempotency
      // authority: the same external billing payment can never be applied twice.
      return new ConflictException({ code: 'RENT_PAYMENT_DUPLICATE_EXTERNAL', message: 'this external billing payment has already been applied to a rent schedule' });
    }
    if (code === 'P0001') {
      // trg_rent_payment_currency (frozen) — the DB currency consistency authority.
      return new UnprocessableEntityException({ code: 'RENT_PAYMENT_CURRENCY_MISMATCH', message: 'payment currency must equal the schedule currency (frozen trigger authority)' });
    }
    if (code === '23503') {
      return new ConflictException({ code: 'RENT_PAYMENT_SCHEDULE_CONFLICT', message: 'the referenced schedule no longer exists' });
    }
    if (code === '23514') {
      return new UnprocessableEntityException({ code: 'RENT_PAYMENT_AMOUNT_INVALID', message: 'payment amount violates the frozen CHECK (must be a positive exact decimal)' });
    }
    if (error instanceof Error && error.message.includes('RENT_PAYMENT_INSERT_FAILED')) {
      return new UnprocessableEntityException({ code: 'RENT_PAYMENT_RECORD_FAILED', message: 'rent payment could not be recorded' });
    }
    return error as Error;
  }

  // ---------------------------------------------------------------- error mapping

  /** PG error codes mapped to domain error codes (valuation precedent). */
  private static mapLeaseWriteError(error: unknown): Error {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === '23P01') {
      // leases_no_overlap EXCLUDE constraint — the concurrency-safe overlap authority.
      return new ConflictException({ code: 'LEASE_OVERLAP_CONFLICT', message: 'another pending_signature or active lease overlaps this date range for the same property' });
    }
    if (code === '23514') {
      return new UnprocessableEntityException({ code: 'LEASE_CONSTRAINT_VIOLATION', message: 'lease violates frozen constraints (end_date > start_date, landlord/tenant identity XOR, non-negative amounts)' });
    }
    if (code === '23503') {
      return new UnprocessableEntityException({ code: 'LEASE_CURRENCY_UNKNOWN', message: 'a referenced value does not exist (currency code must be a registered currency)' });
    }
    if (message.includes('LEASE_INSERT_FAILED')) {
      return new UnprocessableEntityException({ code: 'LEASE_CREATE_FAILED', message: 'lease could not be created' });
    }
    return error as Error;
  }

  private static mapPartyWriteError(error: unknown): Error {
    const code = (error as { code?: string }).code;
    if (code === '23514' || code === '23503') {
      return new UnprocessableEntityException({ code: 'LEASE_PARTY_IDENTITY_INVALID', message: 'party requires exactly one canonical identity (user or organization) that exists' });
    }
    return error as Error;
  }

  private static mapScheduleWriteError(error: unknown): Error {
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      return new ConflictException({ code: 'LEASE_SCHEDULE_DUPLICATE', message: 'a schedule already exists for this lease and due date' });
    }
    if (code === '23514') {
      return new UnprocessableEntityException({ code: 'LEASE_SCHEDULE_RANGE_INVALID', message: 'schedule amount must be a non-negative exact decimal' });
    }
    if (code === '23503') {
      // RESTRICT from rental.rent_payments on schedule deletes; currency FK elsewhere.
      return new ConflictException({ code: 'LEASE_SCHEDULE_IN_USE', message: 'schedule is referenced by recorded rent payments and cannot be removed' });
    }
    return error as Error;
  }

  // ---------------------------------------------------------------- shared helpers

  private async getLeaseRowOrNotFound(leaseId: string): Promise<RentalLeaseRow> {
    const leaseRow = await this.rentals.getLease(leaseId);
    if (!leaseRow) throw new NotFoundException({ code: 'LEASE_NOT_FOUND', message: 'Lease not found' });
    return leaseRow;
  }

  private static assertPartyIdentity(role: string, userId?: string, organizationId?: string): void {
    if (!userId === !organizationId) {
      throw new UnprocessableEntityException({ code: 'LEASE_PARTY_IDENTITY_INVALID', message: `party '${role}' requires exactly one of userId or organizationId` });
    }
  }

  // ---------------------------------------------------------------- api shaping (numeric → string, untouched)

  private toLeaseApi(l: RentalLeaseRow): Record<string, unknown> {
    return {
      id: l.id, propertyId: l.property_id, sourceListingId: l.source_listing_id, contractId: l.contract_id,
      landlordUserId: l.landlord_user_id, landlordOrganizationId: l.landlord_organization_id,
      tenantUserId: l.tenant_user_id, tenantOrganizationId: l.tenant_organization_id,
      status: l.status, currencyCode: l.currency_code,
      monthlyRent: l.monthly_rent, depositAmount: l.deposit_amount,
      startDate: l.start_date, endDate: l.end_date, autoRenew: l.auto_renew,
      createdAt: l.created_at, updatedAt: l.updated_at,
    };
  }

  private toPartyApi(p: RentalLeasePartyRow): Record<string, unknown> {
    return {
      id: p.id, leaseId: p.lease_id, role: p.role, userId: p.user_id, organizationId: p.organization_id,
      nameSnapshot: p.name_snapshot, contactSnapshot: p.contact_snapshot,
    };
  }

  private toScheduleApi(s: RentScheduleRow): Record<string, unknown> {
    return {
      id: s.id, leaseId: s.lease_id, dueDate: s.due_date, amount: s.amount,
      currencyCode: s.currency_code, status: s.status, paidAt: s.paid_at,
    };
  }

  private toPaymentApi(p: RentPaymentRow, leaseId: string): Record<string, unknown> {
    return {
      id: p.id, leaseId, scheduleId: p.schedule_id, amount: p.amount,
      currencyCode: p.currency_code, externalPaymentId: p.external_payment_id,
      paidAt: p.paid_at, createdAt: p.created_at,
    };
  }

  // exposed for controller DTOs / OpenAPI documentation
  static readonly allowedLeaseStatuses = LEASE_STATUSES;
  static readonly payableScheduleStatuses = PAYABLE_SCHEDULE_STATUSES;
}
