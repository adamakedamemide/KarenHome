import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { RentalService, assertPositiveDecimalString, addExactDecimal20_4, compareExactDecimal20_4 } from '../src/modules/rental/application/rental.service';
import type { AuthenticatedUser } from '@platform/contracts';

type LooseMock = jest.Mock & any;
function mockFn(impl?: (...args: any[]) => any): LooseMock {
  return (impl ? jest.fn(impl) : jest.fn()) as LooseMock;
}

const now = new Date();
const leaseRow = {
  id: 'lease-1', property_id: 'prop-1', source_listing_id: null, contract_id: null,
  landlord_user_id: null, landlord_organization_id: 'org-1',
  tenant_user_id: 'user-2', tenant_organization_id: null,
  status: 'active', currency_code: 'USD', monthly_rent: '1500.0000', deposit_amount: null,
  start_date: '2030-01-01', end_date: '2030-06-30', auto_renew: false,
  created_at: now, updated_at: now,
};
const scheduleRow = {
  id: 'sched-1', lease_id: 'lease-1', due_date: '2030-02-01', amount: '1500.0000',
  currency_code: 'USD', status: 'scheduled', paid_at: null,
};
const paymentRow = {
  id: 'pay-1', schedule_id: 'sched-1', amount: '1500.0000', currency_code: 'USD',
  external_payment_id: null, paid_at: now, created_at: now,
};
const billingRow = {
  id: 'ext-pay-1', order_id: 'order-1', amount: '1500.0000', currency_code: 'USD',
  status: 'succeeded', order_status: 'paid', order_user_id: 'user-2', order_organization_id: null,
};

function makeRepo(overrides: Record<string, LooseMock> = {}) {
  const repo: Record<string, LooseMock> = {
    getLease: mockFn(async () => ({ ...leaseRow })),
    listActiveOrganizationIds: mockFn(async () => ['org-1']),
    getRentSchedule: mockFn(async () => ({ ...scheduleRow })),
    getRentScheduleLocked: mockFn(async () => ({ ...scheduleRow })),
    sumRentPayments: mockFn(async () => '0.0000'),
    insertRentPayment: mockFn(async () => ({ ...paymentRow })),
    listRentPayments: mockFn(async () => [{ ...paymentRow }]),
    updateRentScheduleStatus: mockFn(async () => ({ ...scheduleRow, status: 'paid', paid_at: now })),
    getBillingPaymentWithOrder: mockFn(async () => ({ ...billingRow })),
  };
  return Object.assign(repo, overrides);
}

function makeDb() {
  return { transaction: mockFn(async (fn: any) => fn({ query: mockFn() })) };
}

function makeService(repo = makeRepo(), iamOpts: { member?: boolean; permissions?: string[] } = {}) {
  const outbox = { append: mockFn(async () => 'evt') };
  const audit = { append: mockFn(async () => undefined) };
  const iam = {
    listPermissionCodesForUser: mockFn(async () => iamOpts.permissions ?? ['rental.view', 'rental.update']),
    isActiveOrganizationMember: mockFn(async () => iamOpts.member ?? true),
  };
  const db = makeDb();
  const service = new RentalService(repo as never, outbox as never, audit as never, iam as never, db as never);
  return { service, repo, outbox, audit, iam, db };
}

const actor = { id: 'user-1', status: 'active' } as AuthenticatedUser;
const recordInput = { amount: '1500.0000', currencyCode: 'USD' };

beforeEach(() => { jest.clearAllMocks(); });

