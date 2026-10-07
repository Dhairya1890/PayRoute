-- PayRoute Routing Engine: Migration 001
-- Applied by the migration runner inside a single transaction. Forward-only.
--
-- Guarantees enforced by the database itself (not only by application code):
--   1. One payment per idempotency key. request_hash exposes key reuse with a different body.
--   2. Exact money: BIGINT minor units, amount > 0, ISO 4217 currency code.
--   3. At most one succeeded attempt per payment (partial unique index).
--   4. Ordered, unique attempts per payment (UNIQUE payment_id, attempt_no).
--   5. Only legal state transitions, and no regression out of terminal states (guard triggers).
--   6. History cannot be rewritten: no DELETE or TRUNCATE, immutable attempt columns.
--   7. A crash cannot strand a payment: next_action_time plus a partial index for the sweeper.
--   8. Every attempt records why its provider was chosen (routing_reason, decision_trace).

-- ---------------------------------------------------------------------------
-- provider_config: operational parameters per provider.
-- Credentials are NEVER stored here. They come from validated environment variables.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_config (
    name                 TEXT PRIMARY KEY CHECK (name IN ('razorpay', 'stripe', 'payu')),
    enabled              BOOLEAN NOT NULL DEFAULT TRUE,
    priority             INTEGER NOT NULL CHECK (priority > 0),
    cost_bps             INTEGER NOT NULL DEFAULT 0 CHECK (cost_bps >= 0),
    timeout_ms           INTEGER NOT NULL DEFAULT 5000 CHECK (timeout_ms > 0),
    supported_methods    TEXT[] NOT NULL CHECK (cardinality(supported_methods) > 0),
    supported_currencies TEXT[] NOT NULL CHECK (cardinality(supported_currencies) > 0),
    -- Maps a provider decline code to 'hard' or 'soft'. Filled from each provider's documentation.
    decline_code_map     JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(decline_code_map) = 'object'),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Deferrable so two providers can swap priorities inside one transaction.
    CONSTRAINT uq_provider_priority UNIQUE (priority) DEFERRABLE INITIALLY DEFERRED
);

-- ---------------------------------------------------------------------------
-- engine_settings: runtime settings (strategy, exploration share, caps, policy).
-- Defaults live in code (Zod); rows here are overrides.
-- ---------------------------------------------------------------------------
CREATE TABLE engine_settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- payments: one row per payment request.
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key        TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
    request_hash           TEXT NOT NULL CHECK (length(request_hash) = 64),
    amount_minor           BIGINT NOT NULL CHECK (amount_minor > 0),
    currency               TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    payment_method         TEXT NOT NULL CHECK (payment_method IN ('card', 'upi', 'netbanking', 'wallet')),
    customer_reference     TEXT CHECK (length(customer_reference) <= 100),
    batch_id               UUID,  -- groups payments sent together by one traffic run
    status                 TEXT NOT NULL DEFAULT 'created'
                           CHECK (status IN ('created', 'processing', 'succeeded', 'failed', 'unknown')),
    final_provider         TEXT REFERENCES provider_config(name),
    failure_reason         TEXT,
    needs_review           BOOLEAN NOT NULL DEFAULT FALSE,
    deadline_at            TIMESTAMPTZ NOT NULL,  -- synchronous path deadline
    resolution_deadline_at TIMESTAMPTZ NOT NULL,  -- end of background resolution
    next_action_time       TIMESTAMPTZ,           -- when a worker must look at this payment again
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_payments_idempotency_key UNIQUE (idempotency_key),
    CONSTRAINT ck_succeeded_has_provider CHECK (status <> 'succeeded' OR final_provider IS NOT NULL),
    CONSTRAINT ck_failed_has_reason CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
    CONSTRAINT ck_deadlines_ordered CHECK (resolution_deadline_at >= deadline_at)
);

-- Sweeper: payments that need attention, found without scanning the table.
CREATE INDEX idx_payments_due ON payments (next_action_time)
    WHERE status IN ('processing', 'unknown') AND next_action_time IS NOT NULL;

CREATE INDEX idx_payments_created ON payments (created_at DESC);

CREATE INDEX idx_payments_batch ON payments (batch_id, created_at) WHERE batch_id IS NOT NULL;

CREATE INDEX idx_payments_review ON payments (created_at) WHERE needs_review;

