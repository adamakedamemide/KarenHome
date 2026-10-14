// Karen Home — Gate 5.1 local verification: Node equivalent of
// backend/scripts/apply-all-migrations.sh (psql unavailable in embedded env).
// Same step order, same platform.schema_migrations ledger, ON_ERROR_STOP semantics.
// Repo copy of the sandbox runner — run from backend/ where pg resolves via workspace.
// See gate5_1/PHASE_D_MIGRATION_RUNNER_AUDIT.md (findings F1-F3, section-aware transactions).
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DB_DIR = require('path').resolve(__dirname, '..', 'database');
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/karen_g51_fresh';

const STEPS = [
  ['base', 'base/enterprise_real_estate_schema_frozen_v1.sql'],
  ['errata_0024', 'errata/0024_backend_critical_hardening_fixed.sql'],
  ['errata_0025', 'errata/0025_additional_indexes.sql'],
  ['errata_0026', 'errata/0026_outbox_claiming.sql'],
  ['0027_commission', 'migrations/0027_commission_domain.sql'],
  ['0028_advertising', 'migrations/0028_advertising_domain.sql'],
  ['0029_i18n', 'migrations/0029_i18n_translations.sql'],
  ['0030_iam_two_layer', 'migrations/0030_iam_personal_scope_authorization.sql'],
  ['0031_listing_state', 'migrations/0031_listing_state_reconciliation.sql'],
  ['0032_gate4_platform', 'migrations/0032_gate4_platform_infrastructure.sql'],
  ['0033_gate4_iam', 'migrations/0033_gate4_iam_hardening.sql'],
  ['0034_gate4_billing', 'migrations/0034_gate4_billing_plans.sql'],
  ['0035_gate41_ads_authz', 'migrations/0035_gate41_advertising_authorization.sql'],
  ['0036_gate41_click_dedup', 'migrations/0036_gate41_click_dedup.sql'],
  ['0037_gate51_messaging', 'migrations/0037_gate51_messaging_domain.sql'],
  ['0038_gate51_crm', 'migrations/0038_gate51_crm_domain.sql'],
  ['0039_gate51_projects', 'migrations/0039_gate51_projects_domain.sql'],
  ['0040_gate51_valuation', 'migrations/0040_gate51_valuation_domain.sql'],
  ['0041_gate_p_rental_m1_authorization', 'migrations/0041_gate_p_rental_m1_authorization.sql'],
  ['0042_gate_p_rental_m2_payments', 'migrations/0042_gate_p_rental_m2_payments.sql'],
  ['seed_reference', 'seed/seed_reference.sql'],
];

const { splitStatements } = require("./split-sql.js");

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log('connected:', DATABASE_URL.replace(/:[^:@/]+@/, ':***@'));

  await client.query(`BEGIN;
CREATE SCHEMA IF NOT EXISTS platform;
CREATE TABLE IF NOT EXISTS platform.schema_migrations (
    step text PRIMARY KEY,
    filename text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;`);

  let applied = 0, skipped = 0;
  const { rows: ledgerRows } = await client.query(`SELECT step FROM platform.schema_migrations;`);
  const done = new Set(ledgerRows.map(r => r.step));
  for (const [step, rel] of STEPS) {
    if (done.has(step)) {
      console.log(`── skipping: ${step} (already in ledger)`);
      skipped++;
      continue;
    }
    const file = path.join(DB_DIR, rel);
    const sql = fs.readFileSync(file, 'utf8');
    const norm = s => s.split('\n').map(l => l.replace(/--.*$/, '')).join(' ').replace(/;+\s*$/, '').trim().toLowerCase();
    const raw = splitStatements(sql).map(s => s.trim()).filter(Boolean);
    const hasExplicitBegin = raw.some(s => norm(s) === 'begin');
    process.stdout.write(`── applying: ${step} (${raw.length} stmts, ${hasExplicitBegin ? 'file-managed transaction sections' : 'single driver transaction'}) ... `);
    const LEDGER_SQL = `INSERT INTO platform.schema_migrations(step, filename, applied_at) VALUES ($1, $2, now());`;
    try {
      let txOpen = false;
      if (!hasExplicitBegin) await client.query('BEGIN'); // files without explicit BEGIN: whole file atomic
      for (const s of raw) {
        const n = norm(s);
        if (n === 'begin') { if (!txOpen) { await client.query('BEGIN'); txOpen = true; } continue; }
        if (n === 'commit') { if (txOpen) { await client.query('COMMIT'); txOpen = false; } continue; }
        await client.query(s); // runs inside open tx, or autocommit per file design (enum ADD VALUE sections)
      }
      if (txOpen) { await client.query(LEDGER_SQL, [step, path.basename(file)]); await client.query('COMMIT'); }
      else await client.query(LEDGER_SQL, [step, path.basename(file)]);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection-level guard */ }
      console.log('ERROR (rolled back to section boundary — no half-applied section)');
      console.error(`FAILED at step ${step}: ${e.message}`);
      process.exit(2);
    }
    console.log('OK');
    applied++;
  }

  console.log(`=== chain summary: applied=${applied} skipped=${skipped} of ${STEPS.length} steps ===`);
  const res = await client.query(`SELECT step, filename FROM platform.schema_migrations ORDER BY applied_at;`);
  console.log(`=== chain complete: ledger rows: ${res.rows.length} ===`);
  await client.end();
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
