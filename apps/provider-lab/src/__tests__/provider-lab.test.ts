import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildProviderLabServer } from '../server.js';
import { FastifyInstance } from 'fastify';

describe('Provider Lab - Controlled Failure Server & Independent Charge Ledger', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildProviderLabServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('HEALTHY: processes Stripe payment intent and records charge in ledger', async () => {
    // Reset ledger and set healthy
    await app.inject({ method: 'POST', url: '/lab/charges/reset' });
    await app.inject({
      method: 'POST',
      url: '/lab/providers/stripe/mode',
      payload: { mode: 'healthy' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/stripe/v1/payment_intents',
      headers: {
        'idempotency-key': 'idem_stripe_healthy_1',
      },
      payload: {
        amount: 5000,
        currency: 'inr',
        payment_method_types: ['card'],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toMatch(/^pi_/);
    expect(body.status).toBe('succeeded');

    // Verify charge was recorded in Provider Lab's independent ledger
    const ledgerRes = await app.inject({ method: 'GET', url: '/lab/charges' });
    const charges = JSON.parse(ledgerRes.body);
    expect(charges.length).toBe(1);
    expect(charges[0].provider).toBe('stripe');
    expect(charges[0].idempotencyKey).toBe('idem_stripe_healthy_1');
    expect(charges[0].amountMinor).toBe('5000');
  });

  it('RESPONSE_LOST: records charge in ledger but returns gateway drop, then resolves via status query', async () => {
    await app.inject({
      method: 'POST',
      url: '/lab/providers/stripe/mode',
      payload: { mode: 'response_lost' },
    });

    const key = `idem_lost_${Date.now()}`;
    const submitRes = await app.inject({
      method: 'POST',
      url: '/stripe/v1/payment_intents',
      headers: { 'idempotency-key': key },
      payload: { amount: 8000, currency: 'inr' },
    });

    // Response lost returns 504 / drop
    expect(submitRes.statusCode).toBe(504);

    // CRUCIAL: The charge WAS recorded in the Provider Lab's ledger!
    const ledgerRes = await app.inject({ method: 'GET', url: '/lab/charges' });
    const charges = JSON.parse(ledgerRes.body);
    const lostCharge = charges.find((c: any) => c.idempotencyKey === key);
    expect(lostCharge).toBeDefined();
    expect(lostCharge.status).toBe('succeeded');

    // Status query reveals that payment actually succeeded
    const statusRes = await app.inject({
      method: 'GET',
      url: `/stripe/v1/payment_intents/${lostCharge.providerRef}`,
    });
    expect(statusRes.statusCode).toBe(200);
    const statusBody = JSON.parse(statusRes.body);
    expect(statusBody.status).toBe('succeeded');
  });

  it('HARD_DECLINE: returns 400 card_declined with insufficient_funds and records NO charge', async () => {
    await app.inject({
      method: 'POST',
      url: '/lab/providers/stripe/mode',
      payload: { mode: 'hard_decline' },
    });

    const key = `idem_decline_${Date.now()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/stripe/v1/payment_intents',
      headers: { 'idempotency-key': key },
      payload: { amount: 5000, currency: 'inr' },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('card_declined');
    expect(body.error.decline_code).toBe('insufficient_funds');

    // No charge in ledger
    const ledgerRes = await app.inject({ method: 'GET', url: '/lab/charges' });
    const charges = JSON.parse(ledgerRes.body);
    const charge = charges.find((c: any) => c.idempotencyKey === key);
    expect(charge).toBeUndefined();
  });

  it('RATE_LIMITED: returns 429 Too Many Requests with Retry-After header', async () => {
    await app.inject({
      method: 'POST',
      url: '/lab/providers/razorpay/mode',
      payload: { mode: 'rate_limited', retryAfterSec: 3 },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/razorpay/v1/orders',
      payload: { amount: 1000, currency: 'INR', receipt: 'rcpt_123' },
    });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3');
  });

  it('CONFIG_ERROR: returns 401 Unauthorized for invalid credentials simulation', async () => {
    await app.inject({
      method: 'POST',
      url: '/lab/providers/payu/mode',
      payload: { mode: 'config_error' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/payu/payment',
      payload: { txnid: 'tx_123', amount: '200.00' },
    });

    expect(res.statusCode).toBe(401);
  });
});
