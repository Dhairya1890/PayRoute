import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pool } from '../../db/pool.js';
import { PaymentRepository } from '../../db/payment-repository.js';
import { CircuitBreakerManager } from '../../resilience/circuit-breaker-manager.js';
import { HealthTracker } from '../../resilience/health-tracker.js';
import { PaymentOrchestrator } from '../../orchestration/orchestrator.js';
import { ResolutionWorker } from '../resolution-worker.js';
import { ProviderAdapter, SubmitPaymentRequest, SubmitPaymentResult, GetStatusResult, CancelResult } from '@payroute/providers';
import { OutcomeClass } from '@payroute/core';
import Redis from 'ioredis';

describe('Background Resolution Worker - Unknown Outcome Resolution', () => {
  let redis: Redis;
  let subRedis: Redis;
  let healthTracker: HealthTracker;
  let paymentRepo: PaymentRepository;
  let orchestrator: PaymentOrchestrator;
  let testBusinessId: string;

  beforeEach(async () => {
    redis = new Redis({ host: '127.0.0.1', port: 6380 });
    subRedis = new Redis({ host: '127.0.0.1', port: 6380, enableReadyCheck: false });
    await redis.flushdb();

    paymentRepo = new PaymentRepository(pool);
    const breakerManager = new CircuitBreakerManager({ redis });
    healthTracker = new HealthTracker({
      redis,
      subRedis,
      providers: ['razorpay', 'stripe', 'payu'],
      methods: ['card'],
    });
    await healthTracker.init();

    const res = await pool.query(
      `INSERT INTO businesses (name) VALUES ('Worker Test Business') RETURNING id`
    );
    testBusinessId = res.rows[0].id;
  });

  afterEach(async () => {
    await healthTracker.close();
    await redis.quit();
    subRedis.disconnect();
  });

  it('Resolves unknown payment to succeeded when provider status confirms charge occurred', async () => {
    const testRef = `rzp_bg_${Date.now()}`;
    const razorpay: ProviderAdapter = {
      name: 'razorpay',
      capabilities: {
        supportsIdempotency: true,
        supportsStatusLookup: true,
        supportsCancel: false,
        supportedMethods: ['card'],
        supportedCurrencies: ['INR'],
      },
      submit: async () => {
        throw new Error('TIMEOUT');
      },
      getStatus: async (ref: string, pRef?: string) => ({
        providerRef: pRef || `${ref}_resolved`,
        status: 'succeeded',
        rawResponse: { ok: true },
      }),
      cancel: async () => ({ success: false, supported: false }),
      classify: () => 'ambiguous',
    };

    const adapters = new Map<string, ProviderAdapter>([['razorpay', razorpay]]);
    orchestrator = new PaymentOrchestrator({
      paymentRepo,
      breakerManager: new CircuitBreakerManager({ redis }),
      healthTracker,
      adapters,
      strategy: 'priority',
      explorationShare: 0,
    });

    const worker = new ResolutionWorker({
      pool,
      paymentRepo,
      adapters,
      orchestrator,
    });

    // 1. Create a payment in 'unknown' state with next_action_time in the past
    const paymentRes = await pool.query(
      `INSERT INTO payments (
        business_id, idempotency_key, request_hash, amount_minor, currency,
        payment_method, status, deadline_at, resolution_deadline_at, next_action_time
      ) VALUES (
        $1, $2, $3, 5000, 'INR', 'card', 'unknown',
        NOW() - INTERVAL '1 minute', NOW() + INTERVAL '10 minutes', NOW() - INTERVAL '1 second'
      ) RETURNING *`,
      [testBusinessId, `idem_worker_${Date.now()}`, '0000000000000000000000000000000000000000000000000000000000000000']
    );
    const payment = paymentRes.rows[0];

    // Create corresponding attempt in 'unknown'
    await pool.query(
      `INSERT INTO payment_attempts (
        payment_id, attempt_no, provider, routing_reason, decision_trace, status, error_class
      ) VALUES ($1, 1, 'razorpay', 'priority pick', '{}', 'unknown', 'ambiguous')`,
      [payment.id]
    );

    // 2. Run worker tick
    const resolvedCount = await worker.processDuePayments();
    expect(resolvedCount).toBeGreaterThanOrEqual(1);

    // 3. Verify payment was resolved to 'succeeded' with final_provider set
    const updated = await paymentRepo.getPaymentWithAttempts(payment.id);
    expect(updated?.payment.status).toBe('succeeded');
    expect(updated?.payment.finalProvider).toBe('razorpay');
    expect(updated?.payment.nextActionTime).toBeNull();
  });

  it('RULE 7 INVARIANT: Payment reaching resolution deadline without cancel is NEVER marked failed', async () => {
    const razorpay: ProviderAdapter = {
      name: 'razorpay',
      capabilities: {
        supportsIdempotency: true,
        supportsStatusLookup: true,
        supportsCancel: false,
        supportedMethods: ['card'],
        supportedCurrencies: ['INR'],
      },
      submit: async () => {
        throw new Error('TIMEOUT');
      },
      getStatus: async () => {
        throw new Error('INCONCLUSIVE');
      },
      cancel: async () => ({ success: false, supported: false }),
      classify: () => 'ambiguous',
    };

    const adapters = new Map<string, ProviderAdapter>([['razorpay', razorpay]]);
    orchestrator = new PaymentOrchestrator({
      paymentRepo,
      breakerManager: new CircuitBreakerManager({ redis }),
      healthTracker,
      adapters,
    });

    const worker = new ResolutionWorker({
      pool,
      paymentRepo,
      adapters,
      orchestrator,
    });

    // Payment has passed resolution deadline (resolution_deadline_at < NOW())
    const paymentRes = await pool.query(
      `INSERT INTO payments (
        business_id, idempotency_key, request_hash, amount_minor, currency,
        payment_method, status, deadline_at, resolution_deadline_at, next_action_time
      ) VALUES (
        $1, $2, $3, 10000, 'INR', 'card', 'unknown',
        NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '1 second'
      ) RETURNING *`,
      [testBusinessId, `idem_deadline_${Date.now()}`, '1111111111111111111111111111111111111111111111111111111111111111']
    );
    const payment = paymentRes.rows[0];

    await pool.query(
      `INSERT INTO payment_attempts (
        payment_id, attempt_no, provider, routing_reason, decision_trace, status, error_class
      ) VALUES ($1, 1, 'razorpay', 'priority pick', '{}', 'unknown', 'ambiguous')`,
      [payment.id]
    );

    await worker.processDuePayments();

    const updated = await paymentRepo.getPaymentWithAttempts(payment.id);
    // Non-negotiable Rule 7: Must remain 'unknown' and flagged with needs_review = true. NEVER marked failed!
    expect(updated?.payment.status).toBe('unknown');
    expect(updated?.payment.needsReview).toBe(true);
    expect(updated?.payment.nextActionTime).toBeNull(); // Stopped retrying
  });
});
