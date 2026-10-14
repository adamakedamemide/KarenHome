import { randomUUID } from 'node:crypto';
import { AuditRepository, IamRepository, OutboxRepository, PostgresDatabase, RentalRepository } from '@platform/db';
import { RentalService } from '../../src/modules/rental/application/rental.service';
import type { AuthenticatedUser } from '@platform/contracts';

const enabled = Boolean(process.env.RUN_DB_TESTS && process.env.DATABASE_URL);
const d = enabled ? describe : describe.skip;

/**
 * Gate P Rental Milestone 2 — integration against real PostgreSQL.
 * Authority under test: frozen base 0018_rental (rent_payments CHECK > 0,
 * trg_rent_payment_currency, RESTRICT FK) + additive 0042 unique partial index
 * ux_rent_payments_external_payment + Review Fix 1 (exact numeric(20,4)
 * contract) + Review Fix 2 (fail-closed external billing provenance).
 * The completed Rental M1 suites are NOT repeated here.
 */
d('Gate P Rental M2 — integration against real PostgreSQL', () => {
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
  const createdPaymentScheduleIds: string[] = [];
  const createdBillingOrderIds: string[] = [];

  beforeAll(async () => {
    db = new PostgresDatabase({ connectionString: process.env.DATABASE_URL!, max: 5 });
    iam = new IamRepository(db);
    repo = new RentalRepository(db);
    outbox = new OutboxRepository(db);
    audit = new AuditRepository(db);
    service = new RentalService(repo, outbox, audit, iam, db);
  });

  afterAll(async () => {
    // dependency order: payments → leases (cascades schedules) → properties →
    // billing (payments RESTRICT orders) → orgs → users
    for (const scheduleId of createdPaymentScheduleIds) {
      await db.query(`DELETE FROM rental.rent_payments WHERE schedule_id = $1::uuid`, [scheduleId]);
    }
    for (const leaseId of createdLeaseIds) {
      await db.query(`DELETE FROM rental.leases WHERE id = $1::uuid`, [leaseId]);
    }
    for (const propertyId of createdPropertyIds) {
      await db.query(`DELETE FROM property.properties WHERE id = $1::uuid`, [propertyId]);
    }
    for (const orderId of createdBillingOrderIds) {
      await db.query(`DELETE FROM billing.payments WHERE order_id = $1::uuid`, [orderId]);
      await db.query(`DELETE FROM billing.orders WHERE id = $1::uuid`, [orderId]);
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
    const u = await iam.createPasswordUser({ email: `gp-rental2-${randomUUID()}@t.local`, passwordHash: 'test-hash' });
    createdUserIds.push(u.id);
    await grant(u.id, permissions);
    return { id: u.id, status: 'active' } as AuthenticatedUser;
  }

  async function org(member: AuthenticatedUser): Promise<string> {
    const slug = `gp-rental2-${randomUUID().slice(0, 12)}`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO org.organizations (type, status, legal_name, display_name, slug)
       VALUES ('developer', 'active', $1, $1, $2) RETURNING id`,
      [`GP Rental2 Org ${slug}`, slug],
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

  async function createLeaseWithSchedule(
    f: { actor: AuthenticatedUser; orgId: string; propertyId: string; tenantId: string },
    schedule: { dueDate: string; amount: string },
  ): Promise<{ leaseId: string; scheduleId: string }> {
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
    const schedules = (await service.addSchedules(lease['id'] as string, [
      { dueDate: schedule.dueDate, amount: schedule.amount, currencyCode: 'USD' },
    ], f.actor)) as Array<Record<string, unknown>>;
    const scheduleId = schedules[0]!['id'] as string;
    createdPaymentScheduleIds.push(scheduleId);
    return { leaseId: lease['id'] as string, scheduleId };
  }

  /** Raw billing fixture (the application does not create billing orders — provider-side artifacts). */
  async function createBillingOrderPayment(input: {
    userId?: string | null;
    organizationId?: string | null;
    amount: string;
    currencyCode?: string;
    paymentStatus?: string;
    orderStatus?: string;
  }): Promise<{ orderId: string; paymentId: string }> {
    const order = await db.query<{ id: string }>(
      `INSERT INTO billing.orders (user_id, organization_id, currency_code, subtotal, tax, discount, total, status)
       VALUES ($1::uuid, $2::uuid, $3::char(3), $4::numeric, 0, 0, $4::numeric, $5::billing.order_status)
       RETURNING id`,
      [input.userId ?? null, input.organizationId ?? null, input.currencyCode ?? 'USD', input.amount, input.orderStatus ?? 'paid'],
    );
    const orderId = order.rows[0]!.id;
    createdBillingOrderIds.push(orderId);
    const payment = await db.query<{ id: string }>(
      `INSERT INTO billing.payments (order_id, provider, provider_reference, amount, currency_code, status, paid_at)
       VALUES ($1::uuid, 'test-provider', $2, $3::numeric, $4::char(3), $5::billing.payment_status, now())
       RETURNING id`,
      [orderId, randomUUID(), input.amount, input.currencyCode ?? 'USD', input.paymentStatus ?? 'succeeded'],
    );
    return { orderId, paymentId: payment.rows[0]!.id };
  }

  async function paymentRowCount(scheduleId: string): Promise<number> {
    const r = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM rental.rent_payments WHERE schedule_id = $1::uuid`, [scheduleId],
    );
    return Number(r.rows[0]?.count ?? '0');
  }

  async function eventCountBySchedule(scheduleId: string): Promise<number> {
    const r = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit.outbox_events WHERE event_type = 'RentPaymentRecorded.v1' AND payload->>'scheduleId' = $1`, [scheduleId],
    );
    return Number(r.rows[0]?.count ?? '0');
  }

  async function auditCountBySchedule(scheduleId: string): Promise<number> {
    const r = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit.logs WHERE action = 'rental.rent_payment_recorded' AND after_data->>'scheduleId' = $1`, [scheduleId],
    );
    return Number(r.rows[0]?.count ?? '0');
  }

  it('PM1 — manual receipt: exact-decimal round-trip, derived paid status + paid_at, event + audit atomically', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLeaseWithSchedule(f, { dueDate: '2031-02-01', amount: '1500.5000' });

    const result = (await service.recordRentPayment(leaseId, scheduleId, {
      amount: '1500.5', // deliberately non-canonical input — one exact value everywhere
      currencyCode: 'USD',
      paidAt: '2031-02-01T10:30:00.000Z',
    }, f.actor)) as Record<string, unknown>;

    const payment = result['payment'] as Record<string, unknown>;
    expect(payment['amount']).toBe('1500.5000'); // canonical numeric(20,4) form
    expect(payment['currencyCode']).toBe('USD');
    expect(payment['externalPaymentId']).toBeNull();
    expect(payment['leaseId']).toBe(leaseId);
    expect(result['paidTotal']).toBe('1500.5000');
    expect(result['scheduleStatusBefore']).toBe('scheduled');
    const schedule = result['schedule'] as Record<string, unknown>;
    expect(schedule['status']).toBe('paid');
    expect(schedule['paidAt']).toBeTruthy();

    // DB round-trip is byte-exact numeric(20,4)
    const dbRow = await db.query<{ amount: string; external_payment_id: string | null }>(
      `SELECT amount::text AS amount, external_payment_id FROM rental.rent_payments WHERE id = $1::uuid`,
      [payment['id'] as string],
    );
    expect(dbRow.rows[0]!.amount).toBe('1500.5000');
    expect(dbRow.rows[0]!.external_payment_id).toBeNull();

    const schedRow = await db.query<{ status: string; paid_at: string | null }>(
      `SELECT status::text AS status, paid_at FROM rental.rent_schedules WHERE id = $1::uuid`, [scheduleId],
    );
    expect(schedRow.rows[0]!.status).toBe('paid');
    expect((schedRow.rows[0]!.paid_at as unknown as Date).toISOString()).toBe('2031-02-01T10:30:00.000Z');

    expect(await eventCountBySchedule(scheduleId)).toBe(1);
    expect(await auditCountBySchedule(scheduleId)).toBe(1);
    const eventPayload = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit.outbox_events WHERE event_type = 'RentPaymentRecorded.v1' AND payload->>'scheduleId' = $1`, [scheduleId],
    );
    expect(eventPayload.rows[0]!.payload['amount']).toBe('1500.5000'); // same exact value in the event
    const auditAfter = await db.query<{ after_data: Record<string, unknown> }>(
      `SELECT after_data FROM audit.logs WHERE action = 'rental.rent_payment_recorded' AND after_data->>'scheduleId' = $1`, [scheduleId],
    );
    expect(auditAfter.rows[0]!.after_data['amount']).toBe('1500.5000'); // same exact value in audit
    expect(auditAfter.rows[0]!.after_data['scheduleStatusBefore']).toBe('scheduled');
    expect(auditAfter.rows[0]!.after_data['scheduleStatusAfter']).toBe('paid');

    // a schedule carrying a recorded payment cannot be deleted (frozen RESTRICT authority)
    await expect(service.removeSchedule(leaseId, scheduleId, f.actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_SCHEDULE_IN_USE' } });
  });

  it('PM2 — partial then completing receipts derive partially_paid → paid from confirmed facts', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLeaseWithSchedule(f, { dueDate: '2031-03-01', amount: '1500.0000' });

    const first = (await service.recordRentPayment(leaseId, scheduleId, { amount: '600.0000', currencyCode: 'USD' }, f.actor)) as Record<string, unknown>;
    expect(first['paidTotal']).toBe('600.0000');
    expect((first['schedule'] as Record<string, unknown>)['status']).toBe('partially_paid');
    expect((first['schedule'] as Record<string, unknown>)['paidAt']).toBeNull(); // paid_at only when fully paid

    const second = (await service.recordRentPayment(leaseId, scheduleId, { amount: '900', currencyCode: 'USD' }, f.actor)) as Record<string, unknown>;
    expect(second['paidTotal']).toBe('1500.0000');
    expect((second['schedule'] as Record<string, unknown>)['status']).toBe('paid');
    expect(second['scheduleStatusBefore']).toBe('partially_paid');

    // retrieval: exact decimal strings under the lease/schedule hierarchy
    const rows = (await service.listRentPayments(leaseId, scheduleId, f.actor)) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['amount']).sort()).toEqual(['600.0000', '900.0000']);
    expect(rows.every((r) => r['leaseId'] === leaseId && r['scheduleId'] === scheduleId)).toBe(true);
  });

  it('PM3 — Review Fix 1: 1.23456 rejected; max precision accepted byte-exact; leading zeros deterministic; rejections leave NO trace', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLeaseWithSchedule(f, { dueDate: '2031-04-01', amount: '9999999999999999.9999' });

    // 5 fractional digits → 422 RENT_PAYMENT_AMOUNT_INVALID, never rounded
    await expect(service.recordRentPayment(leaseId, scheduleId, { amount: '1.23456', currencyCode: 'USD' }, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_AMOUNT_INVALID' } });
    // out-of-range precision (17 integer digits) → 422
    await expect(service.recordRentPayment(leaseId, scheduleId, { amount: '10000000000000000', currencyCode: 'USD' }, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_AMOUNT_INVALID' } });
    // zero → 422
    await expect(service.recordRentPayment(leaseId, scheduleId, { amount: '0', currencyCode: 'USD' }, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_AMOUNT_INVALID' } });

    // every rejection left NOTHING: no payment row, no outbox event, no audit record
    expect(await paymentRowCount(scheduleId)).toBe(0);
    expect(await eventCountBySchedule(scheduleId)).toBe(0);
    expect(await auditCountBySchedule(scheduleId)).toBe(0);

    // maximum supported precision persists byte-exact
    const maxResult = (await service.recordRentPayment(leaseId, scheduleId, { amount: '9999999999999999.9999', currencyCode: 'USD' }, f.actor)) as Record<string, unknown>;
    expect(maxResult['paidTotal']).toBe('9999999999999999.9999');
    const dbRow = await db.query<{ amount: string }>(
      `SELECT amount::text AS amount FROM rental.rent_payments WHERE id = $1::uuid`, [(maxResult['payment'] as Record<string, unknown>)['id'] as string],
    );
    expect(dbRow.rows[0]!.amount).toBe('9999999999999999.9999');

    // harmless leading zeros are handled deterministically (000…1.5 = 1.5000)
    const { leaseId: lzLease, scheduleId: lzSchedule } = await createLeaseWithSchedule(f, { dueDate: '2031-05-01', amount: '1.5000' });
    const lz = (await service.recordRentPayment(lzLease, lzSchedule, { amount: '000000000000000000001.5', currencyCode: 'USD' }, f.actor)) as Record<string, unknown>;
    expect(lz['paidTotal']).toBe('1.5000');
    expect((lz['payment'] as Record<string, unknown>)['amount']).toBe('1.5000');
    expect((lz['schedule'] as Record<string, unknown>)['status']).toBe('paid');
  });

  it('PM4 — overpayment rejected exactly (never capped/split/absorbed); boundary exact; DB unchanged after rejection', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLeaseWithSchedule(f, { dueDate: '2031-02-01', amount: '100.0000' });

    await service.recordRentPayment(leaseId, scheduleId, { amount: '60', currencyCode: 'USD' }, f.actor);

    // 60 + 40.0001 > 100 → rejected
    await expect(service.recordRentPayment(leaseId, scheduleId, { amount: '40.0001', currencyCode: 'USD' }, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_OVERPAYMENT' } });
    expect(await paymentRowCount(scheduleId)).toBe(1);
    expect(await eventCountBySchedule(scheduleId)).toBe(1); // only the first receipt
    expect(await auditCountBySchedule(scheduleId)).toBe(1);
    const total = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM rental.rent_payments WHERE schedule_id = $1::uuid`, [scheduleId],
    );
    expect(total.rows[0]!.total).toBe('60.0000'); // exactly the accepted receipt — nothing absorbed

    // exact boundary: 60 + 40 = 100 → paid
    const done = (await service.recordRentPayment(leaseId, scheduleId, { amount: '40.0000', currencyCode: 'USD' }, f.actor)) as Record<string, unknown>;
    expect(done['paidTotal']).toBe('100.0000');
    expect((done['schedule'] as Record<string, unknown>)['status']).toBe('paid');
    // a further receipt on the fully-paid schedule can only overpay
    await expect(service.recordRentPayment(leaseId, scheduleId, { amount: '0.0001', currencyCode: 'USD' }, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_OVERPAYMENT' } });
  });

  it('PM5 — currency mismatch: service pre-check 422; frozen trigger is the DB authority (raw P0001)', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLeaseWithSchedule(f, { dueDate: '2031-02-01', amount: '500.0000' });

    await expect(service.recordRentPayment(leaseId, scheduleId, { amount: '500.0000', currencyCode: 'EUR' }, f.actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_CURRENCY_MISMATCH' } });
    expect(await paymentRowCount(scheduleId)).toBe(0);
    expect(await eventCountBySchedule(scheduleId)).toBe(0);
    expect(await auditCountBySchedule(scheduleId)).toBe(0);

    // the frozen trg_rent_payment_currency trigger stays the concurrency-safe authority
    await expect(db.query(
      `INSERT INTO rental.rent_payments (schedule_id, amount, currency_code) VALUES ($1::uuid, '500.0000', 'EUR')`, [scheduleId],
    )).rejects.toMatchObject({ code: 'P0001' });
  });

  it('PM6 — Review Fix 2 external provenance: every chain step mapped, valid order/payment fails closed, manual path unaffected', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLeaseWithSchedule(f, { dueDate: '2031-02-01', amount: '700.0000' });

    // nonexistent billing payment
    await expect(service.recordRentPayment(leaseId, scheduleId, {
      amount: '700.0000', currencyCode: 'USD', externalPaymentId: '00000000-0000-4000-8000-0000000000e1',
    }, f.actor)).rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_INVALID' } });

    // unsuccessful billing payment (status 'created') can never be a completed rent receipt
    const unconfirmed = await createBillingOrderPayment({ userId: f.tenantId, amount: '700.0000', paymentStatus: 'created' });
    await expect(service.recordRentPayment(leaseId, scheduleId, {
      amount: '700.0000', currencyCode: 'USD', externalPaymentId: unconfirmed.paymentId,
    }, f.actor)).rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_NOT_CONFIRMED' } });

    // amount mismatch
    const otherAmount = await createBillingOrderPayment({ userId: f.tenantId, amount: '699.9999' });
    await expect(service.recordRentPayment(leaseId, scheduleId, {
      amount: '700.0000', currencyCode: 'USD', externalPaymentId: otherAmount.paymentId,
    }, f.actor)).rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_AMOUNT_MISMATCH' } });

    // order not paid
    const unpaidOrder = await createBillingOrderPayment({ userId: f.tenantId, amount: '700.0000', orderStatus: 'pending' });
    await expect(service.recordRentPayment(leaseId, scheduleId, {
      amount: '700.0000', currencyCode: 'USD', externalPaymentId: unpaidOrder.paymentId,
    }, f.actor)).rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_ORDER_NOT_PAID' } });

    // unrelated / wrong-tenant order ownership
    const strangerTenant = await user(['rental.view']);
    const strangerOrder = await createBillingOrderPayment({ userId: strangerTenant.id, amount: '700.0000' });
    await expect(service.recordRentPayment(leaseId, scheduleId, {
      amount: '700.0000', currencyCode: 'USD', externalPaymentId: strangerOrder.paymentId,
    }, f.actor)).rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_ORDER_NOT_TENANT_OWNED' } });

    // VALID order/payment under every verifiable dimension (tenant-owned, succeeded,
    // paid order, exact amount + currency) STILL fails closed: the frozen billing
    // schema establishes no rent-specific link, so rent-payment intent cannot be
    // verified from repository evidence — the documented milestone limitation.
    const valid = await createBillingOrderPayment({ userId: f.tenantId, amount: '700.0000' });
    await expect(service.recordRentPayment(leaseId, scheduleId, {
      amount: '700.0000', currencyCode: 'USD', externalPaymentId: valid.paymentId,
    }, f.actor)).rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_PROVENANCE_UNVERIFIABLE' } });

    // the whole external chain left NOTHING
    expect(await paymentRowCount(scheduleId)).toBe(0);
    expect(await eventCountBySchedule(scheduleId)).toBe(0);
    expect(await auditCountBySchedule(scheduleId)).toBe(0);

    // manual recording of the already-confirmed receipt remains the supported model
    const manual = (await service.recordRentPayment(leaseId, scheduleId, { amount: '700.0000', currencyCode: 'USD' }, f.actor)) as Record<string, unknown>;
    expect((manual['schedule'] as Record<string, unknown>)['status']).toBe('paid');
    expect(await paymentRowCount(scheduleId)).toBe(1);
  });

  it('PM7 — two concurrent recorders on one schedule: FOR UPDATE serialization, exactly one winner, loser overpays, exactly 1 event + 1 audit', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLeaseWithSchedule(f, { dueDate: '2031-06-01', amount: '1500.0000' });

    const db2 = new PostgresDatabase({ connectionString: process.env.DATABASE_URL!, max: 2 });
    try {
      const service2 = new RentalService(repo, outbox, audit, iam, db2);
      const attempts = await Promise.allSettled([
        service.recordRentPayment(leaseId, scheduleId, { amount: '1500.0000', currencyCode: 'USD' }, f.actor),
        service2.recordRentPayment(leaseId, scheduleId, { amount: '1500.0000', currencyCode: 'USD' }, f.actor),
      ]);
      const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
      const rejected = attempts.filter((a) => a.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_OVERPAYMENT' } });

      const winner = (fulfilled[0] as PromiseFulfilledResult<Record<string, unknown>>).value;
      expect((winner['schedule'] as Record<string, unknown>)['status']).toBe('paid');

      expect(await paymentRowCount(scheduleId)).toBe(1);
      expect(await eventCountBySchedule(scheduleId)).toBe(1);
      expect(await auditCountBySchedule(scheduleId)).toBe(1);
      const sched = await db.query<{ status: string; amount: string }>(
        `SELECT status::text AS status, amount::text AS amount FROM rental.rent_schedules WHERE id = $1::uuid`, [scheduleId],
      );
      expect(sched.rows[0]!.status).toBe('paid');
      expect(sched.rows[0]!.amount).toBe('1500.0000'); // unchanged by the loser
    } finally {
      await db2.close();
    }
  });

  it('PM8 — org scoping / IDOR: outsider 404 everywhere; schedule of another lease 404; waived/cancelled never reopened', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLeaseWithSchedule(f, { dueDate: '2031-02-01', amount: '300.0000' });

    const outsider = await user();
    const outsiderOrgId = await org(outsider);
    const outsiderLease = (await service.createLease({
      organizationId: outsiderOrgId, propertyId: f.propertyId, tenantUserId: outsider.id,
      currencyCode: 'USD', monthlyRent: '100.0000', startDate: '2031-01-01', endDate: '2031-06-30',
    }, outsider)) as Record<string, unknown>;
    createdLeaseIds.push(outsiderLease['id'] as string);

    // outsider cannot see, list against, or record on the in-scope lease's schedule
    await expect(service.recordRentPayment(leaseId, scheduleId, { amount: '300.0000', currencyCode: 'USD' }, outsider))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_NOT_FOUND' } });
    await expect(service.listRentPayments(leaseId, scheduleId, outsider))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_NOT_FOUND' } });

    // a schedule from ANOTHER lease under the caller's own lease path = 404 (hierarchy discipline)
    await expect(service.recordRentPayment(outsiderLease['id'] as string, scheduleId, { amount: '300.0000', currencyCode: 'USD' }, outsider))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_SCHEDULE_NOT_FOUND' } });

    // waived/cancelled schedules are never reopened by a payment
    for (const status of ['waived', 'cancelled']) {
      const { leaseId: wLease, scheduleId: wSchedule } = await createLeaseWithSchedule(f, { dueDate: '2031-03-01', amount: '300.0000' });
      await db.query(`UPDATE rental.rent_schedules SET status = $1::rental.rent_payment_status WHERE id = $2::uuid`, [status, wSchedule]);
      await expect(service.recordRentPayment(wLease, wSchedule, { amount: '300.0000', currencyCode: 'USD' }, f.actor))
        .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_SCHEDULE_NOT_PAYABLE' } });
      expect(await paymentRowCount(wSchedule)).toBe(0);
    }
  });

  it('PM9 — 0042 unique partial index exists and is the external-idempotency authority (raw duplicate rejected 23505)', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLeaseWithSchedule(f, { dueDate: '2031-02-01', amount: '800.0000' });

    const ext = await createBillingOrderPayment({ userId: f.tenantId, amount: '800.0000' });
    // The API path fails closed (PM6); the DB authority is proven at the SQL
    // level so the invariant holds for ANY writer: the same external billing
    // payment can never be applied twice.
    await db.query(
      `INSERT INTO rental.rent_payments (schedule_id, amount, currency_code, external_payment_id, paid_at)
       VALUES ($1::uuid, '800.0000', 'USD', $2::uuid, now())`, [scheduleId, ext.paymentId],
    );
    await expect(db.query(
      `INSERT INTO rental.rent_payments (schedule_id, amount, currency_code, external_payment_id, paid_at)
       VALUES ($1::uuid, '100.0000', 'USD', $2::uuid, now())`, [scheduleId, ext.paymentId],
    )).rejects.toMatchObject({ code: '23505' });

    // manual receipts (NULL external id) are unconstrained by the partial index
    await db.query(
      `INSERT INTO rental.rent_payments (schedule_id, amount, currency_code) VALUES ($1::uuid, '100.0000', 'USD')`, [scheduleId],
    );
    expect(await paymentRowCount(scheduleId)).toBe(2);
    expect(leaseId).toBeTruthy();
  });

  it('PM10 — active-lease schedule payment: the only post-commencement schedule management this milestone adds', async () => {
    const f = await fixture();
    const { leaseId, scheduleId } = await createLeaseWithSchedule(f, { dueDate: '2031-02-01', amount: '1200.0000' });
    await service.changeLeaseStatus(leaseId, 'pending_signature', f.actor);
    await service.changeLeaseStatus(leaseId, 'active', f.actor);
    // structural schedule management stays frozen after commencement…
    await expect(service.addSchedules(leaseId, [{ dueDate: '2031-07-01', amount: '1', currencyCode: 'USD' }], f.actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_NOT_MUTABLE' } });
    await expect(service.removeSchedule(leaseId, scheduleId, f.actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_NOT_MUTABLE' } });
    // …while recording confirmed receipts against existing schedules is supported and documented
    const r = (await service.recordRentPayment(leaseId, scheduleId, { amount: '1200.0000', currencyCode: 'USD' }, f.actor)) as Record<string, unknown>;
    expect((r['schedule'] as Record<string, unknown>)['status']).toBe('paid');
  });
});
