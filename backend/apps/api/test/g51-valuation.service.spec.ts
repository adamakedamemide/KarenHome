import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ValuationService } from '../src/modules/valuation/application/valuation.service';
import type { AuthenticatedUser } from '@platform/contracts';

type LooseMock = jest.Mock & any;
function mockFn(impl?: (...args: any[]) => any): LooseMock {
  return (impl ? jest.fn(impl) : jest.fn()) as LooseMock;
}

const now = new Date();
const caseRow = {
  id: 'case-1', property_id: 'prop-1', requested_by_user_id: 'user-1', status: 'requested',
  method: 'comparables', model_version: null, organization_id: 'org-1',
  requested_at: now, completed_at: null, expires_at: null, updated_at: now,
};
const resultRow = {
  id: 'res-1', case_id: 'case-1', min_value: '100000.0000', estimated_value: '150000.0000',
  max_value: '200000.0000', currency_code: 'USD', confidence: '82.50', price_per_m2: '1500.0000',
  generated_at: now,
};
const comparableRow = {
  valuation_result_id: 'res-1', comparable_property_id: 'prop-2', comparable_listing_id: null,
  similarity_score: '91.00', distance_m: '350.25', adjusted_price: '148000.0000', currency_code: 'USD',
};

function makeRepo(overrides: Record<string, LooseMock> = {}) {
  const repo: Record<string, LooseMock> = {
    getProperty: mockFn(async () => ({ id: 'prop-1' })),
    getListing: mockFn(async () => ({ id: 'list-1' })),
    listActiveOrganizationIds: mockFn(async () => ['org-1']),
    createCase: mockFn(async () => ({ ...caseRow })),
    getCase: mockFn(async () => ({ ...caseRow })),
    listCases: mockFn(async () => [{ ...caseRow }]),
    updateCaseMeta: mockFn(async () => ({ ...caseRow, method: 'income' })),
    updateCaseStatus: mockFn(async () => ({ ...caseRow, status: 'processing' })),
    getResultByCaseId: mockFn(async () => ({ ...resultRow })),
    upsertResult: mockFn(async () => ({ ...resultRow })),
    listComparables: mockFn(async () => [{ ...comparableRow }]),
    addComparable: mockFn(async () => ({ ...comparableRow })),
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
    listPermissionCodesForUser: mockFn(async () => iamOpts.permissions ?? ['valuation.view', 'valuation.create', 'valuation.update', 'valuation.finalize']),
    isActiveOrganizationMember: mockFn(async () => iamOpts.member ?? true),
  };
  const db = makeDb();
  const service = new ValuationService(repo as never, outbox as never, audit as never, iam as never, db as never);
  return { service, repo, outbox, audit, iam, db };
}

const full: AuthenticatedUser = { id: 'user-1', status: 'active' } as AuthenticatedUser;

