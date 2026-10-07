-- PayRoute Migration 002: Engine Orchestration Support
-- Adds batch_id, decision_trace, and engine_settings table.

BEGIN;

-- 1. Add batch_id to payments for grouping traffic runs (Lab batches)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS batch_id UUID;
CREATE INDEX IF NOT EXISTS idx_payments_batch ON payments (batch_id, created_at) WHERE batch_id IS NOT NULL;

-- 2. Add decision_trace to payment_attempts for recording routing auditability
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS decision_trace JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE payment_attempts ADD CONSTRAINT ck_decision_trace_is_object CHECK (jsonb_typeof(decision_trace) = 'object');

-- 3. Update immutability trigger for payment_attempts to protect decision_trace
CREATE OR REPLACE FUNCTION enforce_payment_attempts_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'payment_attempts is append-only: DELETE is prohibited';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.status IN ('succeeded', 'failed') THEN
            RAISE EXCEPTION 'Terminal attempt (status=%) cannot be updated', OLD.status;
        END IF;

        IF NEW.id <> OLD.id OR
           NEW.payment_id <> OLD.payment_id OR
           NEW.attempt_no <> OLD.attempt_no OR
           NEW.provider <> OLD.provider OR
           NEW.routing_reason <> OLD.routing_reason OR
           NEW.decision_trace <> OLD.decision_trace OR
           NEW.started_at <> OLD.started_at THEN
            RAISE EXCEPTION 'Cannot modify identity, provider, routing metadata, or decision_trace on an existing payment_attempt';
        END IF;

        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Create engine_settings table for dynamic overrides (strategy, exploration share, caps, policy)
CREATE TABLE IF NOT EXISTS engine_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default engine settings
INSERT INTO engine_settings (key, value)
VALUES
    ('routing_strategy', '"weighted"'::jsonb),
    ('exploration_share', '0.05'::jsonb),
    ('policy', '"full"'::jsonb),
    ('max_attempts_per_payment', '3'::jsonb),
    ('max_attempts_per_provider', '2'::jsonb),
    ('sync_deadline_ms', '8000'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
