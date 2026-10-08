import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { labLedger } from './ledger.js';
import { failureModes, FailureMode } from './failure-modes.js';

export async function buildProviderLabServer(): Promise<FastifyInstance> {
  const app = fastify({ logger: false });

  await app.register(cors, { origin: true });

  // -------------------------------------------------------------
  // Provider Lab Management & Monitoring Endpoints
  // -------------------------------------------------------------

  app.route({
    method: ['GET', 'HEAD'],
    url: '/',
    handler: async (req, reply) => {
      reply.header('x-service-name', 'payroute-provider-lab');
      reply.header('x-service-status', 'ok');
      reply.header('content-type', 'application/json; charset=utf-8');
      if (req.method === 'HEAD') {
        return reply.status(200).send();
      }
      return reply.status(200).send({
        status: 'ok',
        service: 'PayRoute Provider Lab',
        environment: 'lab',
      });
    },
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/health',
    handler: async (req, reply) => {
      reply.header('x-service-name', 'payroute-provider-lab');
      reply.header('x-service-status', 'ok');
      reply.header('content-type', 'application/json; charset=utf-8');
      if (req.method === 'HEAD') {
        return reply.status(200).send();
      }
      return reply.status(200).send({ status: 'ok', environment: 'lab' });
    },
  });

  app.get('/lab/status', async () => ({
    status: 'ok',
    environment: 'lab',
    label: 'Controlled Failure Provider Lab',
  }));

  app.get('/lab/providers/:name/mode', async (req) => {
    const { name } = req.params as { name: string };
    return failureModes.getMode(name);
  });

  app.post('/lab/providers/:name/mode', async (req) => {
    const { name } = req.params as { name: string };
    const body = req.body as { mode: FailureMode; latencyMs?: number; retryAfterSec?: number };
    failureModes.setMode(name, body);
    return { success: true, provider: name, config: failureModes.getMode(name) };
  });

  app.get('/lab/charges', async () => {
    return labLedger.getCharges();
  });

  app.post('/lab/charges/reset', async () => {
    labLedger.reset();
    failureModes.reset();
    return { success: true, message: 'Provider Lab ledger and modes reset' };
  });

  // Helper to handle failure mode injection
  const handleFailureMode = async (
    provider: string,
    reply: any,
    idempotencyKey: string,
    amountMinor: string,
    currency: string,
    reqBody?: any
  ): Promise<boolean> => {
    const config = failureModes.getMode(provider);
    const meta = reqBody?.metadata || reqBody?.notes || {};
    const forceHard = config.mode === 'hard_decline' || meta.isHardDecline === true;
    const forceSoft = config.mode === 'soft_decline' || meta.isSoftDecline === true;

    if (config.mode === 'slow') {
      await new Promise((r) => setTimeout(r, config.latencyMs ?? 3000));
    }

    if (config.mode === 'unavailable') {
      reply.status(503).send({ error: 'Service Unavailable', code: 'GATEWAY_DOWN' });
      return true;
    }

    if (config.mode === 'config_error') {
      reply.status(401).send({ error: 'Unauthorized', message: 'Invalid API Key or Credentials' });
      return true;
    }

    if (config.mode === 'rate_limited') {
      reply
        .status(429)
        .header('retry-after', (config.retryAfterSec ?? 2).toString())
        .send({ error: 'Too Many Requests', code: 'RATE_LIMIT_EXCEEDED' });
      return true;
    }

    if (forceHard) {
      reply.status(400).send({
        error: {
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: 'The card was declined due to insufficient funds.',
        },
      });
      return true;
    }

    if (forceSoft) {
      reply.status(400).send({
        error: {
          code: 'issuer_unavailable',
          decline_code: 'system_error',
          message: 'Card issuer network is temporarily unavailable.',
        },
      });
      return true;
    }

    if (config.mode === 'flaky') {
      if (Math.random() < 0.5) {
        reply.status(500).send({ error: 'Internal Server Error', code: 'TRANSIENT_ERROR' });
        return true;
      }
    }

    if (config.mode === 'response_lost') {
      // Record charge in ledger (charge succeeded on provider backend!)
      // but drop / timeout the HTTP response back to the client!
      const providerRef = `${provider}_lost_${Date.now()}`;
      labLedger.recordCharge({
        provider,
        providerRef,
        idempotencyKey,
        amountMinor,
        currency,
        status: 'succeeded',
      });
      reply.status(504).send({ error: 'Gateway Timeout: connection severed before response received' });
      return true;
    }

    return false; // Proceed to normal healthy execution
  };

  // -------------------------------------------------------------
  // Stripe Simulated Endpoints
  // -------------------------------------------------------------

  app.post('/stripe/v1/payment_intents', async (req, reply) => {
    const key = (req.headers['idempotency-key'] as string) || `stripe_key_${Date.now()}`;
    const body = (req.body as any) || {};
    const amount = (body.amount || 1000).toString();
    const currency = (body.currency || 'inr').toUpperCase();

    // Idempotency check: if key already executed successfully, return original charge
    const existing = labLedger.getCharges().find((c) => c.provider === 'stripe' && c.idempotencyKey === key);
    if (existing) {
      return reply.status(200).send({
        id: existing.providerRef,
        object: 'payment_intent',
        amount: Number(existing.amountMinor),
        currency: existing.currency.toLowerCase(),
        status: existing.status,
        created: Math.floor(Date.now() / 1000),
      });
    }

    const handled = await handleFailureMode('stripe', reply, key, amount, currency, body);
    if (handled) return;

    const providerRef = `pi_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    labLedger.recordCharge({
      provider: 'stripe',
      providerRef,
      idempotencyKey: key,
      amountMinor: amount,
      currency,
      status: 'succeeded',
    });

    return reply.status(200).send({
      id: providerRef,
      object: 'payment_intent',
      amount: Number(amount),
      currency: currency.toLowerCase(),
      status: 'succeeded',
      created: Math.floor(Date.now() / 1000),
    });
  });

  app.get('/stripe/v1/payment_intents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const charge =
      labLedger.findByRef('stripe', id) ||
      labLedger.getCharges().find((c) => c.provider === 'stripe' && c.idempotencyKey === id);
    if (!charge) {
      return reply.status(404).send({ error: { code: 'resource_missing', message: 'No such payment_intent' } });
    }
    return reply.status(200).send({
      id: charge.providerRef,
      object: 'payment_intent',
      amount: Number(charge.amountMinor),
      currency: charge.currency.toLowerCase(),
      status: charge.status,
    });
  });

  // -------------------------------------------------------------
  // Razorpay Simulated Endpoints
  // -------------------------------------------------------------

  app.post('/razorpay/v1/orders', async (req, reply) => {
    const body = (req.body as any) || {};
    const key = body.receipt || `rcpt_${Date.now()}`;
    const amount = (body.amount || 1000).toString();
    const currency = (body.currency || 'INR').toUpperCase();

    // Idempotency check: if receipt already executed, return original order
    const existing = labLedger.getCharges().find((c) => c.provider === 'razorpay' && c.idempotencyKey === key);
    if (existing) {
      return reply.status(200).send({
        id: existing.providerRef,
        entity: 'order',
        amount: Number(existing.amountMinor),
        currency: existing.currency,
        receipt: key,
        status: 'paid',
        created_at: Math.floor(Date.now() / 1000),
      });
    }

    const handled = await handleFailureMode('razorpay', reply, key, amount, currency, body);
    if (handled) return;

    const providerRef = `order_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    labLedger.recordCharge({
      provider: 'razorpay',
      providerRef,
      idempotencyKey: key,
      amountMinor: amount,
      currency,
      status: 'succeeded',
    });

    return reply.status(200).send({
      id: providerRef,
      entity: 'order',
      amount: Number(amount),
      currency,
      receipt: key,
      status: 'paid',
      created_at: Math.floor(Date.now() / 1000),
    });
  });

  app.get('/razorpay/v1/orders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const charge =
      labLedger.findByRef('razorpay', id) ||
      labLedger.getCharges().find((c) => c.provider === 'razorpay' && c.idempotencyKey === id);
    if (!charge) {
      return reply.status(404).send({ error: { code: 'BAD_REQUEST_ERROR', description: 'Order not found' } });
    }
    return reply.status(200).send({
      id: charge.providerRef,
      entity: 'order',
      amount: Number(charge.amountMinor),
      currency: charge.currency,
      status: 'paid',
    });
  });

  // -------------------------------------------------------------
  // PayU Simulated Endpoints
  // -------------------------------------------------------------

  app.post('/payu/payment', async (req, reply) => {
    const body = (req.body as any) || {};
    const key = body.txnid || `tx_${Date.now()}`;
    const amount = (body.amount || '10.00').toString();
    const currency = 'INR';

    // Idempotency check: if txnid already executed, return original transaction
    const existing = labLedger.getCharges().find((c) => c.provider === 'payu' && c.idempotencyKey === key);
    if (existing) {
      return reply.status(200).send({
        status: 'success',
        txnid: key,
        mihpayid: existing.providerRef,
        amount: existing.amountMinor,
        mode: 'CC',
      });
    }

    const handled = await handleFailureMode('payu', reply, key, amount, currency, body);
    if (handled) return;

    const providerRef = `payu_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    labLedger.recordCharge({
      provider: 'payu',
      providerRef,
      idempotencyKey: key,
      amountMinor: amount,
      currency,
      status: 'succeeded',
    });

    return reply.status(200).send({
      status: 'success',
      txnid: key,
      mihpayid: providerRef,
      amount,
      mode: 'CC',
    });
  });

  app.post('/payu/verify_payment', async (req, reply) => {
    const body = (req.body as any) || {};
    const txnid = body.var1;
    const charges = labLedger.getCharges();
    const charge = charges.find((c) => c.provider === 'payu' && c.idempotencyKey === txnid);

    if (!charge) {
      return reply.status(200).send({ status: 0, msg: 'Transaction not found' });
    }

    return reply.status(200).send({
      status: 1,
      transaction_details: {
        [txnid]: {
          mihpayid: charge.providerRef,
          status: 'success',
          amt: charge.amountMinor,
        },
      },
    });
  });

  return app;
}