describe('RentalService M2 — exact numeric(20,4) amount contract (Review Fix 1)', () => {
  it('PM-U1 — 1.23456 (5 fractional digits) is rejected, never rounded or truncated', () => {
    expect(() => assertPositiveDecimalString('1.23456'))
      .toThrow(/would require rounding/);
    try { assertPositiveDecimalString('1.23456'); } catch (e: any) {
      expect(e.response?.code).toBe('RENT_PAYMENT_AMOUNT_INVALID');
      expect(e.status).toBe(422);
    }
  });

  it('PM-U2 — more than 4 fractional digits rejected in every position; exactly 4 accepted', () => {
    expect(() => assertPositiveDecimalString('0.00001')).toThrow(/would require rounding/);
    expect(() => assertPositiveDecimalString('12.12345')).toThrow(/would require rounding/);
    expect(assertPositiveDecimalString('0.0001')).toBe('0.0001');
    expect(assertPositiveDecimalString('12.5')).toBe('12.5000');
    expect(assertPositiveDecimalString('12')).toBe('12.0000');
  });

  it('PM-U3 — maximum supported precision 9999999999999999.9999 is accepted byte-exact', () => {
    expect(assertPositiveDecimalString('9999999999999999.9999')).toBe('9999999999999999.9999');
  });

  it('PM-U4 — out-of-range precision (17+ integer digits) is rejected; leading zeros are harmless', () => {
    expect(() => assertPositiveDecimalString('10000000000000000')).toThrow(/numeric\(20,4\) range/);
    expect(() => assertPositiveDecimalString('10000000000000000.0000')).toThrow(/numeric\(20,4\) range/);
    // harmless leading zeros are handled deterministically (strip → validate)
    expect(assertPositiveDecimalString('000000000000000000001.5')).toBe('1.5000');
    expect(assertPositiveDecimalString('00000000000000009999999999999999.9999')).toBe('9999999999999999.9999');
    expect(() => assertPositiveDecimalString('000000000000000010000000000000000')).toThrow(/numeric\(20,4\) range/);
  });

  it('PM-U5 — positivity and shape: zero, signs, exponents, grouping, whitespace, empties rejected', () => {
    for (const bad of ['0', '0.0000', '-1', '+1.5', '1e5', '1,500', ' 1', '1 ', '', 'abc', '1.', '.5', '1.2.3']) {
      expect(() => assertPositiveDecimalString(bad)).toThrow();
    }
  });

  it('PM-U6 — exact arithmetic: BigInt-scale addition and comparison (no float anywhere)', () => {
    expect(addExactDecimal20_4('0.0000', '1500.0000')).toBe('1500.0000');
    expect(addExactDecimal20_4('600.0000', '400.0000')).toBe('1000.0000');
    expect(addExactDecimal20_4('9999999999999999.9999', '0.0001')).toBe('10000000000000000.0000');
    expect(compareExactDecimal20_4('1000.0000', '1000.0000')).toBe(0);
    expect(compareExactDecimal20_4('999.9999', '1000.0000')).toBe(-1);
    expect(compareExactDecimal20_4('1000.0001', '1000.0000')).toBe(1);
  });

  it('PM-U7 — invalid precision/range maps to the explicit client domain error BEFORE any DB access', async () => {
    const s = makeService();
    await expect(s.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, amount: '1.23456' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_AMOUNT_INVALID' } });
    await expect(s.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, amount: '10000000000000000' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_AMOUNT_INVALID' } });
    expect(s.repo.getLease).not.toHaveBeenCalled(); // rejected before anything else happens
    expect(s.db.transaction).not.toHaveBeenCalled();
  });

  it('PM-U8 — the canonical value flows identically into persistence, audit and event payloads', async () => {
    const s = makeService();
    const result = (await s.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, amount: '12.5' }, actor)) as Record<string, unknown>;
    expect(s.repo.insertRentPayment).toHaveBeenCalledWith(expect.objectContaining({ amount: '12.5000' }));
    expect(s.outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'RentPaymentRecorded.v1',
      payload: expect.objectContaining({ amount: '12.5000', paidTotal: '12.5000', externalPaymentId: null }),
    }), expect.anything());
    expect(s.audit.append).toHaveBeenCalledWith(expect.objectContaining({
      action: 'rental.rent_payment_recorded',
      afterData: expect.objectContaining({ amount: '12.5000', paidTotalAfter: '12.5000', externalPaymentId: null }),
      beforeData: expect.objectContaining({ scheduleStatus: 'scheduled', paidTotalBefore: '0.0000' }),
    }), expect.anything());
    expect((result['payment'] as Record<string, unknown>)['amount']).toBe('1500.0000');
  });
});

