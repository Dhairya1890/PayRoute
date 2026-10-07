-- PayRoute Migration 001: Initial Core Schema
-- Strict, forward-only migration. Runs in a single atomic transaction.

BEGIN;

-- 1. Helper function for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Businesses (Tenants)
-- Represents onboarded merchants. Each business is strictly isolated.
CREATE TABLE businesses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_businesses_updated_at
BEFORE UPDATE ON businesses
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. API Keys
-- Supports multiple keys per business for zero-downtime key rotation.
-- Only the hashed key is stored. The prefix is visible for identification in logs/UI.
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    key_prefix VARCHAR(16) NOT NULL,
    name VARCHAR(100) NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_business_id ON api_keys(business_id);

-- 4. Provider Configuration
-- Dynamic operational parameters (priorities, cost basis, timeout).
-- Credentials are NEVER stored in the database (loaded exclusively from validated environment variables).
CREATE TABLE provider_config (
    name VARCHAR(32) PRIMARY KEY,
    enabled BOOLEAN NOT NULL DEFAULT true,
    priority INTEGER NOT NULL DEFAULT 1,
    cost_bps INTEGER NOT NULL DEFAULT 0,
    timeout_ms INTEGER NOT NULL DEFAULT 5000,
    supported_methods TEXT[] NOT NULL DEFAULT '{card}',
    supported_currencies TEXT[] NOT NULL DEFAULT '{INR,USD}',
    decline_code_map JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_provider_config_updated_at
BEFORE UPDATE ON provider_config
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Seed initial supported providers (Razorpay, Stripe, PayU)
INSERT INTO provider_config (name, enabled, priority, cost_bps, timeout_ms, supported_methods, supported_currencies, decline_code_map)
VALUES
  ('razorpay', true, 1, 190, 5000, ARRAY['card', 'upi', 'netbanking'], ARRAY['INR'], '{}'::jsonb),
  ('stripe', true, 2, 290, 5000, ARRAY['card'], ARRAY['INR', 'USD', 'EUR', 'GBP'], '{}'::jsonb),
  ('payu', true, 3, 200, 5000, ARRAY['card', 'netbanking'], ARRAY['INR'], '{}'::jsonb);

-- 5. Payments
-- Core payment table enforcing idempotency via UNIQUE (business_id, idempotency_key).
-- amount_minor is strictly positive integer minor units (paise/cents). No floats.
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
    idempotency_key VARCHAR(255) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    payment_method VARCHAR(32) NOT NULL DEFAULT 'card',
    status VARCHAR(32) NOT NULL DEFAULT 'created' CHECK (
        status IN ('created', 'processing', 'requires_action', 'succeeded', 'failed', 'unknown')
    ),
    customer_reference VARCHAR(100),
    final_provider VARCHAR(32) REFERENCES provider_config(name) ON DELETE RESTRICT,
    failure_reason TEXT,
    deadline_at TIMESTAMPTZ NOT NULL,
    resolution_deadline_at TIMESTAMPTZ,
    next_action_time TIMESTAMPTZ,
    needs_review BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_payments_business_idempotency UNIQUE (business_id, idempotency_key)
);

CREATE TRIGGER trg_payments_updated_at
BEFORE UPDATE ON payments
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- Listing index scoped by business and recency
CREATE INDEX idx_payments_business_created ON payments (business_id, created_at DESC);

-- Sweeper index for non-terminal payments due for status check or retry
CREATE INDEX idx_payments_due ON payments (next_action_time)
WHERE status IN ('processing', 'requires_action', 'unknown')
  AND next_action_time IS NOT NULL;

-- 6. Payment Attempts (Append-Only)
-- Records every attempt made to a provider for a payment.
-- Rows are never deleted; updates are strictly constrained to outcome fields on non-terminal attempts.
CREATE TABLE payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    attempt_no INTEGER NOT NULL,
    provider VARCHAR(32) NOT NULL REFERENCES provider_config(name) ON DELETE RESTRICT,
    provider_ref VARCHAR(255),
    provider_error_code VARCHAR(64),
    status VARCHAR(32) NOT NULL DEFAULT 'started' CHECK (
        status IN ('started', 'requires_action', 'succeeded', 'failed', 'unknown')
    ),
    error_class VARCHAR(32) CHECK (
        error_class IS NULL OR error_class IN (
            'success',
            'hard_decline',
            'soft_decline',
            'not_sent',
            'rate_limited',
            'config_error',
            'bad_request',
            'transient',
            'ambiguous',
            'action_required'
        )
    ),
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    routing_reason TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    CONSTRAINT uq_payment_attempts_payment_no UNIQUE (payment_id, attempt_no)
);

CREATE INDEX idx_payment_attempts_payment_id ON payment_attempts(payment_id);

-- Webhook fast lookup index by provider and provider reference
CREATE UNIQUE INDEX uq_payment_attempts_provider_ref
ON payment_attempts (provider, provider_ref)
WHERE provider_ref IS NOT NULL;

-- Invariant guard: At most one succeeded attempt per payment
CREATE UNIQUE INDEX uq_one_success_per_payment
ON payment_attempts (payment_id)
WHERE status = 'succeeded';

-- Enforcement Trigger for payment_attempts:
-- - Prohibits DELETE
-- - Prohibits mutating terminal attempts (succeeded, failed)
-- - Prohibits altering identity, payment_id, attempt_no, provider, or routing metadata
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
           NEW.started_at <> OLD.started_at THEN
            RAISE EXCEPTION 'Cannot modify identity, provider, or routing metadata on an existing payment_attempt';
        END IF;

        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_attempts_enforce
BEFORE UPDATE OR DELETE ON payment_attempts
FOR EACH ROW
EXECUTE FUNCTION enforce_payment_attempts_immutability();

-- 7. Inbound Provider Events (Webhooks)
-- Deduplicated by UNIQUE (provider, event_id).
CREATE TABLE provider_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(32) NOT NULL REFERENCES provider_config(name) ON DELETE RESTRICT,
    event_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payment_id UUID REFERENCES payments(id) ON DELETE RESTRICT,
    payload JSONB NOT NULL,
    outcome VARCHAR(32) NOT NULL DEFAULT 'received' CHECK (
        outcome IN ('received', 'applied', 'ignored_duplicate', 'ignored_terminal', 'failed')
    ),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    CONSTRAINT uq_provider_events_provider_event_id UNIQUE (provider, event_id)
);

CREATE INDEX idx_provider_events_payment_id ON provider_events(payment_id);

-- 8. Audit Log (Strictly Append-Only)
-- Audits all operator actions and critical state mutations.
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor VARCHAR(255) NOT NULL,
    action VARCHAR(64) NOT NULL,
    entity VARCHAR(64) NOT NULL,
    entity_id VARCHAR(255) NOT NULL,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforcement Trigger for audit_log:
-- - Prohibits UPDATE, DELETE, and TRUNCATE
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only: UPDATE, DELETE, and TRUNCATE are prohibited';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_immutable
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_log_mutation();

CREATE TRIGGER trg_audit_log_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_audit_log_mutation();

COMMIT;
