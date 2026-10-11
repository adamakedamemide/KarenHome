import { randomUUID } from 'node:crypto';
import { AuditRepository, IamRepository, OutboxRepository, PostgresDatabase, ValuationRepository } from '@platform/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ValuationService } from '../../src/modules/valuation/application/valuation.service';
import type { AuthenticatedUser } from '@platform/contracts';

const enabled = Boolean(process.env.RUN_DB_TESTS && process.env.DATABASE_URL);
const d = enabled ? describe : describe.skip;

d('G5.1 Valuation — integration against real PostgreSQL (Gate 5.1 Phase E)', () => {
  let db: PostgresDatabase;
  let iam: IamRepository;
  let repo: ValuationRepository;
  let outbox: OutboxRepository;
  let audit: AuditRepository;
  let service: ValuationService;

  const createdUserIds: string[] = [];
  const createdOrgIds: string[] = [];
  const createdPropertyIds: string[] = [];
  const createdCaseIds: string[] = [];

  beforeAll(async () => {
    db = new PostgresDatabase({ connectionString: process.env.DATABASE_URL!, max: 5 });
    iam = new IamRepository(db);
    repo = new ValuationRepository(db);
    outbox = new OutboxRepository(db);
    audit = new AuditRepository(db);
    service = new ValuationService(repo, outbox, audit, iam, db);
  });

  afterAll(async () => {
    // cases RESTRICT both orgs and properties — delete cases first, then the rest
    for (const caseId of createdCaseIds) {
      await db.query(`DELETE FROM valuation.cases WHERE id = $1::uuid`, [caseId]);
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

  async function user(permissions: string[] = ['valuation.view', 'valuation.create', 'valuation.update', 'valuation.finalize']): Promise<AuthenticatedUser> {
    const u = await iam.createPasswordUser({ email: `g51val-${randomUUID()}@t.local`, passwordHash: 'test-hash' });
    createdUserIds.push(u.id);
    await grant(u.id, permissions);
    return { id: u.id, status: 'active' } as AuthenticatedUser;
  }

  async function org(member: AuthenticatedUser): Promise<string> {
    const slug = `g51val-${randomUUID().slice(0, 12)}`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO org.organizations (type, status, legal_name, display_name, slug)
       VALUES ('developer', 'active', $1, $1, $2) RETURNING id`,
      [`G51 Val Org ${slug}`, slug],
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

  /** Standard fixture: org + member with given permissions + property. */
  async function fixture(permissions?: string[]): Promise<{ actor: AuthenticatedUser; orgId: string; propertyId: string }> {
    const actor = await user(permissions);
    const orgId = await org(actor);
    const propertyId = await property();
    return { actor, orgId, propertyId };
  }

  async function eventCount(eventType: string, aggregateId: string): Promise<number> {
    const r = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit.outbox_events WHERE event_type = $1 AND aggregate_id = $2::uuid`,
      [eventType, aggregateId],
    );
    return Number(r.rows[0]?.count ?? '0');
  }

  async function auditCount(action: string, entityId: string): Promise<number> {
    const r = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit.logs WHERE action = $1 AND entity_id = $2::uuid`,
      [action, entityId],
    );
    return Number(r.rows[0]?.count ?? '0');
  }

  it('W1 — full lifecycle: create → start → result → comparables → finalize; events + audit; exact decimal strings', async () => {
    const f = await fixture();
    const created = (await service.createCase({ organizationId: f.orgId, propertyId: f.propertyId, method: 'comparables', modelVersion: 'avm-test.1' }, f.actor)) as { id: string; status: string; method: string };
    createdCaseIds.push(created.id);
    expect(created.status).toBe('requested');
    expect(created.method).toBe('comparables');
    expect(await eventCount('ValuationRequested.v1', created.id)).toBe(1);

    const processing = (await service.changeCaseStatus(created.id, 'processing', f.actor)) as { status: string };
    expect(processing.status).toBe('processing');

    // exact 20-digit decimal — never a JS number anywhere on the path
    const minValue = '1234567890123456.7890';
    const estimatedValue = '2345678901234567.8901';
    const maxValue = '3456789012345678.9012';
    const result = (await service.recordResult(created.id, {
      minValue, estimatedValue, maxValue, currencyCode: 'USD', confidence: '82.55', pricePerM2: '1500.1250',
    }, f.actor)) as Record<string, unknown>;
    expect(result['minValue']).toBe(minValue);
    expect(result['estimatedValue']).toBe(estimatedValue);
    expect(result['maxValue']).toBe(maxValue);
    expect(typeof result['minValue']).toBe('string');
    expect(result['confidence']).toBe('82.55');
    const dbRow = await db.query<{ min_value: string }>(
      `SELECT min_value::text FROM valuation.results WHERE case_id = $1::uuid`, [created.id]);
    expect(dbRow.rows[0]!.min_value).toBe(minValue); // numeric(20,4) round-trip is exact

    const comparables = (await service.addComparables(created.id, [{
      comparablePropertyId: f.propertyId === createdPropertyIds[0] ? createdPropertyIds[0] : f.propertyId,
      similarityScore: '91.00', distanceM: '350.25', adjustedPrice: '2340000000000000.0001',
    }], f.actor)) as Array<Record<string, unknown>>;
    expect(comparables).toHaveLength(1);
    expect(comparables[0]!['currencyCode']).toBe('USD');
    expect(comparables[0]!['adjustedPrice']).toBe('2340000000000000.0001');

    const completed = (await service.changeCaseStatus(created.id, 'completed', f.actor, { expiresAt: '2030-01-01T00:00:00Z' })) as { status: string; completedAt: unknown };
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeTruthy();

    expect(await eventCount('ValuationCompleted.v1', created.id)).toBe(1);
    expect(await auditCount('valuation.case_created', created.id)).toBe(1);
    expect(await auditCount('valuation.case_status_changed', created.id)).toBe(2);
    const resultIdRow = await db.query<{ id: string }>(`SELECT id FROM valuation.results WHERE case_id = $1::uuid`, [created.id]);
    expect(await auditCount('valuation.result_recorded', resultIdRow.rows[0]!.id)).toBe(1);
    expect(await auditCount('valuation.comparables_added', resultIdRow.rows[0]!.id)).toBe(1);

    // completed event carries the exact result snapshot
    const payloadRow = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit.outbox_events WHERE event_type = 'ValuationCompleted.v1' AND aggregate_id = $1::uuid`, [created.id]);
    expect(payloadRow.rows[0]!.payload['estimatedValue']).toBe(estimatedValue);
    expect(payloadRow.rows[0]!.payload['eventVersion']).toBe(1);
  });

  it('W2 — finalized immutability: DB rejects result/comparable mutations; service rejects sealed-case writes', async () => {
    const f = await fixture();
    const created = (await service.createCase({ organizationId: f.orgId, propertyId: f.propertyId }, f.actor)) as { id: string };
    createdCaseIds.push(created.id);
    await service.changeCaseStatus(created.id, 'processing', f.actor);
    await service.recordResult(created.id, { minValue: '10.0000', estimatedValue: '20.0000', maxValue: '30.0000', currencyCode: 'USD' }, f.actor);
    const comp = (await service.addComparables(created.id, [{ comparablePropertyId: f.propertyId }], f.actor)) as Array<Record<string, unknown>>;
    expect(comp).toHaveLength(1);
    await service.changeCaseStatus(created.id, 'completed', f.actor);

    // raw SQL cannot bypass the 0040 G4 triggers
    await expect(db.query(`UPDATE valuation.results SET estimated_value = 21 WHERE case_id = $1::uuid`, [created.id]))
      .rejects.toThrow(/VALUATION_RESULT_IMMUTABLE/);
    await expect(db.query(`DELETE FROM valuation.comparables WHERE valuation_result_id = (SELECT id FROM valuation.results WHERE case_id = $1::uuid)`, [created.id]))
      .rejects.toThrow(/VALUATION_COMPARABLE_IMMUTABLE/);
    // service-level seal enforcement
    await expect(service.recordResult(created.id, { minValue: '1', estimatedValue: '2', maxValue: '3', currencyCode: 'USD' }, f.actor))
      .rejects.toMatchObject({ response: { code: 'VALUATION_CASE_SEALED' } });
    await expect(service.updateCaseMeta(created.id, { method: 'income' }, f.actor))
      .rejects.toMatchObject({ response: { code: 'VALUATION_CASE_SEALED' } });
    await expect(service.addComparables(created.id, [{ comparablePropertyId: f.propertyId }], f.actor))
      .rejects.toMatchObject({ response: { code: 'VALUATION_CASE_SEALED' } });
    // getCase embeds the sealed snapshot
    const got = (await service.getCase(created.id, f.actor)) as { status: string; result: Record<string, unknown> };
    expect(got.status).toBe('completed');
    expect(got.result['estimatedValue']).toBe('20.0000');
  });

  it('W3 — revaluation = new case (versioning foundation); property history preserves the chain', async () => {
    const f = await fixture();
    const first = (await service.createCase({ organizationId: f.orgId, propertyId: f.propertyId }, f.actor)) as { id: string };
    createdCaseIds.push(first.id);
    await service.changeCaseStatus(first.id, 'processing', f.actor);
    await service.recordResult(first.id, { minValue: '10.0000', estimatedValue: '20.0000', maxValue: '30.0000', currencyCode: 'USD' }, f.actor);
    await service.changeCaseStatus(first.id, 'completed', f.actor);
    // sealed snapshot stays completed and untouched
    const gotFirst = (await service.getCase(first.id, f.actor)) as { status: string };
    expect(gotFirst.status).toBe('completed');

    const second = (await service.createCase({ organizationId: f.orgId, propertyId: f.propertyId, modelVersion: 'avm-test.2' }, f.actor)) as { id: string; status: string };
    createdCaseIds.push(second.id);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('requested');

    const history = (await service.listPropertyCaseHistory(f.propertyId, f.actor, { organizationId: f.orgId })) as Array<{ id: string; status: string }>;
    expect(history).toHaveLength(2);
    expect(history[0]!.id).toBe(second.id); // newest first
    expect(history.find((c) => c.id === first.id)!.status).toBe('completed');
  });

  it('W4 — organization isolation: outsiders get 404; listings never leak cross-org rows', async () => {
    const a = await fixture();
    const b = await fixture();
    const caseA = (await service.createCase({ organizationId: a.orgId, propertyId: a.propertyId }, a.actor)) as { id: string };
    createdCaseIds.push(caseA.id);

    await expect(service.getCase(caseA.id, b.actor)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.changeCaseStatus(caseA.id, 'processing', b.actor)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.recordResult(caseA.id, { minValue: '1', estimatedValue: '2', maxValue: '3', currencyCode: 'USD' }, b.actor)).rejects.toBeInstanceOf(NotFoundException);

    const forB = (await service.listCases(b.actor, {})) as Array<{ id: string }>;
    expect(forB.find((c) => c.id === caseA.id)).toBeUndefined();
    const forBFiltered = (await service.listCases(b.actor, { organizationId: b.orgId })) as Array<{ id: string }>;
    expect(forBFiltered.find((c) => c.id === caseA.id)).toBeUndefined();
    const forA = (await service.listCases(a.actor, { organizationId: a.orgId })) as Array<{ id: string }>;
    expect(forA.find((c) => c.id === caseA.id)).toBeDefined();
    const historyB = (await service.listPropertyCaseHistory(a.propertyId, b.actor, { organizationId: b.orgId })) as Array<{ id: string }>;
    expect(historyB.find((c) => c.id === caseA.id)).toBeUndefined();
  });

  it('W5 — authorization: view-only reads; writes 403; finalize needs valuation.finalize; valuation.manage implies all', async () => {
    const f = await fixture();
    const created = (await service.createCase({ organizationId: f.orgId, propertyId: f.propertyId }, f.actor)) as { id: string };
    createdCaseIds.push(created.id);

    const viewer = await user(['valuation.view']);
    await db.query(`INSERT INTO org.organization_members (organization_id, user_id, status) VALUES ($1::uuid, $2::uuid, 'active')`, [f.orgId, viewer.id]);
    const got = (await service.getCase(created.id, viewer)) as { id: string };
    expect(got.id).toBe(created.id);
    await expect(service.createCase({ organizationId: f.orgId, propertyId: f.propertyId }, viewer)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.changeCaseStatus(created.id, 'processing', viewer)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.recordResult(created.id, { minValue: '1', estimatedValue: '2', maxValue: '3', currencyCode: 'USD' }, viewer)).rejects.toBeInstanceOf(ForbiddenException);

    // update-holder cannot finalize
    const updater = await user(['valuation.view', 'valuation.update']);
    await db.query(`INSERT INTO org.organization_members (organization_id, user_id, status) VALUES ($1::uuid, $2::uuid, 'active')`, [f.orgId, updater.id]);
    await expect(service.changeCaseStatus(created.id, 'completed', updater)).rejects.toBeInstanceOf(ForbiddenException);

    // manage-only principal can create, start and finalize
    const manager = await user(['valuation.manage']);
    const mOrgId = await org(manager);
    const mPropertyId = await property();
    const mCase = (await service.createCase({ organizationId: mOrgId, propertyId: mPropertyId }, manager)) as { id: string };
    createdCaseIds.push(mCase.id);
    await service.changeCaseStatus(mCase.id, 'processing', manager);
    await service.recordResult(mCase.id, { minValue: '1.0000', estimatedValue: '2.0000', maxValue: '3.0000', currencyCode: 'USD' }, manager);
    const done = (await service.changeCaseStatus(mCase.id, 'completed', manager)) as { status: string };
    expect(done.status).toBe('completed');
  });

  it('W6 — comparable currency: inherited exactly; DB trigger rejects any mismatch (G6)', async () => {
    const f = await fixture();
    const created = (await service.createCase({ organizationId: f.orgId, propertyId: f.propertyId }, f.actor)) as { id: string };
    createdCaseIds.push(created.id);
    await service.recordResult(created.id, { minValue: '10.0000', estimatedValue: '20.0000', maxValue: '30.0000', currencyCode: 'USD' }, f.actor);
    // raw SQL mismatch → 0040 trigger
    const resultIdRow = await db.query<{ id: string }>(`SELECT id FROM valuation.results WHERE case_id = $1::uuid`, [created.id]);
    await expect(db.query(
      `INSERT INTO valuation.comparables (valuation_result_id, comparable_property_id, currency_code) VALUES ($1::uuid, $2::uuid, 'EUR')`,
      [resultIdRow.rows[0]!.id, f.propertyId],
    )).rejects.toThrow(/VALUATION_CURRENCY_MISMATCH/);
    // service path inherits the parent currency
    const comps = (await service.addComparables(created.id, [{ comparablePropertyId: f.propertyId, adjustedPrice: '19.9999' }], f.actor)) as Array<Record<string, unknown>>;
    expect(comps[0]!['currencyCode']).toBe('USD');
  });

  it('W7 — transition authority: invalid transitions + insert guard + expires_at rules are DB-enforced', async () => {
    const f = await fixture();
    const created = (await service.createCase({ organizationId: f.orgId, propertyId: f.propertyId }, f.actor)) as { id: string };
    createdCaseIds.push(created.id);
    // requested → completed is not in the matrix (service + DB)
    await expect(service.changeCaseStatus(created.id, 'completed', f.actor))
      .rejects.toMatchObject({ response: { code: 'VALUATION_INVALID_TRANSITION' } });
    await expect(db.query(`UPDATE valuation.cases SET status = 'completed' WHERE id = $1::uuid`, [created.id]))
      .rejects.toThrow(/VALUATION_INVALID_TRANSITION/);
    // direct INSERT bypassing the lifecycle → guard trigger
    await expect(db.query(
      `INSERT INTO valuation.cases (property_id, organization_id, requested_by_user_id, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'processing')`,
      [f.propertyId, f.orgId, f.actor.id],
    )).rejects.toThrow(/VALUATION_INSERT_STATUS_INVALID/);
    // expires_at on a processing case → G5 violation (DB)
    await service.changeCaseStatus(created.id, 'processing', f.actor);
    await expect(db.query(`UPDATE valuation.cases SET expires_at = now() + interval '30 days' WHERE id = $1::uuid`, [created.id]))
      .rejects.toThrow(/VALUATION_EXPIRES_AT_INVALID/);
    // service mirrors G5 friendly
    await expect(service.changeCaseStatus(created.id, 'failed', f.actor, { expiresAt: '2030-01-01T00:00:00Z' }))
      .rejects.toMatchObject({ response: { code: 'VALUATION_EXPIRES_AT_INVALID' } });
    // completed_at on a non-completed case → G5 violation (DB)
    await expect(db.query(`UPDATE valuation.cases SET completed_at = now() WHERE id = $1::uuid`, [created.id]))
      .rejects.toThrow(/VALUATION_COMPLETED_AT_INVALID/);
  });

  it('W8 — failed path emits ValuationFailed.v1 with reason; failed cases stay mutable (no snapshot exists)', async () => {
    const f = await fixture();
    const created = (await service.createCase({ organizationId: f.orgId, propertyId: f.propertyId }, f.actor)) as { id: string };
    createdCaseIds.push(created.id);
    await service.recordResult(created.id, { minValue: '10.0000', estimatedValue: '20.0000', maxValue: '30.0000', currencyCode: 'USD' }, f.actor);
    await service.changeCaseStatus(created.id, 'failed', f.actor, { reason: 'insufficient comparables' });
    expect(await eventCount('ValuationFailed.v1', created.id)).toBe(1);
    const payloadRow = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit.outbox_events WHERE event_type = 'ValuationFailed.v1' AND aggregate_id = $1::uuid`, [created.id]);
    expect(payloadRow.rows[0]!.payload['reason']).toBe('insufficient comparables');
    expect(payloadRow.rows[0]!.payload['fromStatus']).toBe('requested');
    // failed case rows remain mutable (correction/cleanup is operational)
    const corrected = (await service.recordResult(created.id, { minValue: '11.0000', estimatedValue: '21.0000', maxValue: '31.0000', currencyCode: 'USD' }, f.actor)) as Record<string, unknown>;
    expect(corrected['estimatedValue']).toBe('21.0000');
  });

  it('W9 — DB range constraints map to 422; result is a strict one-per-case upsert', async () => {
    const f = await fixture();
    const created = (await service.createCase({ organizationId: f.orgId, propertyId: f.propertyId }, f.actor)) as { id: string };
    createdCaseIds.push(created.id);
    await expect(service.recordResult(created.id, { minValue: '5', estimatedValue: '2', maxValue: '3', currencyCode: 'USD' }, f.actor))
      .rejects.toMatchObject({ response: { code: 'VALUATION_RESULT_RANGE_INVALID' } });
    await expect(service.recordResult(created.id, { minValue: '1', estimatedValue: '2', maxValue: '3', currencyCode: 'XXX' }, f.actor))
      .rejects.toMatchObject({ response: { code: 'VALUATION_CURRENCY_UNKNOWN' } });
    const first = (await service.recordResult(created.id, { minValue: '10.0000', estimatedValue: '20.0000', maxValue: '30.0000', currencyCode: 'USD', confidence: '50.00' }, f.actor)) as Record<string, unknown>;
    const corrected = (await service.recordResult(created.id, { minValue: '10.0000', estimatedValue: '25.0000', maxValue: '30.0000', currencyCode: 'USD', confidence: '60.00' }, f.actor)) as Record<string, unknown>;
    expect(corrected['id']).toBe(first['id']); // same row corrected (one result per case)
    const rows = await db.query(`SELECT id FROM valuation.results WHERE case_id = $1::uuid`, [created.id]);
    expect(rows.rows).toHaveLength(1);
    expect(corrected['estimatedValue']).toBe('25.0000');
    expect(corrected['confidence']).toBe('60.00');
  });
});