describe('RentalService M2 — permissions and scoping', () => {
  it('PM-U9 — recording requires rental.update (scoped to the landlord org); rental.manage implies it', async () => {
    const denied = makeService(undefined, { permissions: ['rental.view'] });
    await expect(denied.service.recordRentPayment('lease-1', 'sched-1', recordInput, actor))
      .rejects.toMatchObject({ status: 403 });
    expect(denied.iam.listPermissionCodesForUser).toHaveBeenCalledWith(actor.id, 'org-1');

    const manager = makeService(undefined, { permissions: ['rental.manage'] });
    await expect(manager.service.recordRentPayment('lease-1', 'sched-1', recordInput, actor)).resolves.toBeTruthy();
  });

  it('PM-U10 — non-member gets 404 (no existence leak); listing requires rental.view', async () => {
    const s = makeService(undefined, { member: false });
    await expect(s.service.recordRentPayment('lease-1', 'sched-1', recordInput, actor))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_NOT_FOUND' } });

    const viewer = makeService(undefined, { permissions: ['rental.create'] });
    await expect(viewer.service.listRentPayments('lease-1', 'sched-1', actor))
      .rejects.toMatchObject({ status: 403 });
  });

  it('PM-U11 — schedule of another lease = 404 LEASE_SCHEDULE_NOT_FOUND (hierarchy discipline, IDOR-safe)', async () => {
    const s = makeService(makeRepo({ getRentSchedule: mockFn(async () => null) }));
    await expect(s.service.recordRentPayment('lease-1', 'sched-1', recordInput, actor))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_SCHEDULE_NOT_FOUND' } });
    await expect(s.service.listRentPayments('lease-1', 'sched-1', actor))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_SCHEDULE_NOT_FOUND' } });
  });
});

describe('RentalService M2 — reconciliation invariants', () => {
  it('PM-U12 — full payment derives paid + paid_at; partial derives partially_paid with paid_at cleared', async () => {
    const full = makeService();
    const r1 = (await full.service.recordRentPayment('lease-1', 'sched-1', recordInput, actor)) as Record<string, unknown>;
    expect(full.repo.updateRentScheduleStatus).toHaveBeenCalledWith(expect.objectContaining({ toStatus: 'paid' }));
    expect(r1['paidTotal']).toBe('1500.0000');
    expect(r1['scheduleStatusBefore']).toBe('scheduled');

    const partial = makeService(makeRepo({ sumRentPayments: mockFn(async () => '0.0000') }));
    (partial.repo.updateRentScheduleStatus as LooseMock).mockResolvedValue({ ...scheduleRow, status: 'partially_paid' });
    await partial.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, amount: '600' }, actor);
    expect(partial.repo.updateRentScheduleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ toStatus: 'partially_paid', paidAt: null }),
    );
  });

  it('PM-U13 — overpayment is rejected with an explicit 422; nothing is capped, split or absorbed', async () => {
    const schedule1000 = { ...scheduleRow, amount: '1000.0000' };
    const s = makeService(makeRepo({
      getRentSchedule: mockFn(async () => ({ ...schedule1000 })),
      getRentScheduleLocked: mockFn(async () => ({ ...schedule1000 })),
      sumRentPayments: mockFn(async () => '600.0000'),
    }));
    await expect(s.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, amount: '400.0001' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_OVERPAYMENT' } });
    expect(s.repo.insertRentPayment).not.toHaveBeenCalled();
    expect(s.outbox.append).not.toHaveBeenCalled();
    expect(s.audit.append).not.toHaveBeenCalled();
    // exact boundary: 600 + 400 = 1000 = scheduled amount → succeeds
    const ok = makeService(makeRepo({ sumRentPayments: mockFn(async () => '600.0000') }));
    await expect(ok.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, amount: '400' }, actor)).resolves.toBeTruthy();
  });

  it('PM-U14 — waived/cancelled schedules are never reopened; already-paid schedule only overpays', async () => {
    for (const status of ['waived', 'cancelled']) {
      const s = makeService(makeRepo({ getRentSchedule: mockFn(async () => ({ ...scheduleRow, status })), getRentScheduleLocked: mockFn(async () => ({ ...scheduleRow, status })) }));
      await expect(s.service.recordRentPayment('lease-1', 'sched-1', recordInput, actor))
        .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_SCHEDULE_NOT_PAYABLE' } });
      expect(s.db.transaction).not.toHaveBeenCalled();
    }
    const paid = makeService(makeRepo({
      getRentSchedule: mockFn(async () => ({ ...scheduleRow, status: 'paid' })),
      getRentScheduleLocked: mockFn(async () => ({ ...scheduleRow, status: 'paid' })),
      sumRentPayments: mockFn(async () => '1500.0000'),
    }));
    await expect(paid.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, amount: '0.0001' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_OVERPAYMENT' } });
  });

  it('PM-U15 — currency must equal the schedule currency (no conversion, no FX)', async () => {
    const s = makeService();
    await expect(s.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, currencyCode: 'EUR' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_CURRENCY_MISMATCH' } });
    expect(s.db.transaction).not.toHaveBeenCalled();
  });

  it('PM-U16 — late and pending schedules reconcile from payment facts (documented matrix)', async () => {
    for (const status of ['pending', 'late', 'partially_paid', 'scheduled']) {
      const s = makeService(makeRepo({
        getRentSchedule: mockFn(async () => ({ ...scheduleRow, status })),
        getRentScheduleLocked: mockFn(async () => ({ ...scheduleRow, status })),
      }));
      await expect(s.service.recordRentPayment('lease-1', 'sched-1', recordInput, actor)).resolves.toBeTruthy();
      expect(s.repo.updateRentScheduleStatus).toHaveBeenCalledWith(expect.objectContaining({ toStatus: 'paid' }));
    }
  });
});

