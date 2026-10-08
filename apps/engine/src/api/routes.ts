import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PaymentOrchestrator } from '../orchestration/orchestrator.js';
import { PaymentRepository, IdempotencyConflictError } from '../db/payment-repository.js';
import { HealthTracker } from '../resilience/health-tracker.js';
import { ProviderConfigCache } from '../orchestration/provider-config-cache.js';
import { pool } from '../db/pool.js';
import type { Redis } from 'ioredis';

export interface RouteDependencies {
  orchestrator: PaymentOrchestrator;
  paymentRepo: PaymentRepository;
  healthTracker: HealthTracker;
  redis: Redis;
  configCache?: ProviderConfigCache;
}

const CreatePaymentSchema = z.object({
  amount_minor: z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(BigInt), z.bigint()]),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/),
  payment_method: z.enum(['card', 'upi', 'netbanking', 'wallet']).default('card'),
  customer_reference: z.string().max(100).optional(),
  batch_id: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const apiRoutes = (deps: RouteDependencies): FastifyPluginAsync => {
  return async (app: FastifyInstance) => {
    // -------------------------------------------------------------
    // 1. Health & Monitoring Probes
    // -------------------------------------------------------------
    // Root heartbeat & uptime probe (supports HEAD and GET for load balancers & monitoring services)
    app.route({
      method: ['GET', 'HEAD'],
      url: '/',
      handler: async (req, reply) => {
        reply.header('x-service-name', 'payroute-engine');
        reply.header('x-service-status', 'ok');
        reply.header('x-uptime-seconds', Math.floor(process.uptime()).toString());
        reply.header('content-type', 'application/json; charset=utf-8');
        if (req.method === 'HEAD') {
          return reply.status(200).send();
        }
        return reply.status(200).send({
          status: 'ok',
          service: 'PayRoute Engine',
          version: '0.1.0',
          timestamp: new Date().toISOString(),
        });
      },
    });

    // Health check endpoint (supports HEAD and GET for uptime monitors)
    app.route({
      method: ['GET', 'HEAD'],
      url: '/health',
      handler: async (req, reply) => {
        reply.header('x-service-name', 'payroute-engine');
        reply.header('x-service-status', 'ok');
        reply.header('x-uptime-seconds', Math.floor(process.uptime()).toString());
        reply.header('content-type', 'application/json; charset=utf-8');
        if (req.method === 'HEAD') {
          return reply.status(200).send();
        }
        return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
      },
    });

    // Liveness probe endpoint (supports HEAD and GET for container orchestrators)
    app.route({
      method: ['GET', 'HEAD'],
      url: '/live',
      handler: async (req, reply) => {
        reply.header('x-service-name', 'payroute-engine');
        reply.header('x-service-status', 'ok');
        reply.header('x-uptime-seconds', Math.floor(process.uptime()).toString());
        reply.header('content-type', 'application/json; charset=utf-8');
        if (req.method === 'HEAD') {
          return reply.status(200).send();
        }
        return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
      },
    });

    // Readiness probe endpoint (supports HEAD and GET for dependency verification)
    app.route({
      method: ['GET', 'HEAD'],
      url: '/ready',
      handler: async (req, reply) => {
        reply.header('x-service-name', 'payroute-engine');
        reply.header('content-type', 'application/json; charset=utf-8');
        let pgOk = false;
        let redisOk = false;

        try {
          await pool.query('SELECT 1');
          pgOk = true;
        } catch {
          pgOk = false;
        }

        try {
          const ping = await deps.redis.ping();
          redisOk = ping === 'PONG';
        } catch {
          redisOk = false;
        }

        const isDegraded = deps.healthTracker.isDegraded();

        if (!pgOk) {
          reply.header('x-service-status', 'down');
          if (req.method === 'HEAD') {
            return reply.status(503).send();
          }
          return reply.status(503).send({ status: 'down', postgres: false, redis: redisOk });
        }

        if (!redisOk || isDegraded) {
          reply.header('x-service-status', 'degraded');
          if (req.method === 'HEAD') {
            return reply.status(200).send();
          }
          return reply.status(200).send({
            status: 'degraded',
            postgres: true,
            redis: redisOk,
            message: 'Running in Redis degraded mode (using in-memory health snapshot)',
          });
        }

        reply.header('x-service-status', 'ready');
        if (req.method === 'HEAD') {
          return reply.status(200).send();
        }
        return reply.status(200).send({ status: 'ready', postgres: true, redis: true });
      },
    });

    app.route({
      method: ['GET', 'HEAD'],
      url: '/config',
      handler: async () => {
        return {
          environment: process.env.PROVIDER_TARGET || 'lab',
          version: '0.1.0',
          node: process.version,
        };
      },
    });

    // -------------------------------------------------------------
    // 2. Payments API
    // -------------------------------------------------------------
    app.post('/payments', async (req, reply) => {
      const idempotencyKey = req.headers['idempotency-key'] as string;
      if (!idempotencyKey || idempotencyKey.trim().length === 0) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: 'Missing required header: Idempotency-Key',
        });
      }

      const parseResult = CreatePaymentSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'ValidationError',
          details: parseResult.error.flatten(),
        });
      }

      const body = parseResult.data;
      const amountMinor = typeof body.amount_minor === 'bigint' ? body.amount_minor : BigInt(body.amount_minor);

      // Business ID (from business accounts or default system tenant)
      const businessId = (req.headers['x-business-id'] as string) || (await getOrCreateDefaultBusiness());

      try {
        const result = await deps.orchestrator.execute({
          businessId,
          idempotencyKey,
          amountMinor,
          currency: body.currency,
          paymentMethod: body.payment_method,
          customerReference: body.customer_reference,
          batchId: body.batch_id,
          metadata: body.metadata,
        });

        const responsePayload = {
          id: result.payment.id,
          idempotency_key: result.payment.idempotencyKey,
          amount_minor: result.payment.amountMinor.toString(),
          currency: result.payment.currency,
          payment_method: result.payment.paymentMethod,
          status: result.payment.status,
          final_provider: result.payment.finalProvider,
          failure_reason: result.payment.failureReason,
          needs_review: result.payment.needsReview,
          batch_id: result.payment.batchId,
          is_replay: result.isReplay,
          attempts: result.attempts.map((a) => ({
            id: a.id,
            attempt_no: a.attemptNo,
            provider: a.provider,
            provider_ref: a.providerRef,
            status: a.status,
            error_class: a.errorClass,
            latency_ms: a.latencyMs,
            routing_reason: a.routingReason,
            decision_trace: a.decisionTrace,
            started_at: a.startedAt.toISOString(),
            finished_at: a.finishedAt ? a.finishedAt.toISOString() : null,
          })),
          created_at: result.payment.createdAt.toISOString(),
          updated_at: result.payment.updatedAt.toISOString(),
        };

        // Section 10 Rule: Returns 202 with status unknown/processing when deadline passes or outcome is uncertain
        if (result.payment.status === 'unknown' || result.payment.status === 'processing') {
          return reply.status(202).send(responsePayload);
        }

        return reply.status(200).send(responsePayload);
      } catch (err: any) {
        if (err instanceof IdempotencyConflictError || err.statusCode === 422) {
          return reply.status(422).send({
            error: 'IdempotencyConflict',
            message: err.message,
          });
        }
        req.log.error(err);
        return reply.status(500).send({
          error: 'InternalServerError',
          message: err.message,
        });
      }
    });

    app.get('/payments/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const record = await deps.paymentRepo.getPaymentWithAttempts(id);
      if (!record) {
        return reply.status(404).send({ error: 'NotFound', message: `Payment "${id}" not found` });
      }

      const formattedPayment = formatPaymentRecord(record.payment);
      const formattedAttempts = record.attempts.map(formatAttemptRecord);

      return {
        ...formattedPayment,
        payment: formattedPayment,
        attempts: formattedAttempts,
      };
    });

    app.get('/payments', async (req) => {
      const query = req.query as { status?: any; provider?: string; batch_id?: string; limit?: string };
      const records = await deps.paymentRepo.getPayments({
        status: query.status,
        provider: query.provider,
        batchId: query.batch_id,
        limit: query.limit ? parseInt(query.limit, 10) : 50,
      });

      return records.map(formatPaymentRecord);
    });

    // -------------------------------------------------------------
    // 3. Providers API
    // -------------------------------------------------------------
    app.get('/providers', async () => {
      const res = await pool.query('SELECT * FROM provider_config ORDER BY priority ASC');
      return res.rows.map((row) => {
        const health = deps.healthTracker.getSnapshot(row.name, 'card');
        return {
          name: row.name,
          enabled: row.enabled,
          priority: row.priority,
          cost_bps: row.cost_bps,
          timeout_ms: row.timeout_ms,
          supported_methods: row.supported_methods,
          supported_currencies: row.supported_currencies,
          breaker_state: health.breakerState,
          smoothed_success_rate: health.smoothedSuccessRate,
          p95_latency_ms: health.p95LatencyMs,
          consecutive_opens: health.consecutiveOpens,
        };
      });
    });

    app.patch('/providers/:name', async (req, reply) => {
      const { name } = req.params as { name: string };
      const body = req.body as { enabled?: boolean; priority?: number; cost_bps?: number; timeout_ms?: number };

      const updates: string[] = [];
      const values: unknown[] = [name];
      let idx = 2;

      if (body.enabled !== undefined) {
        updates.push(`enabled = $${idx++}`);
        values.push(body.enabled);
      }
      if (body.priority !== undefined) {
        updates.push(`priority = $${idx++}`);
        values.push(body.priority);
      }
      if (body.cost_bps !== undefined) {
        updates.push(`cost_bps = $${idx++}`);
        values.push(body.cost_bps);
      }
      if (body.timeout_ms !== undefined) {
        updates.push(`timeout_ms = $${idx++}`);
        values.push(body.timeout_ms);
      }

      if (updates.length === 0) {
        return reply.status(400).send({ error: 'BadRequest', message: 'No fields provided to update' });
      }

      const sql = `UPDATE provider_config SET ${updates.join(', ')} WHERE name = $1 RETURNING *`;
      const res = await pool.query(sql, values);

      if (res.rows.length === 0) {
        return reply.status(404).send({ error: 'NotFound', message: `Provider "${name}" not found` });
      }

      await deps.configCache?.invalidate();

      return res.rows[0];
    });

    // -------------------------------------------------------------
    // 4. Engine Settings API
    // -------------------------------------------------------------
    app.get('/settings', async () => {
      const res = await pool.query('SELECT key, value FROM engine_settings');
      const settingsMap: Record<string, unknown> = {};
      for (const row of res.rows) {
        settingsMap[row.key] = row.value;
      }
      return settingsMap;
    });

    app.put('/settings', async (req) => {
      const body = req.body as Record<string, unknown>;
      for (const [key, value] of Object.entries(body)) {
        await deps.paymentRepo.setEngineSetting(key, value);
      }
      await deps.configCache?.invalidate();
      return { success: true, updated: Object.keys(body) };
    });
  };
};

