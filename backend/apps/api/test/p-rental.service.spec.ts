import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { RentalService } from '../src/modules/rental/application/rental.service';
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
  status: 'draft', currency_code: 'USD', monthly_rent: '1500.0000', deposit_amount: null,
  start_date: '2030-01-01', end_date: '2030-06-30', auto_renew: false,
  created_at: now, updated_at: now,
};
const partyRow = {
  id: 'party-1', lease_id: 'lease-1', role: 'tenant', user_id: 'user-2', organization_id: null,
  name_snapshot: 'Tenant One', contact_snapshot: {},
};
const scheduleRow = {
  id: 'sched-1', lease_id: 'lease-1', due_date: '2030-02-01', amount: '1500.0000',
  currency_code: 'USD', status: 'scheduled', paid_at: null,
};

function makeRepo(overrides: Record<string, LooseMock> = {}) {
  const repo: Record<string, LooseMock> = {
    getProperty: mockFn(async () => ({ id: 'prop-1' })),
    getListing: mockFn(async () => ({ id: 'list-1' })),
    getContract: mockFn(async () => ({ id: 'contract-1' })),
    getUser: mockFn(async () => ({ id: 'user-2' })),
    getOrganization: mockFn(async () => ({ id: 'org-9' })),
    listActiveOrganizationIds: mockFn(async () => ['org-1']),
    createLease: mockFn(async () => ({ ...leaseRow })),
    getLease: mockFn(async () => ({ ...leaseRow })),
    listLeases: mockFn(async () => [{ ...leaseRow }]),
    updateLeaseMeta: mockFn(async () => ({ ...leaseRow, monthly_rent: '1600.0000' })),
    updateLeaseStatus: mockFn(async () => ({ ...leaseRow, status: 'pending_signature' })),
    listOverlappingLeases: mockFn(async () => []),
    addLeaseParty: mockFn(async () => ({ ...partyRow })),
    listLeaseParties: mockFn(async () => [{ ...partyRow }]),
    addRentSchedule: mockFn(async () => ({ ...scheduleRow })),
    listRentSchedules: mockFn(async () => [{ ...scheduleRow }]),
    getRentSchedule: mockFn(async () => ({ ...scheduleRow })),
    deleteRentSchedule: mockFn(async () => ({ ...scheduleRow })),
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
    listPermissionCodesForUser: mockFn(async () => iamOpts.permissions ?? ['rental.view', 'rental.create', 'rental.update']),
    isActiveOrganizationMember: mockFn(async () => iamOpts.member ?? true),
  };
  const db = makeDb();
  const service = new RentalService(repo as never, outbox as never, audit as never, iam as never, db as never);
  return { service, repo, outbox, audit, iam, db };
}

const actor = { id: 'user-1', status: 'active' } as AuthenticatedUser;

const createInput = {
  organizationId: 'org-1', propertyId: 'prop-1', tenantUserId: 'user-2',
  currencyCode: 'USD', monthlyRent: '1500.0000', startDate: '2030-01-01', endDate: '2030-06-30',
};

beforeEach(() => { jest.clearAllMocks(); });

describe('RentalService — permission matrix (0041 vocabulary)', () => {
  it('R1 — create requires rental.create scoped to the landlord org', async () => {
    const s = makeService(undefined, { permissions: ['rental.view'] });
    await expect(s.service.createLease(createInput, actor)).rejects.toMatchObject({ status: 403 });
    expect(s.iam.listPermissionCodesForUser).toHaveBeenCalledWith(actor.id, 'org-1');
  });

  it('R2 — rental.manage implies view/create/update', async () => {
    const s = makeService(undefined, { permissions: ['rental.manage'] });
    const created = (await s.service.createLease(createInput, actor)) as Record<string, unknown>;
    expect(created['id']).toBe('lease-1');
    const got = (await s.service.getLease('lease-1', actor)) as Record<string, unknown>;
    expect(got['id']).toBe('lease-1');
  });

  it('R3 — create without org membership = 404 ORG_NOT_FOUND (no existence leak)', async () => {
    const s = makeService(undefined, { member: false });
    await expect(s.service.createLease(createInput, actor))
      .rejects.toMatchObject({ status: 404, response: { code: 'ORG_NOT_FOUND' } });
  });
});

