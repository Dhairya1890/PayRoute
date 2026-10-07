import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pool } from '../../db/pool.js';
import { PaymentRepository } from '../../db/payment-repository.js';
import { CircuitBreakerManager } from '../../resilience/circuit-breaker-manager.js';
import { HealthTracker } from '../../resilience/health-tracker.js';
import { PaymentOrchestrator } from '../orchestrator.js';
import { ProviderAdapter, SubmitPaymentRequest, SubmitPaymentResult, GetStatusResult, CancelResult } from '@payroute/providers';
import { OutcomeClass } from '@payroute/core';
import Redis from 'ioredis';

describe('Payment Orchestrator - Core Routing & Invariants', () => {
  let redis: Redis;
  let subRedis: Redis;
  let breakerManager: CircuitBreakerManager;
  let healthTracker: HealthTracker;
  let paymentRepo: PaymentRepository;
  let testBusinessId: string;

  beforeEach(async () => {
    redis = new Redis({ host: '127.0.0.1', port: 6380 });
    subRedis = new Redis({ host: '127.0.0.1', port: 6380, enableReadyCheck: false });
    await redis.flushdb();

    paymentRepo = new PaymentRepository(pool);
    breakerManager = new CircuitBreakerManager({ redis });
    healthTracker = new HealthTracker({
      redis,
      subRedis,
      providers: ['razorpay', 'stripe', 'payu'],
      methods: ['card', 'upi', 'netbanking'],
    });
    await healthTracker.init();

    // Create a unique test business
    const res = await pool.query(
      `INSERT INTO businesses (name) VALUES ('Orchestrator Test Business') RETURNING id`
    );
    testBusinessId = res.rows[0].id;
  });

  afterEach(async () => {
    await healthTracker.close();
    await redis.quit();
    subRedis.disconnect();
  });

  function createMockAdapter(name: string, overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
    return {
      name,
      capabilities: {
        supportsIdempotency: true,
        supportsStatusLookup: true,
        supportsCancel: false,
        supportedMethods: ['card', 'upi', 'netbanking'],
        supportedCurrencies: ['INR', 'USD'],
      },
      submit: async (req: SubmitPaymentRequest, ref: string): Promise<SubmitPaymentResult> => {
        return {
          providerRef: `${name}_ref_${Date.now()}`,
          status: 'succeeded',
          rawResponse: { ok: true },
        };
      },
      getStatus: async (ref: string, pRef?: string): Promise<GetStatusResult> => {
        return {
          providerRef: pRef || ref,
          status: 'succeeded',
          rawResponse: { ok: true },
        };
      },
      cancel: async (): Promise<CancelResult> => ({ success: false, supported: false }),
      classify: (res: any): OutcomeClass => {
        if (res instanceof Error) {
          const err = res as any;
          if (err.message === 'HARD_DECLINE') return 'hard_decline';
          if (err.message === 'SOFT_DECLINE') return 'soft_decline';
          if (err.message === 'NOT_SENT') return 'not_sent';
          if (err.message === 'TRANSIENT') return 'transient_known';
          if (err.message === 'TIMEOUT') return 'ambiguous';
        }
        return 'success';
      },
      ...overrides,
    };
  }

  it('Happy Path: chooses highest priority provider and completes payment in 1 attempt', async () => {
    const razorpay = createMockAdapter('razorpay');
    const stripe = createMockAdapter('stripe');
    const payu = createMockAdapter('payu');

    const orchestrator = new PaymentOrchestrator({
      paymentRepo,
      breakerManager,
      healthTracker,
      adapters: new Map([
        ['razorpay', razorpay],
        ['stripe', stripe],
        ['payu', payu],
      ]),
      strategy: 'priority',
      explorationShare: 0,
    });

    const result = await orchestrator.execute({
      businessId: testBusinessId,
      idempotencyKey: `orch_happy_${Date.now()}`,
      amountMinor: 50000n,
      currency: 'INR',
      paymentMethod: 'card',
      customerReference: 'cust_1',
    });

    expect(result.payment.status).toBe('succeeded');
    expect(result.payment.finalProvider).toBe('razorpay');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].provider).toBe('razorpay');
    expect(result.attempts[0].status).toBe('succeeded');
    expect(result.attempts[0].decisionTrace).toBeDefined();
  });

  it('Hard Decline: customer error fails payment immediately with ZERO retry or failover', async () => {
    const razorpay = createMockAdapter('razorpay', {
      submit: async () => {
        throw new Error('HARD_DECLINE');
      },
    });
    const stripe = createMockAdapter('stripe');
    const payu = createMockAdapter('payu');

    const stripeSubmit = vi.spyOn(stripe, 'submit');

    const orchestrator = new PaymentOrchestrator({
      paymentRepo,
      breakerManager,
      healthTracker,
      adapters: new Map([
        ['razorpay', razorpay],
        ['stripe', stripe],
        ['payu', payu],
      ]),
      strategy: 'priority',
      explorationShare: 0,
    });

    const result = await orchestrator.execute({
      businessId: testBusinessId,
      idempotencyKey: `orch_hard_decline_${Date.now()}`,
      amountMinor: 25000n,
      currency: 'INR',
      paymentMethod: 'card',
    });

    expect(result.payment.status).toBe('failed');
    expect(result.payment.failureReason).toContain('hard_decline');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].provider).toBe('razorpay');
    expect(result.attempts[0].status).toBe('failed');
    // Invariant: NEVER retry another provider on a hard customer decline
    expect(stripeSubmit).not.toHaveBeenCalled();
  });

  it('Outage Failover: when Provider A fails with not_sent, fails over to Provider B', async () => {
    const razorpay = createMockAdapter('razorpay', {
      submit: async () => {
        throw new Error('NOT_SENT');
      },
    });
    const stripe = createMockAdapter('stripe');
    const payu = createMockAdapter('payu');

    const orchestrator = new PaymentOrchestrator({
      paymentRepo,
      breakerManager,
      healthTracker,
      adapters: new Map([
        ['razorpay', razorpay],
        ['stripe', stripe],
        ['payu', payu],
      ]),
      strategy: 'priority',
    });

    const result = await orchestrator.execute({
      businessId: testBusinessId,
      idempotencyKey: `orch_failover_${Date.now()}`,
      amountMinor: 15000n,
      currency: 'INR',
      paymentMethod: 'card',
    });

    expect(result.payment.status).toBe('succeeded');
    expect(result.payment.finalProvider).toBe('stripe');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].provider).toBe('razorpay');
    expect(result.attempts[0].status).toBe('failed');
    expect(result.attempts[0].errorClass).toBe('not_sent');
    expect(result.attempts[1].provider).toBe('stripe');
    expect(result.attempts[1].status).toBe('succeeded');
  });

  it('Ambiguous Outcome with Charged Status: status query detects charge, completes without second debit', async () => {
    let submitCount = 0;
    const testProviderRef = `rzp_resolved_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const razorpay = createMockAdapter('razorpay', {
      submit: async () => {
        submitCount++;
        throw new Error('TIMEOUT'); // Network drops after provider debited!
      },
      getStatus: async (ref, pRef) => {
        // Status query confirms customer was indeed charged!
        return {
          providerRef: testProviderRef,
          status: 'succeeded',
          rawResponse: { charged: true },
        };
      },
    });
    const stripe = createMockAdapter('stripe');
    const stripeSubmit = vi.spyOn(stripe, 'submit');

    const orchestrator = new PaymentOrchestrator({
      paymentRepo,
      breakerManager,
      healthTracker,
      adapters: new Map([
        ['razorpay', razorpay],
        ['stripe', stripe],
      ]),
      strategy: 'priority',
      explorationShare: 0,
    });

    const result = await orchestrator.execute({
      businessId: testBusinessId,
      idempotencyKey: `orch_ambig_charged_${Date.now()}`,
      amountMinor: 80000n,
      currency: 'INR',
      paymentMethod: 'card',
    });

    expect(result.payment.status).toBe('succeeded');
    expect(result.payment.finalProvider).toBe('razorpay');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].status).toBe('succeeded');
    expect(result.attempts[0].providerRef).toBe(testProviderRef);

    // Invariant: ZERO duplicate charge! Did not fail over to Stripe!
    expect(stripeSubmit).not.toHaveBeenCalled();
    expect(submitCount).toBe(1);
  });

  it('Ambiguous Outcome with Inconclusive Status: marks unknown and does NOT double-charge', async () => {
    const razorpay = createMockAdapter('razorpay', {
      submit: async () => {
        throw new Error('TIMEOUT');
      },
      getStatus: async () => {
        // Provider status check also times out / cannot reach gateway
        throw new Error('TIMEOUT');
      },
    });
    const stripe = createMockAdapter('stripe');
    const stripeSubmit = vi.spyOn(stripe, 'submit');

    const orchestrator = new PaymentOrchestrator({
      paymentRepo,
      breakerManager,
      healthTracker,
      adapters: new Map([
        ['razorpay', razorpay],
        ['stripe', stripe],
      ]),
      strategy: 'priority',
      explorationShare: 0,
    });

    const result = await orchestrator.execute({
      businessId: testBusinessId,
      idempotencyKey: `orch_ambig_inconclusive_${Date.now()}`,
      amountMinor: 30000n,
      currency: 'INR',
      paymentMethod: 'card',
    });

    expect(result.payment.status).toBe('unknown');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].status).toBe('unknown');

    // Invariant: NEVER fail over blindly when outcome is uncertain!
    expect(stripeSubmit).not.toHaveBeenCalled();
  });
});
