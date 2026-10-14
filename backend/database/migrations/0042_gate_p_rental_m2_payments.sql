-- ============================================================================
-- 0042 — Gate P Rental Milestone 2: rent payment idempotency authority
-- (ADDITIVE ONLY — frozen base 0018_rental and migrations 0027..0041 untouched)
-- ============================================================================
-- The frozen rental.rent_payments table (base 0018) is the persistence
-- authority for rent payment receipts and already owns:
--   schedule_id uuid NOT NULL REFERENCES rental.rent_schedules(id)
--       ON DELETE RESTRICT  → a schedule carrying payments cannot be deleted;
--   amount numeric(20,4) NOT NULL CHECK (amount > 0);
--   currency_code char(3) NOT NULL REFERENCES platform.currencies(code);
--   external_payment_id uuid REFERENCES billing.payments(id) ON DELETE SET NULL;
--   trg_rent_payment_currency (BEFORE INSERT OR UPDATE) → the frozen
--       payment-vs-schedule currency consistency authority.
--
-- This migration adds exactly ONE object: a unique partial index that makes
-- "the same external billing payment can never be applied twice" a DATABASE
-- invariant (the concurrency-safe idempotency authority for the external
-- provenance path). NULL external_payment_id (manual receipt recording) is
-- unconstrained by a partial index, exactly as the frozen column semantics
-- intend. No tables, no columns, no triggers, no enum changes, no data
-- rewrites — nothing existing is modified or dropped.
-- ============================================================================
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS ux_rent_payments_external_payment
    ON rental.rent_payments (external_payment_id)
    WHERE external_payment_id IS NOT NULL;

COMMIT;
