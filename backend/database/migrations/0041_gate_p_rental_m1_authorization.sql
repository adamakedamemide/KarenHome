-- ============================================================================
-- 0041 — Gate P Rental Milestone 1: authorization vocabulary (ADDITIVE ONLY)
-- ============================================================================
-- The frozen base schema (0018_rental) already owns the rental data model:
-- rental.leases / lease_parties / rent_schedules / rent_payments, the
-- rental.lease_status + rental.rent_payment_status enums, the landlord/tenant
-- user-XOR-org CHECKs, date-order CHECKs and the concurrency-safe
-- `leases_no_overlap` EXCLUDE USING gist constraint. This migration adds NO
-- tables, NO columns, NO triggers and NO enum values — it only registers the
-- permission catalog entries the application layer requires (exact 0039/0040
-- G8 precedent: catalog seeds here, role mapping stays an app-phase concern).
--
-- Lifecycle transition legality for leases is application-owned (the frozen
-- schema enforces vocabulary + overlap + identity/date constraints, which is
-- the authority this milestone preserves).
-- ============================================================================
BEGIN;

INSERT INTO iam.permissions (code, description) VALUES
    ('rental.view',   'Read rental leases, parties and schedules within scope'),
    ('rental.create', 'Create rental leases within the binding organization'),
    ('rental.update', 'Update rental leases, parties, schedules and lifecycle while mutable'),
    ('rental.manage', 'Manage the rental domain within the binding organization')
ON CONFLICT (code) DO NOTHING;

COMMIT;