-- ---------------------------------------------------------------------------
-- payment_attempts: one row per provider attempt. Append-only history.
-- Only the outcome columns may change, and only through legal transitions.
-- ---------------------------------------------------------------------------
CREATE TABLE payment_attempts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id          UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    attempt_no          INTEGER NOT NULL CHECK (attempt_no > 0),
    provider            TEXT NOT NULL REFERENCES provider_config(name),
    provider_ref        TEXT,  -- the provider's own identifier for this payment
    status              TEXT NOT NULL DEFAULT 'started'
                        CHECK (status IN ('started', 'succeeded', 'failed', 'unknown')),
    error_class         TEXT CHECK (error_class IN (
                            'hard_decline', 'soft_decline', 'not_sent', 'rate_limited',
                            'config_error', 'bad_request', 'transient_known', 'ambiguous')),
    provider_error_code TEXT,  -- raw provider code, used by the decline-code map
    latency_ms          INTEGER CHECK (latency_ms >= 0),
    routing_reason      TEXT NOT NULL,
    decision_trace      JSONB NOT NULL CHECK (jsonb_typeof(decision_trace) = 'object'),
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ,
    CONSTRAINT uq_attempts_payment_no UNIQUE (payment_id, attempt_no),
    CONSTRAINT ck_attempt_finished_consistent CHECK ((status = 'started') = (finished_at IS NULL)),
    CONSTRAINT ck_attempt_times_ordered CHECK (finished_at IS NULL OR finished_at >= started_at),
    CONSTRAINT ck_attempt_failure_has_class CHECK (status NOT IN ('failed', 'unknown') OR error_class IS NOT NULL)
);

-- Core invariant: a payment can have at most one succeeded attempt.
CREATE UNIQUE INDEX uq_one_success_per_payment ON payment_attempts (payment_id) WHERE status = 'succeeded';

-- Status queries and any later webhook handling find the attempt by the provider's identifier.
CREATE UNIQUE INDEX uq_attempts_provider_ref ON payment_attempts (provider, provider_ref)
    WHERE provider_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Guard triggers
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% on % is not allowed (history is append-only)', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER attempts_no_delete BEFORE DELETE ON payment_attempts
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER attempts_no_truncate BEFORE TRUNCATE ON payment_attempts
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Payment state machine:
--   created -> processing
--   processing -> succeeded | failed | unknown
--   unknown -> succeeded | failed | processing (resolved as not charged, attempts remain)
-- succeeded and failed are terminal.
CREATE FUNCTION payments_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'immutable payment column changed' USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
            (OLD.status = 'created'    AND NEW.status = 'processing') OR
            (OLD.status = 'processing' AND NEW.status IN ('succeeded', 'failed', 'unknown')) OR
            (OLD.status = 'unknown'    AND NEW.status IN ('succeeded', 'failed', 'processing'))
        ) THEN
            RAISE EXCEPTION 'illegal payment transition % -> %', OLD.status, NEW.status
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_guard_trg BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION payments_guard();

-- Attempt state machine:
--   started -> succeeded | failed | unknown
--   unknown -> succeeded | failed
-- Identity, routing reason, and decision trace never change after insert.
CREATE FUNCTION payment_attempts_guard() RETURNS trigger AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
       OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW.routing_reason IS DISTINCT FROM OLD.routing_reason
       OR NEW.decision_trace IS DISTINCT FROM OLD.decision_trace
       OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
        RAISE EXCEPTION 'immutable attempt column changed' USING ERRCODE = 'check_violation';
    END IF;

    -- provider_ref may be set once, never rewritten.
    IF OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref THEN
        RAISE EXCEPTION 'provider_ref cannot be changed' USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
            (OLD.status = 'started' AND NEW.status IN ('succeeded', 'failed', 'unknown')) OR
            (OLD.status = 'unknown' AND NEW.status IN ('succeeded', 'failed'))
        ) THEN
            RAISE EXCEPTION 'illegal attempt transition % -> %', OLD.status, NEW.status
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_attempts_guard_trg BEFORE UPDATE ON payment_attempts
    FOR EACH ROW EXECUTE FUNCTION payment_attempts_guard();

-- ---------------------------------------------------------------------------
-- Provider configuration rows (operational configuration, not sample data).
-- supported_methods and supported_currencies are conservative starting values:
-- widen them only after confirming each provider's capabilities in its official documentation.
-- cost_bps must be set from each provider's actual fee schedule.
-- decline_code_map must be filled from each provider's decline code documentation.
-- ---------------------------------------------------------------------------
INSERT INTO provider_config (name, priority, supported_methods, supported_currencies) VALUES
    ('razorpay', 1, ARRAY['card'], ARRAY['INR']),
    ('stripe',   2, ARRAY['card'], ARRAY['INR']),
    ('payu',     3, ARRAY['card'], ARRAY['INR']);
