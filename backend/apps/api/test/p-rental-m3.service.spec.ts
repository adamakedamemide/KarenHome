import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { RentalService, assertNonNegativeDecimalString, assertPositiveDecimalString } from '../src/modules/rental/application/rental.service';
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

function makeRepo(overrides: Record<string, LooseMock> = {}) {
  const repo: Record<string, LooseMock> = {
    getLease: mockFn(async () => ({ ...leaseRow })),
    getLeaseLocked: mockFn(async () => ({ ...leaseRow })), // the locked re-read (same row by default)
    getRentSchedule: mockFn(async () => ({ ...scheduleRow })),
    getRentScheduleLocked: mockFn(async () => ({ ...scheduleRow })),
    countRentPayments: mockFn(async () => 0),
    addRentSchedule: mockFn(async () => ({ ...scheduleRow })),
    amendRentSchedule: mockFn(async (input: any) => ({ ...scheduleRow, due_date: input.dueDate, amount: input.amount })),
    listRentSchedules: mockFn(async () => [{ ...scheduleRow }]),
    listActiveOrganizationIds: mockFn(async () => ['org-1']),
  };
  return Object.assign(repo, overrides);
}

function makeDb() {
  // transaction(fn, ctx) executes fn with a pass-through executor
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
const amendInput = { dueDate: '2030-03-01', amount: '1600.0000' };

beforeEach(() => { jest.clearAllMocks(); });

describe('RentalService M3 — exact non-negative numeric(20,4) schedule amount contract', () => {
  it('M3-U1 — zero is VALID (frozen schedule CHECK is amount >= 0), canonicalized to scale 4', () => {
    expect(assertNonNegativeDecimalString('0')).toBe('0.0000');
    expect(assertNonNegativeDecimalString('0.0000')).toBe('0.0000');
    expect(assertNonNegativeDecimalString('000000000000000000000.0000')).toBe('0.0000');
    expect(assertNonNegativeDecimalString('0.5')).toBe('0.5000');
  });

  it('M3-U2 — maximum precision 9999999999999999.9999 accepted byte-exact; 17 integer digits rejected', () => {
    expect(assertNonNegativeDecimalString('9999999999999999.9999')).toBe('9999999999999999.9999');
    expect(assertNonNegativeDecimalString('00000000000000009999999999999999.9999')).toBe('9999999999999999.9999');
    for (const bad of ['10000000000000000', '10000000000000000.0000', '000000000000000010000000000000000']) {
      try { assertNonNegativeDecimalString(bad); throw new Error(`expected rejection: ${bad}`); } catch (e: any) {
        expect(e.response?.code).toBe('LEASE_SCHEDULE_AMOUNT_INVALID');
        expect(e.status).toBe(422);
        expect(e.response?.message).toMatch(/numeric\(20,4\) range/);
      }
    }
  });

  it('M3-U3 — excess precision (values that would require rounding) rejected, never rounded or truncated', () => {
    for (const bad of ['1.23456', '0.00001', '12.12345']) {
      try { assertNonNegativeDecimalString(bad); throw new Error(`expected rejection: ${bad}`); } catch (e: any) {
        expect(e.response?.code).toBe('LEASE_SCHEDULE_AMOUNT_INVALID');
        expect(e.response?.message).toMatch(/would require rounding/);
      }
    }
    expect(assertNonNegativeDecimalString('12.5')).toBe('12.5000');
    expect(assertNonNegativeDecimalString('12')).toBe('12.0000');
    expect(assertNonNegativeDecimalString('0.0001')).toBe('0.0001');
  });

  it('M3-U4 — shape: signs, exponents, grouping, whitespace, empties, non-strings rejected; leading zeros deterministic', () => {
    for (const bad of ['-1', '-0', '+1.5', '1e5', '1,500', ' 1', '1 ', '', 'abc', '1.', '.5', '1.2.3', '0x10']) {
      try { assertNonNegativeDecimalString(bad as any); throw new Error(`expected rejection: ${bad}`); } catch (e: any) {
        expect(e.response?.code).toBe('LEASE_SCHEDULE_AMOUNT_INVALID');
      }
    }
    try { assertNonNegativeDecimalString(null as any); } catch (e: any) {
      expect(e.response?.code).toBe('LEASE_SCHEDULE_AMOUNT_INVALID');
    }
    // leading zeros are stripped deterministically before the range check
    expect(assertNonNegativeDecimalString('000000000000000000001.5')).toBe('1.5000');
  });

  it('M3-U5 — the schedule validator is deliberately NOT the receipt validator (different frozen CHECK contracts)', () => {
    // zero: schedule-valid, receipt-invalid
    expect(assertNonNegativeDecimalString('0')).toBe('0.0000');
    expect(() => assertPositiveDecimalString('0')).toThrow(/strictly positive/);
    // both share the exactness discipline
    expect(() => assertNonNegativeDecimalString('1.23456')).toThrow(/would require rounding/);
    expect(() => assertPositiveDecimalString('1.23456')).toThrow(/would require rounding/);
  });

  it('M3-U6 — invalid schedule amounts map to the explicit client domain error BEFORE any DB access on BOTH paths', async () => {
    const append = makeService();
    await expect(append.service.addSchedules('lease-1', [{ dueDate: '2030-07-01', amount: '1.23456', currencyCode: 'USD' }], actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_AMOUNT_INVALID' } });
    expect(append.repo.getLease).not.toHaveBeenCalled();
    expect(append.db.transaction).not.toHaveBeenCalled();

    const amend = makeService();
    await expect(amend.service.amendSchedule('lease-1', 'sched-1', { ...amendInput, amount: '10000000000000000' }, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_AMOUNT_INVALID' } });
    expect(amend.repo.getLease).not.toHaveBeenCalled();
    expect(amend.db.transaction).not.toHaveBeenCalled();
  });
});

describe('RentalService M3 — controlled schedule append (A)', () => {
  it('M3-U7 — ACTIVE lease append allowed: locked lease re-read inside the transaction, canonical amount flows into INSERT and audit, no outbox event', async () => {
    const s = makeService();
    const rows = (await s.service.addSchedules('lease-1', [
      { dueDate: '2030-07-01', amount: '1750.5', currencyCode: 'USD' },
    ], actor)) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    // the lease row is re-read and LOCKED inside the transaction — the active-state
    // decision never relies on the unlocked pre-read
    expect(s.repo.getLeaseLocked).toHaveBeenCalledWith('lease-1', expect.anything());
    // exact canonical value into persistence
    expect(s.repo.addRentSchedule).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: 'lease-1', dueDate: '2030-07-01', amount: '1750.5000', currencyCode: 'USD',
    }));
    // audit: actor, org, lease ID, due date, exact amount, currency — one audit record, no event
    expect(s.audit.append).toHaveBeenCalledTimes(1);
    expect(s.audit.append.mock.calls[0]![0]).toMatchObject({
      action: 'rental.schedules_added', entityType: 'rental.lease', entityId: 'lease-1',
      afterData: { leaseId: 'lease-1', leaseStatusAtAdd: 'active', currencyCode: 'USD', count: 1, items: [{ dueDate: '2030-07-01', amount: '1750.5000', currencyCode: 'USD' }] },
    });
    expect(s.outbox.append).not.toHaveBeenCalled(); // schedule changes stay audit-only (M1 precedent)
  });

  it('M3-U8 — pre-commencement behavior unchanged: draft and pending_signature keep appending (locked read runs for every append)', async () => {
    for (const status of ['draft', 'pending_signature']) {
      const s = makeService(makeRepo({ getLease: mockFn(async () => ({ ...leaseRow, status })), getLeaseLocked: mockFn(async () => ({ ...leaseRow, status })) }));
      await expect(s.service.addSchedules('lease-1', [{ dueDate: '2030-07-01', amount: '1', currencyCode: 'USD' }], actor))
        .resolves.toBeTruthy();
      expect(s.repo.addRentSchedule).toHaveBeenCalledTimes(1);
      expect(s.audit.append.mock.calls[0]![0]).toMatchObject({ action: 'rental.schedules_added', afterData: { leaseStatusAtAdd: status } });
    }
  });

  it('M3-U9 — closed-lease rejection: expired | terminated | cancelled reject additions with 422 LEASE_NOT_MUTABLE — no transaction, no insert, no audit', async () => {
    for (const status of ['expired', 'terminated', 'cancelled']) {
      const s = makeService(makeRepo({ getLease: mockFn(async () => ({ ...leaseRow, status })) }));
      await expect(s.service.addSchedules('lease-1', [{ dueDate: '2030-07-01', amount: '1', currencyCode: 'USD' }], actor))
        .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_NOT_MUTABLE' } });
      expect(s.db.transaction).not.toHaveBeenCalled();
      expect(s.repo.addRentSchedule).not.toHaveBeenCalled();
      expect(s.audit.append).not.toHaveBeenCalled();
    }
  });

  it('M3-U10 — a concurrent lifecycle move that commits first is honored via the LOCKED re-read: the locked row decides, never the pre-read', async () => {
    // the unlocked pre-read says active, but the row moved to terminated before the lock — the lock wins
    const s = makeService(makeRepo({
      getLease: mockFn(async () => ({ ...leaseRow, status: 'active' })),
      getLeaseLocked: mockFn(async () => ({ ...leaseRow, status: 'terminated' })),
    }));
    await expect(s.service.addSchedules('lease-1', [{ dueDate: '2030-07-01', amount: '1', currencyCode: 'USD' }], actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_NOT_MUTABLE' } });
    expect(s.repo.addRentSchedule).not.toHaveBeenCalled();
    expect(s.audit.append).not.toHaveBeenCalled();
  });

  it('M3-U11 — currency must equal the LOCKED lease currency (mismatch rejected; no conversion)', async () => {
    const s = makeService();
    await expect(s.service.addSchedules('lease-1', [{ dueDate: '2030-07-01', amount: '1', currencyCode: 'EUR' }], actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_CURRENCY_MISMATCH' } });
    expect(s.db.transaction).not.toHaveBeenCalled();
    // mismatch detected under the lock too (the locked row is the authority)
    const locked = makeService(makeRepo({ getLeaseLocked: mockFn(async () => ({ ...leaseRow, currency_code: 'EUR' })) }));
    await expect(locked.service.addSchedules('lease-1', [{ dueDate: '2030-07-01', amount: '1', currencyCode: 'USD' }], actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_CURRENCY_MISMATCH' } });
    expect(locked.repo.addRentSchedule).not.toHaveBeenCalled();
    expect(locked.audit.append).not.toHaveBeenCalled();
  });

  it('M3-U12 — duplicate (lease_id, due_date) → frozen UNIQUE authority → 409 LEASE_SCHEDULE_DUPLICATE; batch is atomic', async () => {
    const dup = new Error('duplicate'); (dup as any).code = '23505';
    const s = makeService(makeRepo({ addRentSchedule: mockFn(async () => { throw dup; }) }));
    await expect(s.service.addSchedules('lease-1', [{ dueDate: '2030-07-01', amount: '1', currencyCode: 'USD' }], actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_SCHEDULE_DUPLICATE' } });
    expect(s.audit.append).not.toHaveBeenCalled(); // failed tx: no audit record
  });

  it('M3-U13 — permission matrix and org isolation on the append path', async () => {
    const denied = makeService(undefined, { permissions: ['rental.view'] });
    await expect(denied.service.addSchedules('lease-1', [{ dueDate: '2030-07-01', amount: '1', currencyCode: 'USD' }], actor))
      .rejects.toMatchObject({ status: 403 });
    expect(denied.iam.listPermissionCodesForUser).toHaveBeenCalledWith(actor.id, 'org-1');
    const manager = makeService(undefined, { permissions: ['rental.manage'] });
    await expect(manager.service.addSchedules('lease-1', [{ dueDate: '2030-07-01', amount: '1', currencyCode: 'USD' }], actor))
      .resolves.toBeTruthy(); // rental.manage implies rental.update
    const outsider = makeService(undefined, { member: false });
    await expect(outsider.service.addSchedules('lease-1', [{ dueDate: '2030-07-01', amount: '1', currencyCode: 'USD' }], actor))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_NOT_FOUND' } }); // no existence leak
    expect(outsider.db.transaction).not.toHaveBeenCalled();
  });
});

describe('RentalService M3 — pristine schedule amendment (B)', () => {
  it('M3-U14 — pristine amendment on an ACTIVE lease: locks lease + schedule under consistent ordering, replaces dueDate + amount, before/after audit, no outbox event', async () => {
    const s = makeService();
    const amended = (await s.service.amendSchedule('lease-1', 'sched-1', amendInput, actor)) as Record<string, unknown>;
    expect(amended['dueDate']).toBe('2030-03-01');
    expect(amended['amount']).toBe('1600.0000');
    expect(amended['currencyCode']).toBe('USD'); // currency immutable
    // lock order: lease row first, then the schedule row
    expect(s.repo.getLeaseLocked).toHaveBeenCalledWith('lease-1', expect.anything());
    expect(s.repo.getRentScheduleLocked).toHaveBeenCalledWith('lease-1', 'sched-1', expect.anything());
    expect(s.repo.countRentPayments).toHaveBeenCalledWith('sched-1', expect.anything());
    // exact canonical replacement values into the UPDATE
    expect(s.repo.amendRentSchedule).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: 'lease-1', scheduleId: 'sched-1', dueDate: '2030-03-01', amount: '1600.0000',
    }));
    // before/after audit in the SAME transaction; no outbox event (M1 precedent)
    expect(s.audit.append).toHaveBeenCalledTimes(1);
    expect(s.audit.append.mock.calls[0]![0]).toMatchObject({
      action: 'rental.schedule_amended', entityType: 'rental.lease_schedule', entityId: 'sched-1',
      beforeData: { leaseId: 'lease-1', scheduleId: 'sched-1', dueDate: '2030-02-01', amount: '1500.0000', currencyCode: 'USD', status: 'scheduled', paidAt: null },
      afterData: { leaseId: 'lease-1', scheduleId: 'sched-1', dueDate: '2030-03-01', amount: '1600.0000', currencyCode: 'USD', status: 'scheduled', paidAt: null },
    });
    expect(s.outbox.append).not.toHaveBeenCalled();
  });

  it('M3-U15 — amendment also allowed on draft | pending_signature leases (pristine row)', async () => {
    for (const status of ['draft', 'pending_signature']) {
      const s = makeService(makeRepo({
        getLease: mockFn(async () => ({ ...leaseRow, status })),
        getLeaseLocked: mockFn(async () => ({ ...leaseRow, status })),
      }));
      await expect(s.service.amendSchedule('lease-1', 'sched-1', amendInput, actor)).resolves.toBeTruthy();
    }
  });

  it('M3-U16 — closed-lease amendment rejected: 422 LEASE_SCHEDULE_NOT_AMENDABLE — no transaction, no mutation, no audit', async () => {
    for (const status of ['expired', 'terminated', 'cancelled']) {
      const s = makeService(makeRepo({ getLease: mockFn(async () => ({ ...leaseRow, status })) }));
      await expect(s.service.amendSchedule('lease-1', 'sched-1', amendInput, actor))
        .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_NOT_AMENDABLE' } });
      expect(s.db.transaction).not.toHaveBeenCalled();
      expect(s.repo.amendRentSchedule).not.toHaveBeenCalled();
      expect(s.audit.append).not.toHaveBeenCalled();
    }
  });

  it('M3-U17 — every prohibited schedule state rejected (never reopened or modified)', async () => {
    for (const status of ['pending', 'late', 'partially_paid', 'paid', 'waived', 'cancelled']) {
      const s = makeService(makeRepo({ getRentSchedule: mockFn(async () => ({ ...scheduleRow, status })), getRentScheduleLocked: mockFn(async () => ({ ...scheduleRow, status })) }));
      await expect(s.service.amendSchedule('lease-1', 'sched-1', amendInput, actor))
        .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_NOT_AMENDABLE' } });
      expect(s.db.transaction).not.toHaveBeenCalled();
      expect(s.repo.amendRentSchedule).not.toHaveBeenCalled();
      expect(s.audit.append).not.toHaveBeenCalled();
    }
  });

  it('M3-U18 — pristine violations under the locks: a schedule that moved to paid (pre-read stale) or carries receipts is rejected — the locked row decides', async () => {
    // locked row re-read says the schedule became 'partially_paid' after the pre-read
    const moved = makeService(makeRepo({
      getRentScheduleLocked: mockFn(async () => ({ ...scheduleRow, status: 'partially_paid' })),
    }));
    await expect(moved.service.amendSchedule('lease-1', 'sched-1', amendInput, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_NOT_AMENDABLE' } });
    expect(moved.repo.amendRentSchedule).not.toHaveBeenCalled();
    expect(moved.audit.append).not.toHaveBeenCalled();

    // receipts exist under the lock (checked in the SAME transaction)
    const receipted = makeService(makeRepo({ countRentPayments: mockFn(async () => 2) }));
    await expect(receipted.service.amendSchedule('lease-1', 'sched-1', amendInput, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_NOT_AMENDABLE' } });
    expect(receipted.repo.amendRentSchedule).not.toHaveBeenCalled();
    expect(receipted.audit.append).not.toHaveBeenCalled();

    // paid_at set on the locked row
    const paidAt = makeService(makeRepo({ getRentScheduleLocked: mockFn(async () => ({ ...scheduleRow, paid_at: now })) }));
    await expect(paidAt.service.amendSchedule('lease-1', 'sched-1', amendInput, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_NOT_AMENDABLE' } });
    expect(paidAt.repo.amendRentSchedule).not.toHaveBeenCalled();
  });

  it('M3-U19 — unknown lease / unknown schedule / hierarchy discipline (404, no leak); out-of-org 404; permission matrix', async () => {
    const missingLease = makeService(makeRepo({ getLease: mockFn(async () => null) }));
    await expect(missingLease.service.amendSchedule('lease-x', 'sched-1', amendInput, actor))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_NOT_FOUND' } });

    const missingSchedule = makeService(makeRepo({ getRentSchedule: mockFn(async () => null) }));
    await expect(missingSchedule.service.amendSchedule('lease-1', 'sched-x', amendInput, actor))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_SCHEDULE_NOT_FOUND' } });

    const outsider = makeService(undefined, { member: false });
    await expect(outsider.service.amendSchedule('lease-1', 'sched-1', amendInput, actor))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_NOT_FOUND' } });
    expect(outsider.db.transaction).not.toHaveBeenCalled();

    const denied = makeService(undefined, { permissions: ['rental.view'] });
    await expect(denied.service.amendSchedule('lease-1', 'sched-1', amendInput, actor))
      .rejects.toMatchObject({ status: 403 });
    const manager = makeService(undefined, { permissions: ['rental.manage'] });
    await expect(manager.service.amendSchedule('lease-1', 'sched-1', amendInput, actor)).resolves.toBeTruthy();
  });

  it('M3-U20 — amendment PG error mapping: duplicate date 23505 → 409 LEASE_SCHEDULE_DUPLICATE; CHECK 23514 → 422 RANGE_INVALID; no audit on failure', async () => {
    const dup = new Error('duplicate'); (dup as any).code = '23505';
    const s = makeService(makeRepo({ amendRentSchedule: mockFn(async () => { throw dup; }) }));
    await expect(s.service.amendSchedule('lease-1', 'sched-1', amendInput, actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_SCHEDULE_DUPLICATE' } });
    expect(s.audit.append).not.toHaveBeenCalled();

    const range = new Error('check'); (range as any).code = '23514';
    const s2 = makeService(makeRepo({ amendRentSchedule: mockFn(async () => { throw range; }) }));
    await expect(s2.service.amendSchedule('lease-1', 'sched-1', amendInput, actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_SCHEDULE_RANGE_INVALID' } });
    expect(s2.audit.append).not.toHaveBeenCalled();
  });

  it('M3-U21 — deletion semantics preserved: ACTIVE lease schedule deletion still rejected with 422 LEASE_NOT_MUTABLE (no active-lease deletion in M3)', async () => {
    const s = makeService();
    await expect(s.service.removeSchedule('lease-1', 'sched-1', actor))
      .rejects.toMatchObject({ status: 422, response: { code: 'LEASE_NOT_MUTABLE' } });
    expect(s.db.transaction).not.toHaveBeenCalled();
    expect(s.audit.append).not.toHaveBeenCalled();
  });
});