describe('RentalService — creation rules', () => {
  it('R4 — unknown property = 404 PROPERTY_NOT_FOUND', async () => {
    const s = makeService(makeRepo({ getProperty: mockFn(async () => null) }));
    await expect(s.service.createLease(createInput, actor))
      .rejects.toMatchObject({ response: { code: 'PROPERTY_NOT_FOUND' } });
  });

  it('R5 — tenant XOR enforced: neither and both are 422', async () => {
    const neither = makeService();
    await expect(neither.service.createLease({ ...createInput, tenantUserId: undefined }, actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_TENANT_PARTY_INVALID' } });
    const both = makeService();
    await expect(both.service.createLease({ ...createInput, tenantOrganizationId: 'org-9' }, actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_TENANT_PARTY_INVALID' } });
  });

  it('R6 — invalid source listing / contract / tenant identity = 422 (no FK surprises)', async () => {
    const s = makeService(makeRepo({
      getListing: mockFn(async () => null),
      getContract: mockFn(async () => ({ id: 'contract-1' })),
    }));
    await expect(s.service.createLease({ ...createInput, sourceListingId: '00000000-0000-4000-8000-000000000001' }, actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_LISTING_INVALID' } });
    const s2 = makeService(makeRepo({ getContract: mockFn(async () => null) }));
    await expect(s2.service.createLease({ ...createInput, contractId: '00000000-0000-4000-8000-000000000002' }, actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_CONTRACT_INVALID' } });
    const s3 = makeService(makeRepo({ getUser: mockFn(async () => null) }));
    await expect(s3.service.createLease(createInput, actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_TENANT_IDENTITY_INVALID' } });
  });

  it('R7 — create writes LeaseCreated.v1 + audit in the SAME transaction; money stays a string', async () => {
    const s = makeService();
    const created = (await s.service.createLease(createInput, actor)) as Record<string, unknown>;
    expect(created['monthlyRent']).toBe('1500.0000');
    expect(typeof created['monthlyRent']).toBe('string');
    expect(created['startDate']).toBe('2030-01-01');
    expect(s.outbox.append).toHaveBeenCalledTimes(1);
    expect(s.outbox.append.mock.calls[0]![0]).toMatchObject({ aggregateType: 'rental_lease', eventType: 'LeaseCreated.v1', eventVersion: 1 });
    expect(s.audit.append).toHaveBeenCalledTimes(1);
    expect(s.audit.append.mock.calls[0]![0]).toMatchObject({ action: 'rental.lease_created', entityType: 'rental.lease' });
  });
});

describe('RentalService — lifecycle transitions (application matrix; DB stays authority for vocabulary/overlap)', () => {
  it('R8 — valid chain draft → pending_signature → active → expired emits status events + audit each step', async () => {
    const repo = makeRepo({
      updateLeaseStatus: mockFn(async (input: any) => ({ ...leaseRow, status: input.toStatus })),
    });
    repo.getLease = mockFn()
      .mockImplementationOnce(async () => ({ ...leaseRow, status: 'draft' }))
      .mockImplementationOnce(async () => ({ ...leaseRow, status: 'pending_signature' }))
      .mockImplementationOnce(async () => ({ ...leaseRow, status: 'active' }));
    const s = makeService(repo);
    const first = (await s.service.changeLeaseStatus('lease-1', 'pending_signature', actor)) as Record<string, unknown>;
    expect(first['status']).toBe('pending_signature');
    const second = (await s.service.changeLeaseStatus('lease-1', 'active', actor)) as Record<string, unknown>;
    expect(second['status']).toBe('active');
    const third = (await s.service.changeLeaseStatus('lease-1', 'expired', actor)) as Record<string, unknown>;
    expect(third['status']).toBe('expired');
    expect(s.outbox.append).toHaveBeenCalledTimes(3);
    for (const call of s.outbox.append.mock.calls) {
      expect(call[0]).toMatchObject({ aggregateType: 'rental_lease', eventType: 'LeaseStatusChanged.v1', eventVersion: 1 });
    }
    expect(s.audit.append).toHaveBeenCalledTimes(3);
    expect(s.audit.append.mock.calls[2]![0]).toMatchObject({ action: 'rental.lease_status_changed', beforeData: { status: 'active' }, afterData: { status: 'expired' } });
  });

  it('R9 — invalid transitions are 422: unknown status, back to draft, illegal jumps, terminal states, no-op', async () => {
    const s = makeService(makeRepo({
      getLease: mockFn(async () => ({ ...leaseRow, status: 'active' })),
    }));
    await expect(s.service.changeLeaseStatus('lease-1', 'suspended', actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_UNKNOWN_STATUS' } });
    await expect(s.service.changeLeaseStatus('lease-1', 'draft', actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_INVALID_TRANSITION' } });
    await expect(s.service.changeLeaseStatus('lease-1', 'pending_signature', actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_INVALID_TRANSITION' } });
    await expect(s.service.changeLeaseStatus('lease-1', 'active', actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_NO_OP_TRANSITION' } });
    const terminal = makeService(makeRepo({
      getLease: mockFn(async () => ({ ...leaseRow, status: 'terminated' })),
    }));
    await expect(terminal.service.changeLeaseStatus('lease-1', 'active', actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_INVALID_TRANSITION' } });
  });

  it('R10 — CAS loser (0 rows) maps to 409 LEASE_STATUS_CONFLICT and emits NOTHING', async () => {
    const s = makeService(makeRepo({
      getLease: mockFn(async () => ({ ...leaseRow, status: 'pending_signature' })),
      updateLeaseStatus: mockFn(async () => null),
    }));
    await expect(s.service.changeLeaseStatus('lease-1', 'active', actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_STATUS_CONFLICT' } });
    expect(s.outbox.append).not.toHaveBeenCalled();
    expect(s.audit.append).not.toHaveBeenCalled();
  });

  it('R11 — DB overlap exclusion (23P01) on activation maps to 409 LEASE_OVERLAP_CONFLICT', async () => {
    const s = makeService(makeRepo({
      getLease: mockFn(async () => ({ ...leaseRow, status: 'pending_signature' })),
      updateLeaseStatus: mockFn(async () => { const e = new Error('exclusion violation'); (e as any).code = '23P01'; throw e; }),
    }));
    await expect(s.service.changeLeaseStatus('lease-1', 'active', actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_OVERLAP_CONFLICT' } });
    expect(s.outbox.append).not.toHaveBeenCalled();
  });
});

describe('RentalService — mutability window and updates', () => {
  it('R12 — meta/parties/schedules are 422 LEASE_NOT_MUTABLE once active/expired/terminated/cancelled', async () => {
    for (const status of ['active', 'expired', 'terminated', 'cancelled']) {
      const s = makeService(makeRepo({ getLease: mockFn(async () => ({ ...leaseRow, status })) }));
      await expect(s.service.updateLease('lease-1', { monthlyRent: '1700' }, actor))
        .rejects.toMatchObject({ response: { code: 'LEASE_NOT_MUTABLE' } });
      await expect(s.service.addParties('lease-1', [{ role: 'agent', userId: 'user-2', nameSnapshot: 'A' }], actor))
        .rejects.toMatchObject({ response: { code: 'LEASE_NOT_MUTABLE' } });
      await expect(s.service.addSchedules('lease-1', [{ dueDate: '2030-02-01', amount: '10', currencyCode: 'USD' }], actor))
        .rejects.toMatchObject({ response: { code: 'LEASE_NOT_MUTABLE' } });
      await expect(s.service.removeSchedule('lease-1', 'sched-1', actor))
        .rejects.toMatchObject({ response: { code: 'LEASE_NOT_MUTABLE' } });
    }
  });

  it('R13 — empty update = 422 LEASE_NO_CHANGES; effective date pair pre-checked (422)', async () => {
    const s = makeService();
    await expect(s.service.updateLease('lease-1', {}, actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_NO_CHANGES' } });
    await expect(s.service.updateLease('lease-1', { endDate: '2029-12-31' }, actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_DATE_RANGE_INVALID' } });
  });

  it('R14 — raced mutability guard (0 rows) maps to 409 LEASE_CONCURRENT_MODIFICATION; audit carries before/after', async () => {
    const s = makeService(makeRepo({ updateLeaseMeta: mockFn(async () => null) }));
    await expect(s.service.updateLease('lease-1', { monthlyRent: '1600' }, actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_CONCURRENT_MODIFICATION' } });
    const s2 = makeService();
    await s2.service.updateLease('lease-1', { monthlyRent: '1600.0000' }, actor);
    expect(s2.audit.append.mock.calls[0]![0]).toMatchObject({
      action: 'rental.lease_updated',
      beforeData: { monthlyRent: '1500.0000' },
      afterData: { monthlyRent: '1600.0000' },
    });
  });
});

describe('RentalService — schedules (exact decimal, currency consistency)', () => {
  it('R15 — schedule currency must equal the lease currency (422, no conversion)', async () => {
    const s = makeService();
    await expect(s.service.addSchedules('lease-1', [{ dueDate: '2030-02-01', amount: '1500.0000', currencyCode: 'EUR' }], actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_SCHEDULE_CURRENCY_MISMATCH' } });
    expect(s.repo.addRentSchedule).not.toHaveBeenCalled();
  });

  it('R16 — 23505 duplicate → 409; 23514 range → 422; RESTRICT 23503 on delete → 409 LEASE_SCHEDULE_IN_USE', async () => {
    const dup = new Error('duplicate'); (dup as any).code = '23505';
    const s = makeService(makeRepo({ addRentSchedule: mockFn(async () => { throw dup; }) }));
    await expect(s.service.addSchedules('lease-1', [{ dueDate: '2030-02-01', amount: '1', currencyCode: 'USD' }], actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_SCHEDULE_DUPLICATE' } });
    const range = new Error('check'); (range as any).code = '23514';
    const s2 = makeService(makeRepo({ addRentSchedule: mockFn(async () => { throw range; }) }));
    await expect(s2.service.addSchedules('lease-1', [{ dueDate: '2030-02-01', amount: '-1', currencyCode: 'USD' }], actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_SCHEDULE_RANGE_INVALID' } });
    const restrict = new Error('foreign key'); (restrict as any).code = '23503';
    const s3 = makeService(makeRepo({ deleteRentSchedule: mockFn(async () => { throw restrict; }) }));
    await expect(s3.service.removeSchedule('lease-1', 'sched-1', actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_SCHEDULE_IN_USE' } });
  });

  it('R17 — schedule delete records the removed snapshot in audit; unknown schedule = 404', async () => {
    const s = makeService();
    await s.service.removeSchedule('lease-1', 'sched-1', actor);
    expect(s.audit.append.mock.calls[0]![0]).toMatchObject({
      action: 'rental.schedule_removed', entityType: 'rental.lease_schedule', entityId: 'sched-1',
    });
    const s2 = makeService(makeRepo({ getRentSchedule: mockFn(async () => null) }));
    await expect(s2.service.removeSchedule('lease-1', 'sched-x', actor))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_SCHEDULE_NOT_FOUND' } });
  });
});

describe('RentalService — scoping / IDOR', () => {
  it('R18 — out-of-org access on every read/mutation = 404 LEASE_NOT_FOUND (no existence leak)', async () => {
    const s = makeService(undefined, { member: false });
    for (const act of [
      (svc: RentalService) => svc.getLease('lease-1', actor),
      (svc: RentalService) => svc.updateLease('lease-1', { monthlyRent: '1' }, actor),
      (svc: RentalService) => svc.changeLeaseStatus('lease-1', 'active', actor),
      (svc: RentalService) => svc.listParties('lease-1', actor),
      (svc: RentalService) => svc.addSchedules('lease-1', [{ dueDate: '2030-02-01', amount: '1', currencyCode: 'USD' }], actor),
      (svc: RentalService) => svc.removeSchedule('lease-1', 'sched-1', actor),
    ]) {
      await expect(act(s.service)).rejects.toMatchObject({ status: 404, response: { code: 'LEASE_NOT_FOUND' } });
    }
  });

  it('R19 — listing without organizationId uses member-orgs root; no root resolves to empty scope', async () => {
    const s = makeService(makeRepo({ listActiveOrganizationIds: mockFn(async () => ['org-1']) }));
    await s.service.listLeases(actor, {});
    expect(s.repo.listLeases).toHaveBeenCalledWith({ memberOrganizationIds: ['org-1'], propertyId: undefined, status: undefined, limit: undefined });
    const s2 = makeService(makeRepo({ listActiveOrganizationIds: mockFn(async () => []) }));
    await s2.service.listLeases(actor, {});
    expect(s2.repo.listLeases).toHaveBeenCalledWith({ memberOrganizationIds: [], propertyId: undefined, status: undefined, limit: undefined });
  });

  it('R20 — party identity XOR + unknown identities rejected with 422 before any write', async () => {
    const s = makeService();
    await expect(s.service.addParties('lease-1', [{ role: 'agent', userId: 'user-2', organizationId: 'org-9', nameSnapshot: 'X' }], actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_PARTY_IDENTITY_INVALID' } });
    await expect(s.service.addParties('lease-1', [{ role: 'agent', nameSnapshot: 'X' }], actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_PARTY_IDENTITY_INVALID' } });
    expect(s.repo.addLeaseParty).not.toHaveBeenCalled();
  });
});

describe('RentalService — conflict types are HttpExceptions with the right status', () => {
  it('R21 — overlap and duplicate conflicts are ConflictException (409), constraint issues 422', () => {
    const overlap = (RentalService as any).mapLeaseWriteError(Object.assign(new Error('x'), { code: '23P01' }));
    expect(overlap.getStatus()).toBe(409);
    const constraint = (RentalService as any).mapLeaseWriteError(Object.assign(new Error('x'), { code: '23514' }));
    expect(constraint.getStatus()).toBe(422);
    const dup = (RentalService as any).mapScheduleWriteError(Object.assign(new Error('x'), { code: '23505' }));
    expect(dup.getStatus()).toBe(409);
  });
});