async function getOrCreateDefaultBusiness(): Promise<string> {
  const existing = await pool.query("SELECT id FROM businesses WHERE name = 'Default Business' LIMIT 1");
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }
  const created = await pool.query(
    "INSERT INTO businesses (name) VALUES ('Default Business') RETURNING id"
  );
  return created.rows[0].id;
}

function formatPaymentRecord(p: any) {
  const amountMinorStr = (p.amountMinor !== undefined ? p.amountMinor : p.amount_minor)?.toString() || '0';
  return {
    id: p.id,
    business_id: p.businessId || p.business_id,
    idempotency_key: p.idempotencyKey || p.idempotency_key,
    request_hash: p.requestHash || p.request_hash,
    amount_minor: amountMinorStr,
    currency: p.currency,
    payment_method: p.paymentMethod || p.payment_method,
    status: p.status,
    customer_reference: p.customerReference !== undefined ? p.customerReference : p.customer_reference,
    batch_id: p.batchId !== undefined ? p.batchId : p.batch_id,
    final_provider: p.finalProvider !== undefined ? p.finalProvider : p.final_provider,
    failure_reason: p.failureReason !== undefined ? p.failureReason : p.failure_reason,
    deadline_at: p.deadlineAt instanceof Date ? p.deadlineAt.toISOString() : p.deadline_at,
    created_at: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.created_at,
    // camelCase aliases
    businessId: p.businessId || p.business_id,
    idempotencyKey: p.idempotencyKey || p.idempotency_key,
    requestHash: p.requestHash || p.request_hash,
    amountMinor: amountMinorStr,
    paymentMethod: p.paymentMethod || p.payment_method,
    customerReference: p.customerReference !== undefined ? p.customerReference : p.customer_reference,
    batchId: p.batchId !== undefined ? p.batchId : p.batch_id,
    finalProvider: p.finalProvider !== undefined ? p.finalProvider : p.final_provider,
    failureReason: p.failureReason !== undefined ? p.failureReason : p.failure_reason,
  };
}