describe('RentalService M2 — external billing payment provenance (Review Fix 2, fail-closed)', () => {
  it('PM-U17 — nonexistent external payment = 422 RENT_PAYMENT_EXTERNAL_INVALID', async () => {
    const s = makeService(makeRepo({ getBillingPaymentWithOrder: mockFn(async () => null) }));
    await expect(s.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, externalPaymentId: '00000000-0000-4000-8000-000000000001' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_INVALID' } });
    expect(s.db.transaction).not.toHaveBeenCalled();
  });

  it('PM-U18 — an unsuccessful billing payment can never become a completed rent receipt', async () => {
    for (const status of ['created', 'pending', 'processing', 'failed', 'cancelled']) {
      const s = makeService(makeRepo({ getBillingPaymentWithOrder: mockFn(async () => ({ ...billingRow, status })) }));
      await expect(s.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, externalPaymentId: '00000000-0000-4000-8000-000000000001' }, actor))
        .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_NOT_CONFIRMED' } });
    }
  });

  it('PM-U19 — currency and amount must match exactly; order must be paid', async () => {
    const cur = makeService(makeRepo({ getBillingPaymentWithOrder: mockFn(async () => ({ ...billingRow, currency_code: 'EUR' })) }));
    await expect(cur.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, externalPaymentId: '00000000-0000-4000-8000-000000000001' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_CURRENCY_MISMATCH' } });

    const amt = makeService(makeRepo({ getBillingPaymentWithOrder: mockFn(async () => ({ ...billingRow, amount: '1500.0001' })) }));
    await expect(amt.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, externalPaymentId: '00000000-0000-4000-8000-000000000001' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_AMOUNT_MISMATCH' } });

    const ord = makeService(makeRepo({ getBillingPaymentWithOrder: mockFn(async () => ({ ...billingRow, order_status: 'pending' })) }));
    await expect(ord.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, externalPaymentId: '00000000-0000-4000-8000-000000000001' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_ORDER_NOT_PAID' } });
  });

  it('PM-U20 — unrelated or wrong-tenant billing orders are rejected (ownership uses the applicable identity model)', async () => {
    const wrongUser = makeService(makeRepo({ getBillingPaymentWithOrder: mockFn(async () => ({ ...billingRow, order_user_id: 'user-other' })) }));
    await expect(wrongUser.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, externalPaymentId: '00000000-0000-4000-8000-000000000001' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_ORDER_NOT_TENANT_OWNED' } });

    // org-tenant lease: only the order owned by that organization matches
    const orgLease = makeService(makeRepo({
      getLease: mockFn(async () => ({ ...leaseRow, tenant_user_id: null, tenant_organization_id: 'org-2' })),
      getBillingPaymentWithOrder: mockFn(async () => ({ ...billingRow, order_user_id: null, order_organization_id: 'org-9' })),
    }));
    await expect(orgLease.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, externalPaymentId: '00000000-0000-4000-8000-000000000001' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_ORDER_NOT_TENANT_OWNED' } });

    const orgOwned = makeService(makeRepo({
      getLease: mockFn(async () => ({ ...leaseRow, tenant_user_id: null, tenant_organization_id: 'org-2' })),
      getBillingPaymentWithOrder: mockFn(async () => ({ ...billingRow, order_user_id: null, order_organization_id: 'org-2' })),
    }));
    await expect(orgOwned.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, externalPaymentId: '00000000-0000-4000-8000-000000000001' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_PROVENANCE_UNVERIFIABLE' } });
  });

  it('PM-U21 — a fully valid order/payment STILL fails closed: no rent-specific link exists in the frozen billing schema', async () => {
    const s = makeService(); // billingRow: succeeded + paid order + tenant-owned + exact amount/currency
    await expect(s.service.recordRentPayment('lease-1', 'sched-1', { ...recordInput, externalPaymentId: '00000000-0000-4000-8000-000000000001' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_EXTERNAL_PROVENANCE_UNVERIFIABLE' } });
    expect(s.db.transaction).not.toHaveBeenCalled();
    expect(s.repo.insertRentPayment).not.toHaveBeenCalled();
    expect(s.outbox.append).not.toHaveBeenCalled();
    expect(s.audit.append).not.toHaveBeenCalled();
  });
});

describe('RentalService M2 — PG error mapping and atomicity', () => {
  it('PM-U22 — 23505 (0042 unique index) → 409 RENT_PAYMENT_DUPLICATE_EXTERNAL; P0001 → currency 422; 23503 → 409', async () => {
    const dup = makeService(makeRepo({ insertRentPayment: mockFn(async () => { const e = new Error('unique'); (e as any).code = '23505'; throw e; }) }));
    await expect(dup.service.recordRentPayment('lease-1', 'sched-1', recordInput, actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'RENT_PAYMENT_DUPLICATE_EXTERNAL' } });
    expect(dup.outbox.append).not.toHaveBeenCalled();
    expect(dup.audit.append).not.toHaveBeenCalled();

    const trig = makeService(makeRepo({ insertRentPayment: mockFn(async () => { const e = new Error('raise_exception'); (e as any).code = 'P0001'; throw e; }) }));
    await expect(trig.service.recordRentPayment('lease-1', 'sched-1', recordInput, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'RENT_PAYMENT_CURRENCY_MISMATCH' } });

    const fk = makeService(makeRepo({ insertRentPayment: mockFn(async () => { const e = new Error('fk'); (e as any).code = '23503'; throw e; }) }));
    await expect(fk.service.recordRentPayment('lease-1', 'sched-1', recordInput, actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'RENT_PAYMENT_SCHEDULE_CONFLICT' } });
  });

  it('PM-U23 — listing returns exact decimal strings end-to-end', async () => {
    const s = makeService();
    const rows = (await s.service.listRentPayments('lease-1', 'sched-1', actor)) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(typeof rows[0]!['amount']).toBe('string');
    expect(rows[0]!['amount']).toBe('1500.0000');
    expect(rows[0]!['externalPaymentId']).toBeNull();
    expect(rows[0]!['leaseId']).toBe('lease-1');
  });
});
