import { randomUUID } from 'node:crypto';
import { AuditRepository, IamRepository, OutboxRepository, PostgresDatabase, RentalRepository } from '@platform/db';
import { ForbiddenException } from '@nestjs/common';
import { RentalService } from '../../src/modules/rental/application/rental.service';
import type { AuthenticatedUser } from '@platform/contracts';

const enabled = Boolean(process.env.RUN_DB_TESTS && process.env.DATABASE_URL);
const d = enabled ? describe : describe.skip;

/**
 * Gate P Rental Milestone 1 — integration against real PostgreSQL.
 * Authority under test: frozen base 0018_rental (leases / lease_parties /
 * rent_schedules / rent_payments RESTRICT, lease_status enum, XOR CHECKs,
 * `leases_no_overlap` EXCLUDE USING gist) + additive 0041 permission seeds.
 * The completed Valuation suites are NOT repeated here.
 */
d('Gate P Rental M1 — integration against real PostgreSQL', () => {
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

  beforeAll(async () => {
    db = new PostgresDatabase({ connectionString: process.env.DATABASE_URL!, max: 5 });
    iam = new IamRepository(db);
    repo = new RentalRepository(db);
    outbox = new OutboxRepository(db);
    audit = new AuditRepository(db);
    service = new RentalService(repo, outbox, audit, iam, db);
  });

  afterAll(async () => {
    // leases RESTRICT property deletion; payments RESTRICT schedule deletion —
    // delete in dependency order: payments → leases → properties → orgs → users
    for (const scheduleId of createdPaymentScheduleIds) {
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
    const u = await iam.createPasswordUser({ email: `gp-rental-${randomUUID()}@t.local`, passwordHash: 'test-hash' });
    createdUserIds.push(u.id);
    await grant(u.id, permissions);
    return { id: u.id, status: 'active' } as AuthenticatedUser;
  }

  async function org(member: AuthenticatedUser): Promise<string> {
    const slug = `gp-rental-${randomUUID().slice(0, 12)}`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO org.organizations (type, status, legal_name, display_name, slug)
       VALUES ('developer', 'active', $1, $1, $2) RETURNING id`,
      [`GP Rental Org ${slug}`, slug],
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

  async function createLease(f: { actor: AuthenticatedUser; orgId: string; propertyId: string }, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return (await service.createLease({
      organizationId: f.orgId,
      propertyId: f.propertyId,
      tenantUserId: createdUserIds[createdUserIds.length - 1],
      currencyCode: 'USD',
      monthlyRent: '1500.0000',
      startDate: '2031-01-01',
      endDate: '2031-06-30',
      ...overrides,
    }, f.actor)) as Record<string, unknown>;
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

  it('P1 — create + retrieve + list: events + audit atomically, exact 20-digit decimal round-trip, date columns exact', async () => {
    const f = await fixture();
    const monthlyRent = '1234567890123456.7890';
    const created = await createLease(f, {
      monthlyRent,
      depositAmount: '45000.5000',
      contractId: null,
      parties: [{ role: 'tenant', userId: createdUserIds[createdUserIds.length - 1], nameSnapshot: 'Tenant One', contactSnapshot: { phone: '+10000000000' } }],
    });
    createdLeaseIds.push(created['id'] as string);
    expect(created['status']).toBe('draft');
    expect(created['monthlyRent']).toBe(monthlyRent);
    expect(typeof created['monthlyRent']).toBe('string');
    expect(created['startDate']).toBe('2031-01-01');
    expect(created['endDate']).toBe('2031-06-30');
    expect(created['landlordOrganizationId']).toBe(f.orgId);
    expect(created['landlordUserId']).toBeNull();
    expect(created['tenantOrganizationId']).toBeNull();

    const dbRow = await db.query<{ monthly_rent: string; start_date: string }>(
      `SELECT monthly_rent::text AS monthly_rent, start_date::text AS start_date FROM rental.leases WHERE id = $1::uuid`,
      [created['id'] as string],
    );
    expect(dbRow.rows[0]!.monthly_rent).toBe(monthlyRent); // numeric(20,4) round-trip is exact
    expect(dbRow.rows[0]!.start_date).toBe('2031-01-01');

    expect(await eventCount('LeaseCreated.v1', created['id'] as string)).toBe(1);
    expect(await auditCount('rental.lease_created', created['id'] as string)).toBe(1);

    const got = (await service.getLease(created['id'] as string, f.actor)) as Record<string, unknown>;
    expect(got['id']).toBe(created['id']);
    expect(Array.isArray(got['parties'])).toBe(true);
    expect((got['parties'] as Array<Record<string, unknown>>)).toHaveLength(1);
    expect((got['parties'] as Array<Record<string, unknown>>)[0]!['nameSnapshot']).toBe('Tenant One');
    expect(Array.isArray(got['schedules'])).toBe(true);

    // org root listing + global root listing see it; refiners work
    const byOrg = (await service.listLeases(f.actor, { organizationId: f.orgId })) as Array<Record<string, unknown>>;
    expect(byOrg.map((l) => l['id'])).toContain(created['id']);
    const byGlobal = (await service.listLeases(f.actor, {})) as Array<Record<string, unknown>>;
    expect(byGlobal.map((l) => l['id'])).toContain(created['id']);
    const byStatus = (await service.listLeases(f.actor, { organizationId: f.orgId, status: 'draft' })) as Array<Record<string, unknown>>;
    expect(byStatus.map((l) => l['id'])).toContain(created['id']);
    const byActive = (await service.listLeases(f.actor, { organizationId: f.orgId, status: 'active' })) as Array<Record<string, unknown>>;
    expect(byActive.map((l) => l['id'])).not.toContain(created['id']);
  });

  it('P2 — organization isolation / IDOR: outsider gets 404 on every path and never sees the lease', async () => {
    const f1 = await fixture();
    const f2 = await fixture();
    const lease = await createLease(f1);
    createdLeaseIds.push(lease['id'] as string);

    // reads and mutations from a non-member: 404 no-leak (never 403, never data)
    await expect(service.getLease(lease['id'] as string, f2.actor)).rejects.toMatchObject({ status: 404, response: { code: 'LEASE_NOT_FOUND' } });
    await expect(service.updateLease(lease['id'] as string, { monthlyRent: '1' }, f2.actor)).rejects.toMatchObject({ status: 404 });
    await expect(service.changeLeaseStatus(lease['id'] as string, 'pending_signature', f2.actor)).rejects.toMatchObject({ status: 404 });
    await expect(service.listParties(lease['id'] as string, f2.actor)).rejects.toMatchObject({ status: 404 });
    await expect(service.listSchedules(lease['id'] as string, f2.actor)).rejects.toMatchObject({ status: 404 });
    await expect(service.addParties(lease['id'] as string, [{ role: 'agent', userId: f2.actor.id, nameSnapshot: 'X' }], f2.actor)).rejects.toMatchObject({ status: 404 });
    await expect(service.addSchedules(lease['id'] as string, [{ dueDate: '2031-02-01', amount: '1', currencyCode: 'USD' }], f2.actor)).rejects.toMatchObject({ status: 404 });
    await expect(service.removeSchedule(lease['id'] as string, lease['id'] as string, f2.actor)).rejects.toMatchObject({ status: 404 });

    // outsider listing: org root 404 (not a member), global root empty
    await expect(service.listLeases(f2.actor, { organizationId: f1.orgId })).rejects.toMatchObject({ status: 404, response: { code: 'ORG_NOT_FOUND' } });
    const outsiderGlobal = (await service.listLeases(f2.actor, {})) as Array<Record<string, unknown>>;
    expect(outsiderGlobal.map((l) => l['id'])).not.toContain(lease['id']);

    // missing permission = 403 (member, but no rental.update)
    const viewer = await user(['rental.view']);
    const f3org = f1.orgId;
    await db.query(`INSERT INTO org.organization_members (organization_id, user_id, status) VALUES ($1::uuid, $2::uuid, 'active') ON CONFLICT DO NOTHING`, [f3org, viewer.id]);
    await expect(service.changeLeaseStatus(lease['id'] as string, 'pending_signature', viewer))
      .rejects.toBeInstanceOf(ForbiddenException);
    // viewer CAN read (rental.view)
    const seen = (await service.getLease(lease['id'] as string, viewer)) as Record<string, unknown>;
    expect(seen['id']).toBe(lease['id']);
  });

  it('P3 — lifecycle: valid chain, invalid jumps, no-op, terminal states (events + audit each step)', async () => {
    const f = await fixture();
    const lease = await createLease(f);
    createdLeaseIds.push(lease['id'] as string);
    const id = lease['id'] as string;

    const sig = (await service.changeLeaseStatus(id, 'pending_signature', f.actor)) as Record<string, unknown>;
    expect(sig['status']).toBe('pending_signature');
    const active = (await service.changeLeaseStatus(id, 'active', f.actor)) as Record<string, unknown>;
    expect(active['status']).toBe('active');
    const expired = (await service.changeLeaseStatus(id, 'expired', f.actor)) as Record<string, unknown>;
    expect(expired['status']).toBe('expired');

    expect(await eventCount('LeaseStatusChanged.v1', id)).toBe(3);
    expect(await auditCount('rental.lease_status_changed', id)).toBe(3);

    // invalid: unknown status, back to draft, illegal jump, terminal, no-op
    await expect(service.changeLeaseStatus(id, 'suspended', f.actor)).rejects.toMatchObject({ response: { code: 'LEASE_UNKNOWN_STATUS' } });
    await expect(service.changeLeaseStatus(id, 'draft', f.actor)).rejects.toMatchObject({ response: { code: 'LEASE_INVALID_TRANSITION' } });
    await expect(service.changeLeaseStatus(id, 'expired', f.actor)).rejects.toMatchObject({ response: { code: 'LEASE_NO_OP_TRANSITION' } });
    const terminal = await makeTerminatedLease(f);
    createdLeaseIds.push(terminal['id'] as string);
    await expect(service.changeLeaseStatus(terminal['id'] as string, 'active', f.actor)).rejects.toMatchObject({ response: { code: 'LEASE_INVALID_TRANSITION' } });
    // nothing extra emitted by the rejected attempts
    expect(await eventCount('LeaseStatusChanged.v1', id)).toBe(3);
  });

  async function makeTerminatedLease(f: { actor: AuthenticatedUser; orgId: string; propertyId: string }): Promise<Record<string, unknown>> {
    const lease = await createLease(f, { startDate: '2031-07-01', endDate: '2031-12-31' });
    await service.changeLeaseStatus(lease['id'] as string, 'pending_signature', f.actor);
    await service.changeLeaseStatus(lease['id'] as string, 'active', f.actor);
    return (await service.changeLeaseStatus(lease['id'] as string, 'terminated', f.actor)) as Record<string, unknown>;
  }

  it('P4 — overlap: overlapping pending_signature rejected 409; adjacent range accepted; drafts may overlap; transition INTO overlap rejected 409', async () => {
    const f = await fixture();
    const a = await createLease(f, { startDate: '2031-01-01', endDate: '2031-06-30' });
    createdLeaseIds.push(a['id'] as string);
    await service.changeLeaseStatus(a['id'] as string, 'pending_signature', f.actor);

    // overlapping lease cannot even reach pending_signature (preflight-free rule)
    const b = await createLease(f, { startDate: '2031-03-01', endDate: '2031-09-30' });
    createdLeaseIds.push(b['id'] as string);
    await expect(service.changeLeaseStatus(b['id'] as string, 'pending_signature', f.actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_OVERLAP_CONFLICT' } });
    expect(await eventCount('LeaseStatusChanged.v1', b['id'] as string)).toBe(0);
    expect(await auditCount('rental.lease_status_changed', b['id'] as string)).toBe(0);

    // drafts may overlap — the frozen constraint only guards pending_signature/active
    const draft = await createLease(f, { startDate: '2031-02-01', endDate: '2031-04-01' });
    createdLeaseIds.push(draft['id'] as string);
    expect(draft['status']).toBe('draft');

    // adjacent range ('[)' semantics) is accepted
    const c = await createLease(f, { startDate: '2031-06-30', endDate: '2031-12-31' });
    createdLeaseIds.push(c['id'] as string);
    const cSig = (await service.changeLeaseStatus(c['id'] as string, 'pending_signature', f.actor)) as Record<string, unknown>;
    expect(cSig['status']).toBe('pending_signature');

    // creating directly in a guarded state is impossible via API (draft default),
    // so overlap on CREATE is proven by the concurrent race in P5.
  });

  it('P5 — concurrent overlapping guarded-state inserts: the DB exclusion constraint makes exactly one win under a real race', async () => {
    const f = await fixture();
    const db2 = new PostgresDatabase({ connectionString: process.env.DATABASE_URL!, max: 2 });
    try {
      const tenantId = createdUserIds[createdUserIds.length - 1];
      const base = {
        propertyId: f.propertyId, landlordOrganizationId: f.orgId, tenantUserId: tenantId,
        currencyCode: 'USD', monthlyRent: '1500.0000', startDate: '2031-05-01', endDate: '2031-08-31',
      };
      // Raw SQL INSERT into a GUARDED state (pending_signature) — the API path can
      // never create directly in a guarded state (frozen DEFAULT 'draft'), so this
      // exercises the frozen `leases_no_overlap` EXCLUDE constraint itself: the
      // winner's uncommitted GiST entry blocks the loser; after the winner commits,
      // the loser's exclusion re-check fails → 23P01 → mapped 409 upstream. NOT a
      // preflight query: this holds for ANY interleaving because the index is the
      // concurrency-safe authority (valuation W2 raw-SQL authority precedent).
      const insertPending = (client: unknown, start: string, end: string) =>
        (client as { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ id: string }> }> }).query(
          `INSERT INTO rental.leases
             (property_id, landlord_organization_id, tenant_user_id, currency_code, monthly_rent, start_date, end_date, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::char(3), $5::numeric, $6::date, $7::date, 'pending_signature')
           RETURNING id`,
          [base.propertyId, base.landlordOrganizationId, base.tenantUserId, base.currencyCode, base.monthlyRent, start, end],
        ).then((r) => r.rows[0]!.id);
      let loserStarted = () => {};
      const loserStartedP = new Promise<void>((resolve) => { loserStarted = resolve; });
      const winnerP = db.transaction(async (clientA) => {
        const id = await insertPending(clientA, '2031-05-01', '2031-08-31');
        createdLeaseIds.push(id);
        loserStarted();
        await loserStartedP;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return id;
      });
      const loserP = db2.transaction(async (clientB) => {
        loserStarted();
        return insertPending(clientB, '2031-06-01', '2031-10-31');
      });
      const results = await Promise.allSettled([winnerP, loserP]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string };
      expect(reason.code).toBe('23P01');
      // exactly one pending_signature lease for the property in that range
      const r = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM rental.leases
          WHERE property_id = $1::uuid AND status IN ('pending_signature','active')
            AND daterange(start_date, end_date, '[)') && daterange('2031-06-01'::date, '2031-08-31'::date, '[)')`,
        [f.propertyId],
      );
      expect(Number(r.rows[0]!.count)).toBe(1);
    } finally {
      await db2.close();
    }
  });

  it('P6 — two concurrent CAS transitions: exactly one winner, loser 0 rows + no duplicate event/audit (lock-wait proven)', async () => {
    const f = await fixture();
    const lease = await createLease(f, { startDate: '2031-02-01', endDate: '2031-07-31' });
    createdLeaseIds.push(lease['id'] as string);
    await service.changeLeaseStatus(lease['id'] as string, 'pending_signature', f.actor);
    const id = lease['id'] as string;

    const db2 = new PostgresDatabase({ connectionString: process.env.DATABASE_URL!, max: 2 });
    try {
      let loserStarted = () => {};
      const loserStartedP = new Promise<void>((resolve) => { loserStarted = resolve; });
      // Winner: CAS UPDATE takes the row lock and holds it; event + audit written
      // in the SAME transaction (service parity) and commit atomically.
      const winnerP = db.transaction(async (clientA) => {
        const row = await repo.updateLeaseStatus({ id, toStatus: 'active', expectedFromStatus: 'pending_signature', executor: clientA });
        expect(row).toBeTruthy();
        loserStarted();
        await loserStartedP;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await outbox.append({
          aggregateType: 'rental_lease', aggregateId: id, eventType: 'LeaseStatusChanged.v1', eventVersion: 1,
          payload: { leaseId: id, fromStatus: 'pending_signature', toStatus: 'active' },
        }, clientA);
        await audit.append({
          actorUserId: f.actor.id, organizationId: f.orgId,
          action: 'rental.lease_status_changed', entityType: 'rental.lease', entityId: id,
          beforeData: { status: 'pending_signature' }, afterData: { status: 'active' },
        }, clientA);
        return row;
      });
      // Loser: same expected from-status — after the winner commits, READ
      // COMMITTED re-checks the predicate on the new row version → 0 rows → 409.
      const loserP = db2.transaction(async (clientB) => {
        loserStarted();
        return repo.updateLeaseStatus({ id, toStatus: 'active', expectedFromStatus: 'pending_signature', executor: clientB });
      });
      const [winner, loser] = await Promise.all([winnerP, loserP]);
      expect(winner).toBeTruthy();
      expect(loser).toBeNull();
      // exactly one ACTIVE transition event for the aggregate (the earlier
      // service-driven pending_signature transition legitimately emitted its own)
      const activeEvents = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM audit.outbox_events
          WHERE event_type = 'LeaseStatusChanged.v1' AND aggregate_id = $1::uuid AND payload->>'toStatus' = 'active'`,
        [id],
      );
      expect(Number(activeEvents.rows[0]!.count)).toBe(1);
      const activeAudits = await db.query<{ count: string }>(
        `SELECT count(*) AS count FROM audit.logs
          WHERE action = 'rental.lease_status_changed' AND entity_id = $1::uuid AND after_data->>'status' = 'active'`,
        [id],
      );
      expect(Number(activeAudits.rows[0]!.count)).toBe(1);
      const statusRow = await db.query<{ status: string }>(`SELECT status::text AS status FROM rental.leases WHERE id = $1::uuid`, [id]);
      expect(statusRow.rows[0]!.status).toBe('active');
    } finally {
      await db2.close();
    }
  });

  it('P7 — schedules: exact decimals round-trip; currency mismatch 422; duplicate 409; RESTRICT-protected delete 409; audit snapshots', async () => {
    const f = await fixture();
    const lease = await createLease(f, { startDate: '2031-01-01', endDate: '2031-03-31' });
    createdLeaseIds.push(lease['id'] as string);
    const id = lease['id'] as string;
    const exactAmount = '9876543210987654.3210';

    const added = (await service.addSchedules(id, [
      { dueDate: '2031-02-01', amount: exactAmount, currencyCode: 'USD' },
      { dueDate: '2031-03-01', amount: '0.0000', currencyCode: 'USD' },
    ], f.actor)) as Array<Record<string, unknown>>;
    expect(added).toHaveLength(2);
    expect(added[0]!['amount']).toBe(exactAmount);
    expect(typeof added[0]!['amount']).toBe('string');
    expect(added[0]!['status']).toBe('scheduled');
    expect(added[0]!['currencyCode']).toBe('USD');

    const dbRow = await db.query<{ amount: string }>(
      `SELECT amount::text AS amount FROM rental.rent_schedules WHERE lease_id = $1::uuid AND due_date = '2031-02-01'`,
      [id],
    );
    expect(dbRow.rows[0]!.amount).toBe(exactAmount); // numeric(20,4) round-trip is exact

    expect(await auditCount('rental.schedules_added', id)).toBe(1);

    // currency mismatch (service rule; lease currency is canonical — no conversion)
    await expect(service.addSchedules(id, [{ dueDate: '2031-03-15', amount: '1', currencyCode: 'EUR' }], f.actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_SCHEDULE_CURRENCY_MISMATCH' } });
    // duplicate (lease_id, due_date) → 23505 → 409
    await expect(service.addSchedules(id, [{ dueDate: '2031-02-01', amount: '1', currencyCode: 'USD' }], f.actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_SCHEDULE_DUPLICATE' } });

    // payment RESTRICT: a schedule carrying a rent payment cannot be removed
    const scheduleId = added[0]!['id'] as string;
    createdPaymentScheduleIds.push(scheduleId);
    await db.query(
      `INSERT INTO rental.rent_payments (schedule_id, amount, currency_code) VALUES ($1::uuid, '100.0000', 'USD')`,
      [scheduleId],
    );
    await expect(service.removeSchedule(id, scheduleId, f.actor))
      .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_SCHEDULE_IN_USE' } });

    // unpaid schedule removes cleanly with a before-snapshot audit
    const removed = (await service.removeSchedule(id, added[1]!['id'] as string, f.actor)) as Record<string, unknown>;
    expect(removed['id']).toBe(added[1]!['id']);
    expect(await auditCount('rental.schedule_removed', added[1]!['id'] as string)).toBe(1);

    // unknown schedule = 404
    await expect(service.removeSchedule(id, '00000000-0000-4000-8000-0000000000ff', f.actor))
      .rejects.toMatchObject({ status: 404, response: { code: 'LEASE_SCHEDULE_NOT_FOUND' } });
  });

  it('P8 — permitted updates: exact-decimal reprice + date window + before/after audit; parties manageable; active lease 422 NOT_MUTABLE', async () => {
    const f = await fixture();
    const lease = await createLease(f, { startDate: '2031-04-01', endDate: '2031-09-30' });
    createdLeaseIds.push(lease['id'] as string);
    const id = lease['id'] as string;

    const updated = (await service.updateLease(id, {
      monthlyRent: '1750.2500',
      depositAmount: null,
      endDate: '2031-10-31',
      autoRenew: true,
    }, f.actor)) as Record<string, unknown>;
    expect(updated['monthlyRent']).toBe('1750.2500');
    expect(updated['depositAmount']).toBeNull();
    expect(updated['endDate']).toBe('2031-10-31');
    expect(updated['autoRenew']).toBe(true);
    expect(await auditCount('rental.lease_updated', id)).toBe(1);

    // before/after audit content
    const auditRow = await db.query<{ before_data: Record<string, unknown>; after_data: Record<string, unknown> }>(
      `SELECT before_data, after_data FROM audit.logs WHERE action = 'rental.lease_updated' AND entity_id = $1::uuid`,
      [id],
    );
    expect(auditRow.rows[0]!.before_data['monthlyRent']).toBe('1500.0000');
    expect(auditRow.rows[0]!.after_data['monthlyRent']).toBe('1750.2500');

    // empty update rejected
    await expect(service.updateLease(id, {}, f.actor)).rejects.toMatchObject({ response: { code: 'LEASE_NO_CHANGES' } });
    // end date cannot cross start date
    await expect(service.updateLease(id, { endDate: '2031-03-31' }, f.actor)).rejects.toMatchObject({ response: { code: 'LEASE_DATE_RANGE_INVALID' } });

    // parties: add + list (canonical identity XOR validated upstream)
    const parties = (await service.addParties(id, [
      { role: 'agent', userId: f.actor.id, nameSnapshot: 'Agent A', contactSnapshot: { email: 'a@t.local' } },
      { role: 'guarantor', organizationId: f.orgId, nameSnapshot: 'Guarantor Org' },
    ], f.actor)) as Array<Record<string, unknown>>;
    expect(parties).toHaveLength(2); // snapshot party rows are explicit — the lease itself carries the canonical bindings
    expect(await auditCount('rental.party_added', id)).toBe(1);
    const listed = (await service.listParties(id, f.actor)) as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(2);
    await expect(service.addParties(id, [{ role: 'bad', userId: f.actor.id, organizationId: f.orgId, nameSnapshot: 'X' }], f.actor))
      .rejects.toMatchObject({ response: { code: 'LEASE_PARTY_IDENTITY_INVALID' } });

    // after commencement everything structural is frozen (422 NOT_MUTABLE)
    await service.changeLeaseStatus(id, 'pending_signature', f.actor);
    await service.changeLeaseStatus(id, 'active', f.actor);
    await expect(service.updateLease(id, { monthlyRent: '2000' }, f.actor)).rejects.toMatchObject({ response: { code: 'LEASE_NOT_MUTABLE' } });
    await expect(service.addSchedules(id, [{ dueDate: '2031-05-01', amount: '1', currencyCode: 'USD' }], f.actor)).rejects.toMatchObject({ response: { code: 'LEASE_NOT_MUTABLE' } });
    await expect(service.addParties(id, [{ role: 'agent', userId: f.actor.id, nameSnapshot: 'Y' }], f.actor)).rejects.toMatchObject({ response: { code: 'LEASE_NOT_MUTABLE' } });
    await expect(service.removeSchedule(id, '00000000-0000-4000-8000-0000000000aa', f.actor)).rejects.toMatchObject({ response: { code: 'LEASE_NOT_MUTABLE' } });

    // stale mutability pre-read (status moved concurrently) → guarded UPDATE 0 rows → 409
    const originalGetLease = repo.getLease.bind(repo);
    (repo as unknown as { getLease?: unknown }).getLease = async (leaseId: string) => {
      const row = await originalGetLease(leaseId);
      return row && row.status === 'active' ? { ...row, status: 'draft' } : row;
    };
    try {
      await expect(service.updateLease(id, { monthlyRent: '2100' }, f.actor))
        .rejects.toMatchObject({ status: 409, response: { code: 'LEASE_CONCURRENT_MODIFICATION' } });
    } finally {
      delete (repo as unknown as { getLease?: unknown }).getLease;
    }
    expect(await auditCount('rental.lease_updated', id)).toBe(1); // nothing extra written
  });

  it('P9 — 0041 permission seeds exist (rental vocabulary exactly as the service requires)', async () => {
    const r = await db.query<{ code: string }>(
      `SELECT code FROM iam.permissions WHERE code LIKE 'rental.%' ORDER BY code`,
    );
    expect(r.rows.map((row) => row.code)).toEqual(['rental.create', 'rental.manage', 'rental.update', 'rental.view']);
  });
});