function formatAttemptRecord(a: any) {
  return {
    id: a.id,
    payment_id: a.paymentId || a.payment_id,
    attempt_no: a.attemptNo !== undefined ? a.attemptNo : a.attempt_no,
    provider: a.provider,
    provider_ref: a.providerRef !== undefined ? a.providerRef : a.provider_ref,
    provider_error_code: a.providerErrorCode !== undefined ? a.providerErrorCode : a.provider_error_code,
    status: a.status,
    error_class: a.errorClass !== undefined ? a.errorClass : a.error_class,
    latency_ms: a.latencyMs !== undefined ? a.latencyMs : a.latency_ms,
    routing_reason: a.routingReason || a.routing_reason,
    decision_trace: a.decisionTrace || a.decision_trace || {},
    started_at: a.startedAt instanceof Date ? a.startedAt.toISOString() : a.started_at,
    finished_at: a.finishedAt instanceof Date ? a.finishedAt.toISOString() : a.finished_at,
    // camelCase aliases
    attemptNo: a.attemptNo !== undefined ? a.attemptNo : a.attempt_no,
    providerRef: a.providerRef !== undefined ? a.providerRef : a.provider_ref,
    providerErrorCode: a.providerErrorCode !== undefined ? a.providerErrorCode : a.provider_error_code,
    errorClass: a.errorClass !== undefined ? a.errorClass : a.error_class,
    latencyMs: a.latencyMs !== undefined ? a.latencyMs : a.latency_ms,
    routingReason: a.routingReason || a.routing_reason,
    decisionTrace: a.decisionTrace || a.decision_trace || {},
  };
}
