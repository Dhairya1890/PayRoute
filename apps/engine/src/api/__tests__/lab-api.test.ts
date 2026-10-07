import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { pool } from '../../db/pool.js';
import { PaymentRepository } from '../../db/payment-repository.js';
import { CircuitBreakerManager } from '../../resilience/circuit-breaker-manager.js';
import { HealthTracker } from '../../resilience/health-tracker.js';
import { PaymentOrchestrator } from '../../orchestration/orchestrator.js';
import { buildApp } from '../app.js';
import { ProviderAdapter, SubmitPaymentRequest, SubmitPaymentResult, GetStatusResult, CancelResult } from '@payroute/providers';

describe('Routing Lab API Endpoints - Integration Tests', () => {
  let app: FastifyInstance;
  let redis: Redis;
  let subRedis: Redis;
  let breakerManager: CircuitBreakerManager;
  let healthTracker: HealthTracker;
  let paymentRepo: PaymentRepository;
  let orchestrator: PaymentOrchestrator;
  let adapters: Map<string, ProviderAdapter>;
  const apiKey = 'test_engine_key_12345';

  beforeAll(async () => {
    process.env.PROVIDER_TARGET = 'lab';
    process.env.ENGINE_API_KEY = apiKey;

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

    const mockAdapter = (name: string): ProviderAdapter => ({
      name,
      capabilities: {
        supportsIdempotency: true,
        supportsStatusLookup: true,
        supportsCancel: true,
        supportedMethods: ['card', 'upi', 'netbanking', 'wallet'],
        supportedCurrencies: ['INR', 'USD'],
      },
      submit: async (_req: SubmitPaymentRequest, ref: string): Promise<SubmitPaymentResult> => ({
        providerRef: `${name}_${ref}`,
        status: 'succeeded',
        rawResponse: { id: `${name}_${ref}`, status: 'succeeded' },
      }),
      getStatus: async (ref: string): Promise<GetStatusResult> => ({
        providerRef: `${name}_${ref}`,
        status: 'succeeded',
        rawResponse: {},
      }),
      cancel: async (): Promise<CancelResult> => ({ success: true, supported: true }),
      classify: () => 'success',
    });

    adapters = new Map([
      ['stripe', mockAdapter('stripe')],
      ['razorpay', mockAdapter('razorpay')],
      ['payu', mockAdapter('payu')],
    ]);

    orchestrator = new PaymentOrchestrator({
      paymentRepo,
      breakerManager,
      healthTracker,
      adapters,
      pool,
    });

    app = await buildApp({
      orchestrator,
      paymentRepo,
      healthTracker,
      redis,
    });
  });

  afterAll(async () => {
    await app.close();
    await healthTracker.close();
    await redis.quit();
    subRedis.disconnect();
  });

  it('POST /lab/runs starts a batch run and returns 202 with batch_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/lab/runs',
      headers: { 'x-api-key': apiKey },
      payload: {
        count: 10,
        rate: 50,
        method: 'card',
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.batch_id).toBeDefined();
    expect(body.status).toBe('running');
    expect(body.count).toBe(10);

    // Poll until the background batch finishes
    let scoreboard: any = null;
    for (let i = 0; i < 20; i++) {
      const scoreRes = await app.inject({
        method: 'GET',
        url: `/lab/runs/${body.batch_id}`,
        headers: { 'x-api-key': apiKey },
      });
      scoreboard = scoreRes.json();
      if (scoreboard.succeeded === 10) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(scoreboard.batch_id).toBe(body.batch_id);
    expect(scoreboard.sent).toBe(10);
    expect(scoreboard.succeeded).toBe(10);
    expect(scoreboard.duplicate_charges).toBe(0);
  }, 15000);

  it('POST /lab/scenarios/:name/run validates scenario name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/lab/scenarios/invalid_name/run',
      headers: { 'x-api-key': apiKey },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('BadRequest');
  });

  it('GET /lab/scenarios/provider_outage/results returns 404 if not yet run', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/lab/scenarios/provider_outage/results',
      headers: { 'x-api-key': apiKey },
    });

    expect(res.statusCode).toBe(404);
  });

  it('POST /lab/runs rejects with 400 NoEnabledProviders when all gateways supporting method are disabled', async () => {
    // Disable all providers in database
    await pool.query('UPDATE provider_config SET enabled = false');
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/lab/runs',
        headers: { 'x-api-key': apiKey },
        payload: {
          count: 5,
          rate: 10,
          method: 'card',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('NoEnabledProviders');
      expect(body.message).toContain('All payment providers supporting method "card" are disabled');
    } finally {
      // Restore provider configuration
      await pool.query('UPDATE provider_config SET enabled = true');
    }
  });
});