describe('G5.1 Valuation service (unit, mocked repositories)', () => {
  beforeEach(async () => { jest.clearAllMocks(); });

  it('V1 — createCase requires valuation.create (view-only member is forbidden)', async () => {
    const { service } = makeService(makeRepo(), { permissions: ['valuation.view'] });
    await expect(service.createCase({ organizationId: 'org-1', propertyId: 'prop-1' }, full))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('V2 — createCase: unknown org 404 (no membership), missing property 404', async () => {
    const { service } = makeService(makeRepo(), { member: false });
    await expect(service.createCase({ organizationId: 'org-x', propertyId: 'prop-1' }, full))
      .rejects.toMatchObject({ response: { code: 'ORG_NOT_FOUND' } });
    const { service: s2 } = makeService(makeRepo({ getProperty: mockFn(async () => null) }));
    await expect(s2.createCase({ organizationId: 'org-1', propertyId: 'prop-x' }, full))
      .rejects.toMatchObject({ response: { code: 'PROPERTY_NOT_FOUND' } });
  });

  it('V3 — createCase success writes ValuationRequested.v1 + audit in the same transaction', async () => {
    const { service, outbox, audit, db } = makeService();
    const created = await service.createCase({ organizationId: 'org-1', propertyId: 'prop-1', method: 'comparables' }, full) as { status: string };
    expect(created.status).toBe('requested');
    expect(outbox.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ValuationRequested.v1', eventVersion: 1, aggregateType: 'valuation_case' }), expect.anything());
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'valuation.case_created' }), expect.anything());
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('V4 — out-of-org member gets 404 without leak on every case path', async () => {
    const { service } = makeService(makeRepo(), { member: false });
    const outsider = { id: 'user-9', status: 'active' } as AuthenticatedUser;
    await expect(service.getCase('case-1', outsider)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.changeCaseStatus('case-1', 'processing', outsider)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.recordResult('case-1', { minValue: '1', estimatedValue: '2', maxValue: '3', currencyCode: 'USD' }, outsider)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.addComparables('case-1', [{ comparablePropertyId: 'prop-2' }], outsider)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateCaseMeta('case-1', { method: 'income' }, outsider)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('V5 — original requester can read their case even without membership, but cannot mutate', async () => {
    const { service } = makeService(makeRepo(), { member: false, permissions: ['valuation.view'] });
    const got = await service.getCase('case-1', full) as { id: string };
    expect(got.id).toBe('case-1');
    await expect(service.changeCaseStatus('case-1', 'processing', full)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('V6 — lifecycle permission matrix: finalize requires valuation.finalize, not valuation.update', async () => {
    const { service } = makeService(
      makeRepo({ getCase: mockFn(async () => ({ ...caseRow, status: 'processing' })) }),
      { permissions: ['valuation.view', 'valuation.update'] },
    );
    await expect(service.changeCaseStatus('case-1', 'completed', full))
      .rejects.toBeInstanceOf(ForbiddenException);
    const { service: s2 } = makeService(
      makeRepo({ getCase: mockFn(async () => ({ ...caseRow, status: 'processing' })) }),
      { permissions: ['valuation.view', 'valuation.finalize'] },
    );
    const done = await s2.changeCaseStatus('case-1', 'completed', full) as { status: string };
    expect(done.status).toBe('processing'); // repo mock returns processing row; permission path passed
  });

  it('V7 — valuation.manage implies every valuation permission', async () => {
    const { service } = makeService(makeRepo(), { permissions: ['valuation.manage'] });
    const created = await service.createCase({ organizationId: 'org-1', propertyId: 'prop-1' }, full) as { status: string };
    expect(created.status).toBe('requested');
    const { service: s2 } = makeService(
      makeRepo({ getCase: mockFn(async () => ({ ...caseRow, status: 'completed' })) }),
      { permissions: ['valuation.manage'] },
    );
    await s2.changeCaseStatus('case-1', 'expired', full);
    expect(s2['iam'].isActiveOrganizationMember).toHaveBeenCalled();
  });

  it('V8 — no-op transition and unknown status rejected (422)', async () => {
    const { service } = makeService(makeRepo({ getCase: mockFn(async () => ({ ...caseRow, status: 'processing' })) }));
    await expect(service.changeCaseStatus('case-1', 'processing', full))
      .rejects.toMatchObject({ response: { code: 'VALUATION_NO_OP_TRANSITION' } });
    await expect(service.changeCaseStatus('case-1', 'flying', full))
      .rejects.toMatchObject({ response: { code: 'VALUATION_UNKNOWN_STATUS' } });
    await expect(service.changeCaseStatus('case-1', 'requested', full))
      .rejects.toMatchObject({ response: { code: 'VALUATION_INVALID_TRANSITION' } });
  });

  it('V9 — DB transition violation maps to 422 with domain code', async () => {
    const { service } = makeService(makeRepo({
      updateCaseStatus: mockFn(async () => { throw new Error('VALUATION_INVALID_TRANSITION: requested -> completed'); }),
    }));
    await expect(service.changeCaseStatus('case-1', 'completed', full))
      .rejects.toMatchObject({ response: { code: 'VALUATION_INVALID_TRANSITION' } });
  });

  it('V10 — expiresAt is only accepted when completing or expiring (G5)', async () => {
    const { service } = makeService();
    await expect(service.changeCaseStatus('case-1', 'processing', full, { expiresAt: new Date().toISOString() }))
      .rejects.toMatchObject({ response: { code: 'VALUATION_EXPIRES_AT_INVALID' } });
    const { service: s2 } = makeService(makeRepo({
      getCase: mockFn(async () => ({ ...caseRow, status: 'processing' })),
      updateCaseStatus: mockFn(async () => ({ ...caseRow, status: 'completed', completed_at: now, expires_at: now })),
    }));
    await s2.changeCaseStatus('case-1', 'completed', full, { expiresAt: new Date().toISOString() });
    expect(s2['valuations'].updateCaseStatus).toHaveBeenCalledWith(expect.objectContaining({ toStatus: 'completed', expiresAt: expect.any(Date) }));
  });

  it('V11 — finalize emits ValuationCompleted.v1 with result snapshot (strings preserved)', async () => {
    const { service, outbox } = makeService(makeRepo({
      getCase: mockFn(async () => ({ ...caseRow, status: 'processing' })),
      updateCaseStatus: mockFn(async () => ({ ...caseRow, status: 'completed', completed_at: now })),
    }));
    await service.changeCaseStatus('case-1', 'completed', full);
    expect(outbox.append).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'ValuationCompleted.v1',
      payload: expect.objectContaining({ minValue: '100000.0000', estimatedValue: '150000.0000', maxValue: '200000.0000', currencyCode: 'USD' }),
    }), expect.anything());
  });

  it('V12 — fail emits ValuationFailed.v1; processing start emits no outbox event (3-event catalogue)', async () => {
    const { service, outbox } = makeService(makeRepo({
      updateCaseStatus: mockFn(async () => ({ ...caseRow, status: 'failed' })),
    }));
    await service.changeCaseStatus('case-1', 'failed', full, { reason: 'data unavailable' });
    expect(outbox.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ValuationFailed.v1', payload: expect.objectContaining({ reason: 'data unavailable', fromStatus: 'requested' }) }), expect.anything());
    const { service: s2, outbox: o2 } = makeService();
    await s2.changeCaseStatus('case-1', 'processing', full);
    expect(o2.append).not.toHaveBeenCalled();
  });

  it('V13 — sealed cases reject meta update, result recording and comparables (422 VALUATION_CASE_SEALED)', async () => {
    for (const status of ['completed', 'expired']) {
      const sealed = makeRepo({ getCase: mockFn(async () => ({ ...caseRow, status })) });
      const { service } = makeService(sealed);
      await expect(service.updateCaseMeta('case-1', { method: 'income' }, full))
        .rejects.toMatchObject({ response: { code: 'VALUATION_CASE_SEALED' } });
      await expect(service.recordResult('case-1', { minValue: '1', estimatedValue: '2', maxValue: '3', currencyCode: 'USD' }, full))
        .rejects.toMatchObject({ response: { code: 'VALUATION_CASE_SEALED' } });
      await expect(service.addComparables('case-1', [{ comparablePropertyId: 'prop-2' }], full))
        .rejects.toMatchObject({ response: { code: 'VALUATION_CASE_SEALED' } });
    }
  });

  it('V14 — recordResult passes exact decimal strings untouched (no numeric coercion)', async () => {
    const { service, repo, audit } = makeService(makeRepo({
      getResultByCaseId: mockFn(async () => null),
    }));
    await service.recordResult('case-1', {
      minValue: '1234567890123456.7890', estimatedValue: '1500000000000000.0001',
      maxValue: '9999999999999999.9999', currencyCode: 'USD', confidence: '82.55', pricePerM2: '1500.1250',
    }, full);
    const arg = repo.upsertResult.mock.calls[0][0];
    expect(arg.minValue).toBe('1234567890123456.7890');
    expect(arg.estimatedValue).toBe('1500000000000000.0001');
    expect(arg.maxValue).toBe('9999999999999999.9999');
    expect(arg.confidence).toBe('82.55');
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'valuation.result_recorded' }), expect.anything());
  });

  it('V15 — DB range violation (23514) maps to 422 VALUATION_RESULT_RANGE_INVALID', async () => {
    const { service } = makeService(makeRepo({
      upsertResult: mockFn(async () => { throw Object.assign(new Error('check_violation'), { code: '23514' }); }),
    }));
    await expect(service.recordResult('case-1', { minValue: '5', estimatedValue: '2', maxValue: '3', currencyCode: 'USD' }, full))
      .rejects.toMatchObject({ response: { code: 'VALUATION_RESULT_RANGE_INVALID' } });
  });

  it('V16 — comparables inherit the parent result currency exactly (G6, deterministic source)', async () => {
    const { service, repo } = makeService(makeRepo({
      getResultByCaseId: mockFn(async () => ({ ...resultRow, currency_code: 'EUR' })),
    }));
    await service.addComparables('case-1', [{ comparablePropertyId: 'prop-2', adjustedPrice: '148000.00' }], full);
    expect(repo.addComparable).toHaveBeenCalledWith(expect.objectContaining({ currencyCode: 'EUR', resultId: 'res-1' }));
  });

  it('V17 — comparables require an existing result and an existing comparable property', async () => {
    const { service } = makeService(makeRepo({ getResultByCaseId: mockFn(async () => null) }));
    await expect(service.addComparables('case-1', [{ comparablePropertyId: 'prop-2' }], full))
      .rejects.toMatchObject({ response: { code: 'VALUATION_RESULT_REQUIRED' } });
    const { service: s2 } = makeService(makeRepo({ getProperty: mockFn(async () => null) }));
    await expect(s2.addComparables('case-1', [{ comparablePropertyId: 'prop-x' }], full))
      .rejects.toMatchObject({ response: { code: 'VALUATION_COMPARABLE_PROPERTY_INVALID' } });
  });

  it('V18 — listCases is org-scoped: with org filter checks membership; without it unions member orgs + own requests', async () => {
    const { service, repo, iam } = makeService();
    await service.listCases(full, { organizationId: 'org-1' });
    expect(iam.isActiveOrganizationMember).toHaveBeenCalledWith('user-1', 'org-1');
    expect(repo.listCases).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
    await service.listCases(full, {});
    expect(repo.listCases).toHaveBeenLastCalledWith(expect.objectContaining({ memberOrganizationIds: ['org-1'], requestedByUserId: 'user-1' }));
    const { service: s2 } = makeService(makeRepo(), { member: false });
    await expect(s2.listCases(full, { organizationId: 'org-1' }))
      .rejects.toMatchObject({ response: { code: 'ORG_NOT_FOUND' } });
  });

  it('V19 — updateCaseMeta requires at least one field, writes audit, no outbox event', async () => {
    const { service } = makeService();
    await expect(service.updateCaseMeta('case-1', {}, full))
      .rejects.toMatchObject({ response: { code: 'VALUATION_NO_CHANGES' } });
    const { service: s2, audit, outbox } = makeService();
    await s2.updateCaseMeta('case-1', { modelVersion: 'avm-2024.1' }, full);
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'valuation.case_updated' }), expect.anything());
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('V20 — property history endpoint delegates with propertyId scoping', async () => {
    const { service, repo } = makeService();
    await service.listPropertyCaseHistory('prop-1', full, { organizationId: 'org-1' });
    expect(repo.listCases).toHaveBeenCalledWith(expect.objectContaining({ propertyId: 'prop-1', organizationId: 'org-1' }));
  });
});
