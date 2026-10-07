import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { pool } from '../../db/pool.js';
import { PaymentRepository } from '../../db/payment-repository.js';
import { CircuitBreakerManager } from '../../resilience/circuit-breaker-manager.js';
import { HealthTracker } from '../../resilience/health-tracker.js';
import { PaymentOrchestrator } from '../../orchestration/orchestrator.js';
import { ProviderAdapter, SubmitPaymentRequest, SubmitPaymentResult, GetStatusResult, CancelResult } from '@payroute/providers';
import { OutcomeClass } from '@payroute/core';
import Redis from 'ioredis';

describe('PayRoute Engine API - End-to-End Integration', () => {
  let app: FastifyInstance;
  let redis: Redis;
  let subRedis: Redis;
  let healthTracker: HealthTracker;
  const apiKey = 'test_engine_secret_key';

  beforeEach(async () => {
    process.env.ENGINE_API_KEY = apiKey;
    process.env.PROVIDER_TARGET = 'lab';

    redis = new Redis({ host: '127.0.0.1', port: 6380 });
    subRedis = new Redis({ host: '127.0.0.1', port: 6380, enableReadyCheck: false });
    await redis.flushdb();

    const paymentRepo = new PaymentRepository(pool);
    const breakerManager = new CircuitBreakerManager({ redis });
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
        supportsCancel: false,
        supportedMethods: ['card', 'upi'],
        supportedCurrencies: ['INR', 'USD'],
      },
      submit: async (req: SubmitPaymentRequest, ref: string): Promise<SubmitPaymentResult> => ({
        providerRef: `${name}_tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        status: 'succeeded',
        rawResponse: { ok: true },
      }),
      getStatus: async (ref: string, pRef?: string): Promise<GetStatusResult> => ({
        providerRef: pRef || ref,
        status: 'succeeded',
        rawResponse: { ok: true },
      }),
      cancel: async (): Promise<CancelResult> => ({ success: false, supported: false }),
      classify: (): OutcomeClass => 'success',
    });

    const orchestrator = new PaymentOrchestrator({
      paymentRepo,
      breakerManager,
      healthTracker,
      adapters: new Map([
        ['razorpay', mockAdapter('razorpay')],
        ['stripe', mockAdapter('stripe')],
        ['payu', mockAdapter('payu')],
      ]),
      strategy: 'priority',
      explorationShare: 0,
    });

    app = await buildApp({
      orchestrator,
      paymentRepo,
      healthTracker,
      redis,
    });
  });

  afterEach(async () => {
    await pool.query(`UPDATE engine_settings SET value = '"priority"'::jsonb WHERE key = 'routing_strategy'`);
    await pool.query(`UPDATE engine_settings SET value = '0.05'::jsonb WHERE key = 'exploration_share'`);
    await pool.query(`UPDATE provider_config SET cost_bps = 190 WHERE name = 'razorpay'`);
    await app.close();
    await healthTracker.close();
    await redis.quit();
    subRedis.disconnect();
  });

  it('GET /health and GET /ready return status ok without requiring authentication', async () => {
    const healthRes = await app.inject({ method: 'GET', url: '/health' });
    expect(healthRes.statusCode).toBe(200);
    expect(JSON.parse(healthRes.body).status).toBe('ok');

    const readyRes = await app.inject({ method: 'GET', url: '/ready' });
    expect(readyRes.statusCode).toBe(200);
    expect(JSON.parse(readyRes.body).status).toBe('ready');
  });

  it('GET /config returns environment label and version', async () => {
    const res = await app.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.environment).toBe('lab');
    expect(body.version).toBe('0.1.0');
  });

  it('Protects private endpoints with timing-safe ENGINE_API_KEY check', async () => {
    // Missing auth header
    const noAuth = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { 'idempotency-key': 'key_1' },
      payload: { amount_minor: 1000, currency: 'INR' },
    });
    expect(noAuth.statusCode).toBe(401);

    // Invalid API key
    const badAuth = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: {
        'idempotency-key': 'key_1',
        'x-api-key': 'wrong_key',
      },
      payload: { amount_minor: 1000, currency: 'INR' },
    });
    expect(badAuth.statusCode).toBe(401);
  });

  it('POST /payments validates required Idempotency-Key and body fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { 'x-api-key': apiKey },
      payload: { amount_minor: 1000, currency: 'INR' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('Idempotency-Key');
  });

  it('Executes payment, supports exact replays, and catches idempotency conflicts', async () => {
    const key = `api_test_${Date.now()}`;

    // 1. Initial payment request
    const res1 = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': key,
      },
      payload: {
        amount_minor: 75000,
        currency: 'INR',
        payment_method: 'card',
        customer_reference: 'cust_api_1',
      },
    });

    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.status).toBe('succeeded');
    expect(body1.final_provider).toBe('razorpay');
    expect(body1.is_replay).toBe(false);
    expect(body1.attempts).toHaveLength(1);
    expect(body1.attempts[0].decision_trace).toBeDefined();

    // 2. Exact Replay (same key, same body) -> 200 with is_replay: true
    const res2 = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': key,
      },
      payload: {
        amount_minor: 75000,
        currency: 'INR',
        payment_method: 'card',
        customer_reference: 'cust_api_1',
      },
    });

    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.id).toBe(body1.id);
    expect(body2.is_replay).toBe(true);

    // 3. Conflict (same key, different amount) -> 422 IdempotencyConflict
    const res3 = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': key,
      },
      payload: {
        amount_minor: 99999, // Different amount!
        currency: 'INR',
        payment_method: 'card',
      },
    });

    expect(res3.statusCode).toBe(422);
    expect(JSON.parse(res3.body).error).toBe('IdempotencyConflict');
  });

  it('GET /payments/:id retrieves stored payment record with attempt history', async () => {
    const key = `api_get_${Date.now()}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: {
        'x-api-key': apiKey,
        'idempotency-key': key,
      },
      payload: {
        amount_minor: 12000,
        currency: 'INR',
      },
    });
    const created = JSON.parse(createRes.body);

    const getRes = await app.inject({
      method: 'GET',
      url: `/payments/${created.id}`,
      headers: { 'x-api-key': apiKey },
    });

    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);
    expect(getBody.payment.id).toBe(created.id);
    expect(getBody.attempts).toHaveLength(1);
    expect(getBody.attempts[0].provider).toBe('razorpay');
  });

  it('GET /providers and PATCH /providers/:name updates provider parameters', async () => {
    const listRes = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { 'x-api-key': apiKey },
    });
    expect(listRes.statusCode).toBe(200);
    const providers = JSON.parse(listRes.body);
    expect(providers.length).toBeGreaterThanOrEqual(3);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/providers/razorpay',
      headers: { 'x-api-key': apiKey },
      payload: { cost_bps: 185 },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(JSON.parse(patchRes.body).cost_bps).toBe(185);
  });

  it('GET /settings and PUT /settings updates runtime engine configurations', async () => {
    const putRes = await app.inject({
      method: 'PUT',
      url: '/settings',
      headers: { 'x-api-key': apiKey },
      payload: {
        routing_strategy: 'lowest_cost',
        exploration_share: 0.1,
      },
    });
    expect(putRes.statusCode).toBe(200);

    const getRes = await app.inject({
      method: 'GET',
      url: '/settings',
      headers: { 'x-api-key': apiKey },
    });
    expect(getRes.statusCode).toBe(200);
    const settings = JSON.parse(getRes.body);
    expect(settings.routing_strategy).toBe('lowest_cost');
    expect(settings.exploration_share).toBe(0.1);
  });
});
