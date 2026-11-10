import { randomUUID } from 'node:crypto';
import { AuditRepository, IamRepository, OutboxRepository, PostgresDatabase, RentalRepository } from '@platform/db';
import { RentalService } from '../../src/modules/rental/application/rental.service';
import type { AuthenticatedUser } from '@platform/contracts';

const enabled = Boolean(process.env.RUN_DB_TESTS && process.env.DATABASE_URL);
const d = enabled ? describe : describe.skip;

/**
 * Gate P Rental Milestone 3 — integration against real PostgreSQL.
 * Authority under test: frozen base 0018_rental (rent_schedules CHECK >= 0,
 * UNIQUE (lease_id, due_date), rent_payment_status DEFAULT 'scheduled',
 * rent_payments RESTRICT FK) + the M3 application layer (controlled append on
 * active leases, pristine-row amendment, exact non-negative numeric(20,4)
 * schedule contract, FOR UPDATE lease/schedule lock discipline).
 * Mocks alone are not sufficient for the concurrency and locking evidence:
 * every race runs on real PG row locks with two independent clients.
 */
d('Gate P Rental M3 — integration against real PostgreSQL', () => {
  let db: PostgresDatabase;
  let iam: IamRepository;
  let repo: RentalRepository;
  let outbox: OutboxRepository;
  let audit: AuditRepository;
  let service: RentalService;

  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];
  const createdPropertyIds: string[] = [];
  const createdLeaseIds: string[] = [];
  const createdScheduleIds: string[] = [];

  beforeAll(async () => {
    db = new PostgresDatabase({ connectionString: process.env.DATABASE_URL!, max: 5 });
    iam = new IamRepository(db);
    repo = new RentalRepository(db);
    outbox = new OutboxRepository(db);
    audit = new AuditRepository(db);
    service = new RentalService(repo, outbox, audit, iam, db);
  });

  afterAll(async () => {
    // dependency order: rent_payments RESTRICT their schedules → leases cascade
    // schedules → properties → orgs → users
    for (const scheduleId of createdScheduleIds) {
      await db.query(`DELETE FROM rental.rent_payments WHERE schedule_id = $1::uuid`, [scheduleId]);
    }
    for (const leaseId of createdLeaseIds) {
      await db.query(`DELETE FROM rental.leases WHERE id = $1::uuid`, [leaseId]);
    }
    for (const propertyId of createdPropertyIds) {
      await db.query(`DELETE FROM property.properties WHERE id = $1::uuid`, [propertyId]);
    }
    for (const orgId of createdOrgIds) {
      await db.query(`DELETE FROM org.organization_members WHERE organization_id = $1::uuid`, [orgId]);
      await db.query(`DELETE FROM org.organizations WHERE id = $1::uuid`, [orgId]);
    }
    for (const userId of createdUserIds) {
      await db.query(`DELETE FROM iam.user_permission_grants WHERE user_id = $1::uuid`, [userId]);
      await db.query(`DELETE FROM iam.users WHERE id = $1::uuid`, [userId]);
    }
    await db.close();
  });

  async function grant(userId: string, codes: string[]): Promise<void> {
    await db.query(
      `INSERT INTO iam.user_permission_grants (user_id, permission_id, source)
       SELECT $1::uuid, p.id, 'DIRECT' FROM iam.permissions p WHERE p.code = ANY($2::text[])
       ON CONFLICT DO NOTHING`,
      [userId, codes],
    );
  }

  async function user(permissions: string[] = ['rental.view', 'rental.create', 'rental.update']): Promise<AuthenticatedUser> {
    const u = await iam.createPasswordUser({ email: `gp-rental3-${randomUUID()}@t.local`, passwordHash: 'test-hash' });
    createdUserIds.push(u.id);
    await grant(u.id, permissions);
    return { id: u.id, status: 'active' } as AuthenticatedUser;
  }

  async function org(member: AuthenticatedUser): Promise<string> {
    const slug = `gp-rental3-${randomUUID().slice(0, 12)}`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO org.organizations (type, status, legal_name, display_name, slug)
       VALUES ('developer', 'active', $1, $1, $2) RETURNING id`,
      [`GP Rental3 Org ${slug}`, slug],
    );
    const orgId = r.rows[0]!.id;
    createdOrgIds.push(orgId);
    await db.query(
      `INSERT INTO org.organization_members (organization_id, user_id, status) VALUES ($1::uuid, $2::uuid, 'active')`,
      [orgId, member.id],
    );
    return orgId;
  }

  async function property(): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO property.properties (property_type_id, status)
       SELECT id, 'draft' FROM property.property_types WHERE code = 'apartment' RETURNING id`,
    );
    const id = r.rows[0]!.id;
    createdPropertyIds.push(id);
    return id;
  }

  async function fixture(permissions?: string[]): Promise<{ actor: AuthenticatedUser; orgId: string; propertyId: string; tenantId: string }> {
    const actor = await user(permissions);
    const tenant = await user(['rental.view']);
    const orgId = await org(actor);
    const propertyId = await property();
    return { actor, orgId, propertyId, tenantId: tenant.id };
  }

  async function createLease(f: { actor: AuthenticatedUser; orgId: string; propertyId: string; tenantId: string }, schedule?: { dueDate: string; amount: string }): Promise<{ leaseId: string; scheduleId: string | null }> {
    const lease = (await service.createLease({
      organizationId: f.orgId,
      propertyId: f.propertyId,
      tenantUserId: f.tenantId,
      currencyCode: 'USD',
      monthlyRent: '1500.0000',
      startDate: '2031-01-01',
      endDate: '2031-06-30',
    }, f.actor)) as Record<string, unknown>;
    createdLeaseIds.push(lease['id'] as string);
    const leaseId = lease['id'] as string;
    if (!schedule) return { leaseId, scheduleId: null };
    const rows = (await service.addSchedules(leaseId, [
      { dueDate: schedule.dueDate, amount: schedule.amount, currencyCode: 'USD' },
    ], f.actor)) as Array<Record<string, unknown>>;
    const scheduleId = rows.find((s) => s['dueDate'] === schedule.dueDate)!['id'] as string;
    createdScheduleIds.push(scheduleId);
    return { leaseId, scheduleId };
  }

  /** Move a lease through draft → pending_signature → active with the published lifecycle API. */
  async function activate(leaseId: string, actor: AuthenticatedUser): Promise<void> {
    await service.changeLeaseStatus(leaseId, 'pending_signature', actor);
    await service.changeLeaseStatus(leaseId, 'active', actor);
  }

  async function scheduleRow(scheduleId: string): Promise<{ status: string; amount: string; due_date: string; currency_code: string; paid_at: string | null }> {
    const r = await db.query<{ status: string; amount: string; due_date: string; currency_code: string; paid_at: string | null }>(
      `SELECT status::text AS status, amount::text AS amount, due_date::text AS due_date, currency_code, paid_at
         FROM rental.rent_schedules WHERE id = $1::uuid`, [scheduleId],
    );
    return r.rows[0]!;
  }

  async function auditCount(action: string, entityId: string): Promise<number> {
    const r = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit.logs WHERE action = $1 AND entity_id = $2::uuid`, [action, entityId],
    );
    return Number(r.rows[0]?.count ?? '0');
  }

  async function scheduleEventCount(): Promise<number> {
    // no schedule outbox event exists — prove NONE was ever emitted by the M3 paths
    const r = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit.outbox_events WHERE event_type ILIKE '%schedule%'`,
    );
    return Number(r.rows[0]?.count ?? '0');
  }

  it('M3-1 — active-lease schedule append + retrieval: exact persistence, frozen default status, audit, no outbox event', async () => {
    const f = await fixture();
    const { leaseId } = await createLease(f);
    await activate(leaseId, f.actor);

    const appended = (await service.addSchedules(leaseId, [
      { dueDate: '2031-07-01', amount: '1750.5', currencyCode: 'USD' },
      { dueDate: '2031-08-01', amount: '0', currencyCode: 'USD' }, // zero is valid (CHECK amount >= 0)
    ], f.actor)) as Array<Record<string, unknown>>;
    const july = appended.find((s) => s['dueDate'] === '2031-07-01')!;
    const august = appended.find((s) => s['dueDate'] === '2031-08-01')!;
    createdScheduleIds.push(july['id'] as string, august['id'] as string);

    expect(july['amount']).toBe('1750.5000'); // canonical numeric(20,4) form
    expect(july['status']).toBe('scheduled'); // frozen database default, nothing invented
    expect(july['currencyCode']).toBe('USD');
    expect(august['amount']).toBe('0.0000');
    expect(august['paidAt']).toBeNull();

    // byte-exact numeric(20,4) round-trip
    const dbRow = await scheduleRow(july['id'] as string);
    expect(dbRow.amount).toBe('1750.5000');
    expect(dbRow.status).toBe('scheduled');

    // retrieval under the lease hierarchy
    const listed = (await service.listSchedules(leaseId, f.actor)) as Array<Record<string, unknown>>;
    expect(listed.some((s) => s['id'] === july['id'])).toBe(true);
    expect(listed.some((s) => s['id'] === august['id'])).toBe(true);

    // audit-only sub-resource change (M1 precedent): exactly one schedules_added audit, ZERO outbox events
    expect(await auditCount('rental.schedules_added', leaseId)).toBe(1);
    expect(await scheduleEventCount()).toBe(0);
  });

  it('M3-2 — pristine amendment on an active lease: exact replacement round-trip, currency immutable, before/after audit', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLease(f, { dueDate: '2031-02-01', amount: '1500.0000' });
    await activate(leaseId, f.actor);

    const amended = (await service.amendSchedule(leaseId, scheduleId!, { dueDate: '2031-02-15', amount: '1234.5678' }, f.actor)) as Record<string, unknown>;
    expect(amended['dueDate']).toBe('2031-02-15');
    expect(amended['amount']).toBe('1234.5678');
    expect(amended['currencyCode']).toBe('USD'); // immutable, not part of the request
    expect(amended['status']).toBe('scheduled'); // unchanged by the amendment
    expect(amended['paidAt']).toBeNull();

    const dbRow = await scheduleRow(scheduleId!);
    expect(dbRow.due_date).toBe('2031-02-15');
    expect(dbRow.amount).toBe('1234.5678');
    expect(dbRow.currency_code).toBe('USD');
    expect(dbRow.status).toBe('scheduled');
    expect(dbRow.paid_at).toBeNull();

    const auditRow = await db.query<{ before_data: Record<string, unknown>; after_data: Record<string, unknown> }>(
      `SELECT before_data, after_data FROM audit.logs WHERE action = 'rental.schedule_amended' AND entity_id = $1::uuid`,
      [scheduleId!],
    );
    expect(auditRow.rows[0]!.before_data).toMatchObject({ leaseId, scheduleId, dueDate: '2031-02-01', amount: '1500.0000', currencyCode: 'USD', status: 'scheduled' });
    expect(auditRow.rows[0]!.after_data).toMatchObject({ leaseId, scheduleId, dueDate: '2031-02-15', amount: '1234.5678', currencyCode: 'USD', status: 'scheduled' });
    expect(await scheduleEventCount()).toBe(0);
  });

  it('M3-3 — exact numeric contract end-to-end: max precision round-trips, rounding values rejected pre-DB with NO trace', async () => {
    const f = await fixture();
    const { leaseId } = await createLease(f);
    await activate(leaseId, f.actor);

    // maximum representable value persists byte-exact
    const maxRows = (await service.addSchedules(leaseId, [{ dueDate: '2031-07-01', amount: '9999999999999999.9999', currencyCode: 'USD' }], f.actor)) as Array<Record<string, unknown>>;
    const maxSchedule = maxRows[0]!;
    createdScheduleIds.push(maxSchedule['id'] as string);
    expect((await scheduleRow(maxSchedule['id'] as string)).amount).toBe('9999999999999999.9999');

    // amendment to the exact 20-digit canonical form of a non-canonical input
    const amended = (await service.amendSchedule(leaseId, maxSchedule['id'] as string, { dueDate: '2031-07-01', amount: '00000000000000009999999999999999.9999' }, f.actor)) as Record<string, unknown>;
    expect(amended['amount']).toBe('9999999999999999.9999'); // deterministic leading-zero handling, byte-exact
    expect(await auditCount('rental.schedule_amended', maxSchedule['id'] as string)).toBe(1);

    // values that would require rounding are rejected BEFORE any database access, leaving NO trace
    await expect(service.addSchedules(leaseId, [{ dueDate: '2031-09-01', amount: '1.23456', currencyCode: 'USD' }], f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_AMOUNT_INVALID' } });
    await expect(service.amendSchedule(leaseId, maxSchedule['id'] as string, { dueDate: '2031-07-02', amount: '1.23456' }, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_AMOUNT_INVALID' } });
    // out-of-range precision (17 integer digits) rejected on both paths
    await expect(service.addSchedules(leaseId, [{ dueDate: '2031-09-01', amount: '10000000000000000', currencyCode: 'USD' }], f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_AMOUNT_INVALID' } });
    await expect(service.amendSchedule(leaseId, maxSchedule['id'] as string, { dueDate: '2031-07-02', amount: '10000000000000000' }, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_AMOUNT_INVALID' } });
    // zero stays valid on the amendment path too (frozen CHECK amount >= 0)
    const zeroed = (await service.amendSchedule(leaseId, maxSchedule['id'] as string, { dueDate: '2031-07-01', amount: '0' }, f.actor)) as Record<string, unknown>;
    expect(zeroed['amount']).toBe('0.0000');
    const check = await db.query<{ amount: string }>(`SELECT amount::text AS amount FROM rental.rent_schedules WHERE id = $1::uuid`, [maxSchedule['id'] as string]);
    expect(check.rows[0]!.amount).toBe('0.0000');

    // no schedule row was created by any rejection; nothing was mutated by them
    const count = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM rental.rent_schedules WHERE lease_id = $1::uuid AND due_date = '2031-09-01'`, [leaseId],
    );
    expect(Number(count.rows[0]!.count)).toBe(0);
    const afterRejections = await scheduleRow(maxSchedule['id'] as string);
    expect(afterRejections.amount).toBe('0.0000'); // the last EXPLICIT amendment is the only change
    expect(afterRejections.due_date).toBe('2031-07-01');
    expect(await auditCount('rental.schedules_added', leaseId)).toBe(1);
    expect(await auditCount('rental.schedule_amended', maxSchedule['id'] as string)).toBe(2); // leading-zero amend + zero amend
  });

  it('M3-4 — currency mismatch rejected on the active-lease append; amendment carries no currency and never mutates it', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLease(f, { dueDate: '2031-02-01', amount: '500.0000' });
    await activate(leaseId, f.actor);

    await expect(service.addSchedules(leaseId, [{ dueDate: '2031-07-01', amount: '1', currencyCode: 'EUR' }], f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_CURRENCY_MISMATCH' } });
    // the failed append added NO audit record beyond the lease's pre-commencement creation audit
    expect(await auditCount('rental.schedules_added', leaseId)).toBe(1);

    await service.amendSchedule(leaseId, scheduleId!, { dueDate: '2031-02-10', amount: '600.0000' }, f.actor);
    const row = await scheduleRow(scheduleId!);
    expect(row.currency_code).toBe('USD'); // immutable through the amendment
    expect(row.amount).toBe('600.0000');
  });

  it('M3-5 — duplicate due-date conflict on append AND amendment (frozen UNIQUE authority); failed amendment leaves no partial mutation and no audit', async () => {
    const f = await fixture();
    const { leaseId } = await createLease(f);
    await activate(leaseId, f.actor);
    const rows = (await service.addSchedules(leaseId, [
      { dueDate: '2031-02-01', amount: '100.0000', currencyCode: 'USD' },
      { dueDate: '2031-03-01', amount: '200.0000', currencyCode: 'USD' },
    ], f.actor)) as Array<Record<string, unknown>>;
    const mar = rows.find((s) => s['dueDate'] === '2031-03-01')!;

    // append onto an existing date → 409
    await expect(service.addSchedules(leaseId, [{ dueDate: '2031-02-01', amount: '1', currencyCode: 'USD' }], f.actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_SCHEDULE_DUPLICATE' } });
    // amendment onto another row's date → 409 (no partial mutation: amount unchanged, no audit)
    await expect(service.amendSchedule(leaseId, mar['id'] as string, { dueDate: '2031-02-01', amount: '999.9999' }, f.actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_SCHEDULE_DUPLICATE' } });
    expect(await scheduleRow(mar['id'] as string)).toMatchObject({ amount: '200.0000', due_date: '2031-03-01' });
    expect(await auditCount('rental.schedule_amended', mar['id'] as string)).toBe(0);
    // amending a schedule onto its OWN current date is a no-conflict replacement
    const selfAmended = (await service.amendSchedule(leaseId, mar['id'] as string, { dueDate: '2031-03-01', amount: '250.0000' }, f.actor)) as Record<string, unknown>;
    expect(selfAmended['amount']).toBe('250.0000');
  });

  it('M3-6 — amendment of a receipt-bearing schedule rejected: payment row, paid and partially_paid states all disqualify the row', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLease(f, { dueDate: '2031-02-01', amount: '1000.0000' });
    await activate(leaseId, f.actor);

    // partial receipt makes the row non-pristine (payment row exists)
    await service.recordRentPayment(leaseId, scheduleId!, { amount: '400.0000', currencyCode: 'USD' }, f.actor);
    await expect(service.amendSchedule(leaseId, scheduleId!, { dueDate: '2031-02-20', amount: '800.0000' }, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_NOT_AMENDABLE' } });
    const partial = await scheduleRow(scheduleId!);
    expect(partial).toMatchObject({ status: 'partially_paid', amount: '1000.0000', due_date: '2031-02-01' }); // untouched

    // completing the receipt → 'paid' — still never amendable
    await service.recordRentPayment(leaseId, scheduleId!, { amount: '600.0000', currencyCode: 'USD' }, f.actor);
    await expect(service.amendSchedule(leaseId, scheduleId!, { dueDate: '2031-02-20', amount: '800.0000' }, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_NOT_AMENDABLE' } });
    const paid = await scheduleRow(scheduleId!);
    expect(paid).toMatchObject({ status: 'paid', amount: '1000.0000', due_date: '2031-02-01' }); // receipt + reconciliation untouched
    expect(await auditCount('rental.schedule_amended', scheduleId!)).toBe(0);
  });

  it('M3-7 — every prohibited schedule state rejects modification (pending, late, waived, cancelled) — never reopened or inferred', async () => {
    const f = await fixture();
    const { leaseId } = await createLease(f);
    await activate(leaseId, f.actor);
    const cases: Array<{ status: string; dueDate: string }> = [
      { status: 'pending', dueDate: '2031-05-01' },
      { status: 'late', dueDate: '2031-06-01' },
      { status: 'waived', dueDate: '2031-07-01' },
      { status: 'cancelled', dueDate: '2031-08-01' },
    ];
    for (const c of cases) {
      const rows = (await service.addSchedules(leaseId, [{ dueDate: c.dueDate, amount: '300.0000', currencyCode: 'USD' }], f.actor)) as Array<Record<string, unknown>>;
      const scheduleId = rows.find((s) => s['dueDate'] === c.dueDate)!['id'] as string;
      createdScheduleIds.push(scheduleId);
      await db.query(`UPDATE rental.rent_schedules SET status = $1::rental.rent_payment_status WHERE id = $2::uuid`, [c.status, scheduleId]);
      await expect(service.amendSchedule(leaseId, scheduleId, { dueDate: '2031-04-30', amount: '999.9999' }, f.actor))
        .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_NOT_AMENDABLE' } });
      const row = await scheduleRow(scheduleId);
      expect(row.status).toBe(c.status); // never modified, never inferred back to scheduled
      expect(row.amount).toBe('300.0000');
      expect(row.due_date).toBe(c.dueDate); // not moved by the rejected amendment
    }
    expect(await scheduleEventCount()).toBe(0);
  });

  it('M3-8 — deletion semantics preserved: active-lease deletion rejected; draft/pending_signature creation and deletion unchanged', async () => {
    const f = await fixture();
    // pre-commencement: create + delete unchanged (M1 behavior). draft leases
    // are unconstrained by the overlap authority; each pending_signature/active
    // lease below gets its OWN property (the frozen leases_no_overlap GiST
    // authority admits only one pending_signature/active lease per range).
    const draft = await createLease(f, { dueDate: '2031-02-01', amount: '100.0000' });
    const removed = (await service.removeSchedule(draft.leaseId, draft.scheduleId!, f.actor)) as Record<string, unknown>;
    expect(removed['id']).toBe(draft.scheduleId);
    expect(await auditCount('rental.schedule_removed', draft.scheduleId!)).toBe(1);

    const pendingPropertyId = await property();
    const pending = await createLease({ ...f, propertyId: pendingPropertyId }, { dueDate: '2031-02-01', amount: '100.0000' });
    await service.changeLeaseStatus(pending.leaseId, 'pending_signature', f.actor);
    const removedPending = (await service.removeSchedule(pending.leaseId, pending.scheduleId!, f.actor)) as Record<string, unknown>;
    expect(removedPending['id']).toBe(pending.scheduleId);

    // active lease: append allowed, DELETION rejected with the documented domain error
    const activePropertyId = await property();
    const active = await createLease({ ...f, propertyId: activePropertyId }, { dueDate: '2031-02-01', amount: '100.0000' });
    await activate(active.leaseId, f.actor);
    await expect(service.removeSchedule(active.leaseId, active.scheduleId!, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_NOT_MUTABLE' } });
    expect(await scheduleRow(active.scheduleId!)).toMatchObject({ status: 'scheduled' }); // never hard-deleted

    // closed leases: append and amendment both rejected, deletion still rejected
    // (each closed-state lease gets its OWN property: the frozen leases_no_overlap
    // GiST authority admits only one pending_signature/active lease per range)
    for (const toStatus of ['terminated', 'expired', 'cancelled'] as const) {
      const closedPropertyId = await property();
      const lease = await createLease({ ...f, propertyId: closedPropertyId }, { dueDate: '2031-02-01', amount: '100.0000' });
      await service.changeLeaseStatus(lease.leaseId, 'pending_signature', f.actor);
      await service.changeLeaseStatus(lease.leaseId, toStatus === 'cancelled' ? 'cancelled' : 'active', f.actor);
      if (toStatus === 'expired') await service.changeLeaseStatus(lease.leaseId, 'expired', f.actor);
      if (toStatus === 'terminated') await service.changeLeaseStatus(lease.leaseId, 'terminated', f.actor);
      await expect(service.addSchedules(lease.leaseId, [{ dueDate: '2031-07-01', amount: '1', currencyCode: 'USD' }], f.actor))
        .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_NOT_MUTABLE' } });
      await expect(service.amendSchedule(lease.leaseId, lease.scheduleId!, { dueDate: '2031-02-10', amount: '2' }, f.actor))
        .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_NOT_AMENDABLE' } });
      await expect(service.removeSchedule(lease.leaseId, lease.scheduleId!, f.actor))
        .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_NOT_MUTABLE' } });
    }
  });

  it('M3-9 — RACE: amendment versus payment recording on one schedule — exactly one winner in both orders, no stale double-commit', async () => {
    const f = await fixture();
    // amount 100.0000; receipt of 100.0000; amendment DOWN to 50.0000.
    // payment first → paid at 100, amendment then sees a receipt → 422.
    // amendment first → amount 50.0000, payment then overpays → 422.
    // Either order: exactly ONE of the two commits, and the schedule state is
    // consistent with the winner (never 50.0000 + paid + 1 receipt).
    const { leaseId, scheduleId } = await createLease(f, { dueDate: '2031-02-01', amount: '100.0000' });
    await activate(leaseId, f.actor);

    const db2 = new PostgresDatabase({ connectionString: process.env.DATABASE_URL!, max: 2 });
    try {
      const service2 = new RentalService(repo, outbox, audit, iam, db2);
      const attempts = await Promise.allSettled([
        service.recordRentPayment(leaseId, scheduleId!, { amount: '100.0000', currencyCode: 'USD' }, f.actor),
        service2.amendSchedule(leaseId, scheduleId!, { dueDate: '2031-02-28', amount: '50.0000' }, f.actor),
      ]);
      const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
      const rejected = attempts.filter((a) => a.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const row = await scheduleRow(scheduleId!);
      const payments = await db.query<{ count: string; total: string }>(
        `SELECT count(*) AS count, COALESCE(SUM(amount), 0)::text AS total FROM rental.rent_payments WHERE schedule_id = $1::uuid`,
        [scheduleId!],
      );
      if (row.amount === '50.0000') {
        // the AMENDMENT won: the loser payment must have overpaid (50 < 100)
        expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_OVERPAYMENT' } });
        expect(row.status).toBe('scheduled');
        expect(row.due_date).toBe('2031-02-28');
        expect(Number(payments.rows[0]!.count)).toBe(0);
        expect(await auditCount('rental.schedule_amended', scheduleId!)).toBe(1);
      } else {
        // the PAYMENT won: the loser amendment must have seen the receipt under the lock
        expect(row.amount).toBe('100.0000');
        expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_NOT_AMENDABLE' } });
        expect(row.status).toBe('paid');
        expect(Number(payments.rows[0]!.count)).toBe(1);
        expect(payments.rows[0]!.total).toBe('100.0000');
        expect(await auditCount('rental.schedule_amended', scheduleId!)).toBe(0);
      }
    } finally {
      await db2.close();
    }
  });

  it('M3-10 — RACE: concurrent lease termination versus active schedule append — a schedule is never committed against a no-longer-active lease', async () => {
    const f = await fixture();
    const { leaseId } = await createLease(f);
    await activate(leaseId, f.actor);

    const db2 = new PostgresDatabase({ connectionString: process.env.DATABASE_URL!, max: 2 });
    try {
      const service2 = new RentalService(repo, outbox, audit, iam, db2);
      const attempts = await Promise.allSettled([
        service.changeLeaseStatus(leaseId, 'terminated', f.actor),
        service2.addSchedules(leaseId, [{ dueDate: '2031-07-01', amount: '1', currencyCode: 'USD' }], f.actor),
      ]);
      const appendResult = attempts[1]!;
      const terminateResult = attempts[0]!;
      const lease = await db.query<{ status: string }>(
        `SELECT status::text AS status FROM rental.leases WHERE id = $1::uuid`, [leaseId],
      );
      const appendedRow = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM rental.rent_schedules WHERE lease_id = $1::uuid AND due_date = '2031-07-01'`, [leaseId],
      );
      const appended = Number(appendedRow.rows[0]!.count);

      if (appendResult.status === 'fulfilled') {
        // the append committed while the lease was STILL active under the lock;
        // termination then proceeded (schedule-then-terminate is a valid order)
        expect(terminateResult.status).toBe('fulfilled');
        expect(lease.rows[0]!.status).toBe('terminated');
        expect(appended).toBe(1);
        const auditRow = await db.query<{ after_data: Record<string, unknown> }>(
          `SELECT after_data FROM audit.logs WHERE action = 'rental.schedules_added' AND entity_id = $1::uuid`, [leaseId],
        );
        expect(auditRow.rows[0]!.after_data['leaseStatusAtAdd']).toBe('active'); // audited facts prove the state under the lock
      } else {
        // termination committed first: the locked re-read must reject the append
        expect(terminateResult.status).toBe('fulfilled');
        expect(lease.rows[0]!.status).toBe('terminated');
        expect((appendResult as PromiseRejectedResult).reason).toMatchObject({ status: 422, response: { code: 'LEASE_NOT_MUTABLE' } });
        expect(appended).toBe(0);
      }
    } finally {
      await db2.close();
    }
  });

  it('M3-11 — RACE: concurrent due-date collision — the frozen UNIQUE authority yields exactly one winner (409 loser)', async () => {
    const f = await fixture();
    const { leaseId } = await createLease(f);
    await activate(leaseId, f.actor);
    const rows = (await service.addSchedules(leaseId, [
      { dueDate: '2031-02-01', amount: '100.0000', currencyCode: 'USD' },
      { dueDate: '2031-03-01', amount: '200.0000', currencyCode: 'USD' },
    ], f.actor)) as Array<Record<string, unknown>>;
    const feb = rows.find((s) => s['dueDate'] === '2031-02-01')!['id'] as string;
    const mar = rows.find((s) => s['dueDate'] === '2031-03-01')!['id'] as string;

    const db2 = new PostgresDatabase({ connectionString: process.env.DATABASE_URL!, max: 2 });
    try {
      const service2 = new RentalService(repo, outbox, audit, iam, db2);
      // both amendments target 2031-04-01 — exactly one can hold it
      const attempts = await Promise.allSettled([
        service.amendSchedule(leaseId, feb, { dueDate: '2031-04-01', amount: '111.0000' }, f.actor),
        service2.amendSchedule(leaseId, mar, { dueDate: '2031-04-01', amount: '222.0000' }, f.actor),
      ]);
      const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
      const rejected = attempts.filter((a) => a.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409, response: { code: 'LEASE_SCHEDULE_DUPLICATE' } });

      const winnerId = ((fulfilled[0] as PromiseFulfilledResult<Record<string, unknown>>).value['id'] as string);
      // winner sits at the contested date with its own amount; the loser is fully untouched
      const winnerExpected = winnerId === feb
        ? { id: feb, due_date: '2031-04-01', amount: '111.0000' }
        : { id: mar, due_date: '2031-04-01', amount: '222.0000' };
      const loserExpected = winnerId === feb
        ? { id: mar, due_date: '2031-03-01', amount: '200.0000' }
        : { id: feb, due_date: '2031-02-01', amount: '100.0000' };
      const after = await db.query<{ id: string; due_date: string; amount: string }>(
        `SELECT id, due_date::text AS due_date, amount::text AS amount FROM rental.rent_schedules WHERE lease_id = $1::uuid ORDER BY due_date`, [leaseId],
      );
      expect(after.rows.map((r) => ({ id: r.id, due_date: r.due_date, amount: r.amount })).sort((a, b) => a.id.localeCompare(b.id)))
        .toEqual([winnerExpected, loserExpected].sort((a, b) => a.id.localeCompare(b.id)));
      // exactly one amendment audit (only the winner committed)
      expect(await auditCount('rental.schedule_amended', winnerId)).toBe(1);
      expect(await auditCount('rental.schedule_amended', winnerId === feb ? mar : feb)).toBe(0);
    } finally {
      await db2.close();
    }
  });

  it('M3-12 — IDOR and permission regression matrix across the M3 paths (404 no-leak, hierarchy discipline, rental.update/manage)', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLease(f, { dueDate: '2031-02-01', amount: '300.0000' });
    await activate(leaseId, f.actor);

    const outsider = await user();
    const outsiderOrgId = await org(outsider);
    const outsiderLease = (await service.createLease({
      organizationId: outsiderOrgId, propertyId: f.propertyId, tenantUserId: outsider.id,
      currencyCode: 'USD', monthlyRent: '100.0000', startDate: '2031-01-01', endDate: '2031-06-30',
    }, outsider)) as Record<string, unknown>;
    createdLeaseIds.push(outsiderLease['id'] as string);

    // outsider: every M3 path 404s without leaking existence
    await expect(service.addSchedules(leaseId, [{ dueDate: '2031-07-01', amount: '1', currencyCode: 'USD' }], outsider))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_NOT_FOUND' } });
    await expect(service.amendSchedule(leaseId, scheduleId!, { dueDate: '2031-02-10', amount: '1' }, outsider))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_NOT_FOUND' } });
    await expect(service.removeSchedule(leaseId, scheduleId!, outsider))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_NOT_FOUND' } });

    // hierarchy discipline: another lease's schedule ID under this lease path = 404
    await expect(service.amendSchedule(outsiderLease['id'] as string, scheduleId!, { dueDate: '2031-02-10', amount: '1' }, outsider))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_SCHEDULE_NOT_FOUND' } });

    // member without rental.update → 403 on both paths (access checked BEFORE state-derived errors)
    const powerless = await user(['rental.view']);
    await db.query(
      `INSERT INTO org.organization_members (organization_id, user_id, status) VALUES ($1::uuid, $2::uuid, 'active')`,
      [f.orgId, powerless.id],
    );
    await expect(service.addSchedules(leaseId, [{ dueDate: '2031-07-01', amount: '1', currencyCode: 'USD' }], powerless))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.amendSchedule(leaseId, scheduleId!, { dueDate: '2031-02-10', amount: '1' }, powerless))
      .rejects.toMatchObject({ status: 403 });

    // rental.manage implies rental.update for both paths
    const manager = await user(['rental.manage']);
    await db.query(
      `INSERT INTO org.organization_members (organization_id, user_id, status) VALUES ($1::uuid, $2::uuid, 'active')`,
      [f.orgId, manager.id],
    );
    await expect(service.addSchedules(leaseId, [{ dueDate: '2031-08-01', amount: '1', currencyCode: 'USD' }], manager))
      .resolves.toBeTruthy();
    await expect(service.amendSchedule(leaseId, scheduleId!, { dueDate: '2031-02-10', amount: '350.0000' }, manager))
      .resolves.toBeTruthy();
  });

  it('M3-13 — failed mutations leave NO audit row and NO partial state (closed lease, duplicate date, not-amendable, invalid amount)', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLease(f, { dueDate: '2031-02-01', amount: '100.0000' });
    await activate(leaseId, f.actor);
    await service.changeLeaseStatus(leaseId, 'terminated', f.actor);

    const auditBefore = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit.logs WHERE entity_id = $1::uuid OR after_data->>'leaseId' = $2`, [scheduleId!, leaseId],
    );
    const scheduleBefore = await scheduleRow(scheduleId!);

    await expect(service.addSchedules(leaseId, [{ dueDate: '2031-07-01', amount: '1', currencyCode: 'USD' }], f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_NOT_MUTABLE' } });
    await expect(service.amendSchedule(leaseId, scheduleId!, { dueDate: '2031-02-10', amount: '2' }, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_NOT_AMENDABLE' } });
    await expect(service.amendSchedule(leaseId, scheduleId!, { dueDate: '2031-02-10', amount: '1.23456' }, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_AMOUNT_INVALID' } });
    await expect(service.removeSchedule(leaseId, scheduleId!, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_NOT_MUTABLE' } });

    const auditAfter = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit.logs WHERE entity_id = $1::uuid OR after_data->>'leaseId' = $2`, [scheduleId!, leaseId],
    );
    expect(Number(auditAfter.rows[0]!.count)).toBe(Number(auditBefore.rows[0]!.count)); // no audit record from any failure
    expect(await scheduleRow(scheduleId!)).toEqual(scheduleBefore); // no partial mutation
  });
});
