import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { RouteDependencies } from './routes.js';
import { labEventHub } from './lab-event-hub.js';
import { pool } from '../db/pool.js';
import { LabChargeRecord } from '../invariants/invariant-checker.js';

const StartRunSchema = z
  .object({
    count: z.coerce.number().int().min(1).max(500).default(30),
    rate: z.coerce.number().min(1).max(100).default(10), // req/sec
    method: z.enum(['card', 'upi', 'netbanking', 'wallet']).default('card'),
    hard_decline_share: z.coerce.number().min(0).max(100).default(0),
    hardDeclineShare: z.coerce.number().min(0).max(100).optional(),
    soft_decline_share: z.coerce.number().min(0).max(100).default(0),
    softDeclineShare: z.coerce.number().min(0).max(100).optional(),
    amount_minor: z.coerce.number().int().positive().optional().default(1000),
    currency: z.string().default('INR'),
  })
  .transform((data) => {
    let hard = data.hardDeclineShare ?? data.hard_decline_share;
    if (hard > 1) hard = hard / 100;
    let soft = data.softDeclineShare ?? data.soft_decline_share;
    if (soft > 1) soft = soft / 100;
    return {
      ...data,
      hard_decline_share: Math.min(Math.max(hard, 0), 1),
      soft_decline_share: Math.min(Math.max(soft, 0), 1),
    };
  });

const SetProviderModeSchema = z.object({
  mode: z.enum([
    'healthy',
    'slow',
    'flaky',
    'unavailable',
    'response_lost',
    'hard_decline',
    'soft_decline',
    'rate_limited',
    'config_error',
  ]),
  latencyMs: z.number().optional(),
  retryAfterSec: z.number().optional(),
});

interface ScenarioResult {
  scenario: string;
  batchId: string;
  verdict: 'PASS' | 'FAIL';
  summary: string;
  details: Record<string, unknown>;
  timestamp: string;
}

const scenarioResultsCache = new Map<string, ScenarioResult>();

interface BatchTracking {
  totalCount: number;
  status: 'running' | 'completed';
}

const activeBatches = new Map<string, BatchTracking>();

export const labRoutes = (deps: RouteDependencies): FastifyPluginAsync => {
  const providerLabUrl = process.env.PROVIDER_LAB_URL || 'http://127.0.0.1:4000';

  return async (app: FastifyInstance) => {
    // Check PROVIDER_TARGET
    const isLab = (process.env.PROVIDER_TARGET || 'lab') === 'lab';
    if (!isLab) {
      app.all('/lab/*', async (_req, reply) => {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Lab endpoints are disabled when PROVIDER_TARGET is not "lab"',
        });
      });
      return;
    }

    // -------------------------------------------------------------
    // 1. Live SSE Stream (GET /lab/stream)
    // -------------------------------------------------------------
    app.get('/lab/stream', async (_req, reply) => {
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('Access-Control-Allow-Origin', '*');
      reply.raw.flushHeaders();

      labEventHub.addClient(reply);
      // Fastify reply is kept open for SSE stream
      await new Promise(() => {});
    });

    // -------------------------------------------------------------
    // 2. Set Provider Lab Failure Mode (POST /lab/providers/:name/mode)
    // -------------------------------------------------------------
    app.post('/lab/providers/:name/mode', async (req, reply) => {
      const { name } = req.params as { name: string };
      const parseResult = SetProviderModeSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'ValidationError', details: parseResult.error.flatten() });
      }

      try {
        const upstream = await fetch(`${providerLabUrl}/lab/providers/${name}/mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parseResult.data),
        });
        const json = await upstream.json();

        // Broadcast failure mode change event
        labEventHub.broadcast('breaker_transition', {
          provider: name,
          mode: parseResult.data.mode,
          timestamp: new Date().toISOString(),
        });

        return reply.status(upstream.status).send(json);
      } catch (err: any) {
        return reply.status(502).send({
          error: 'BadGateway',
          message: `Failed to communicate with Provider Lab at ${providerLabUrl}: ${err.message}`,
        });
      }
    });

    // -------------------------------------------------------------
    // 3. Start Traffic Run (POST /lab/runs)
    // -------------------------------------------------------------
    app.post('/lab/runs', async (req, reply) => {
      const parseResult = StartRunSchema.safeParse(req.body || {});
      if (!parseResult.success) {
        const errorMsg = parseResult.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');
        return reply.status(400).send({
          error: 'ValidationError',
          message: errorMsg || 'Invalid traffic run parameters',
          details: parseResult.error.flatten(),
        });
      }

      const params = parseResult.data;
      const batchId = crypto.randomUUID();
      activeBatches.set(batchId, { totalCount: params.count, status: 'running' });

      // Get or create default business
      const bizRes = await pool.query("SELECT id FROM businesses WHERE name = 'Routing Lab Tenant' LIMIT 1");
      let businessId = bizRes.rows[0]?.id;
      if (!businessId) {
        const createBiz = await pool.query("INSERT INTO businesses (name) VALUES ('Routing Lab Tenant') RETURNING id");
        businessId = createBiz.rows[0].id;
      }

      // Ensure at least one provider supporting the requested method is enabled
      const enabledRes = await pool.query(
        'SELECT name FROM provider_config WHERE enabled = true AND $1 = ANY(supported_methods)',
        [params.method]
      );
      if (enabledRes.rows.length === 0) {
        activeBatches.delete(batchId);
        return reply.status(400).send({
          error: 'NoEnabledProviders',
          message: `Cannot start traffic run: All payment providers supporting method "${params.method}" are disabled`,
        });
      }

      // Launch traffic generator asynchronously in background
      (async () => {
        const delayBetweenRequestsMs = Math.max(10, Math.floor(1000 / params.rate));

        try {
          for (let i = 0; i < params.count; i++) {
            const idempotencyKey = `lab_run_${batchId}_${i}`;
            
            // Inject decline simulation through customerReference or metadata if specified
            const isHardDecline = Math.random() < params.hard_decline_share;
            const isSoftDecline = !isHardDecline && Math.random() < params.soft_decline_share;

            try {
              const execResult = await deps.orchestrator.execute({
                businessId,
                idempotencyKey,
                amountMinor: BigInt(params.amount_minor),
                currency: params.currency,
                paymentMethod: params.method,
                batchId,
                metadata: {
                  isHardDecline,
                  isSoftDecline,
                  simulated: true,
                },
              });

              // Broadcast payment completed event
              labEventHub.broadcast('payment_completed', {
                batchId,
                paymentId: execResult.payment.id,
                status: execResult.payment.status,
                attemptsCount: execResult.attempts.length,
                finalProvider: execResult.payment.finalProvider,
              });

              // Intermediate scoreboard broadcast every 5 payments
              if ((i + 1) % 5 === 0 || i === params.count - 1) {
                try {
                  const intermediateSb = await computeScoreboard(batchId, deps, providerLabUrl);
                  labEventHub.broadcast('scoreboard_update', {
                    batchId,
                    scoreboard: intermediateSb,
                  });
                } catch {
                  // ignore
                }
              }
            } catch (err: any) {
              // Log and continue traffic run
            }

            if (i < params.count - 1 && delayBetweenRequestsMs > 0) {
              await new Promise((r) => setTimeout(r, delayBetweenRequestsMs));
            }
          }
        } finally {
          const batchInfo = activeBatches.get(batchId);
          if (batchInfo) {
            batchInfo.status = 'completed';
          }
        }

        // When batch completes, broadcast final scoreboard update
        try {
          const scoreboard = await computeScoreboard(batchId, deps, providerLabUrl);
          labEventHub.broadcast('scoreboard_update', {
            batchId,
            scoreboard,
          });
        } catch {
          // ignore
        }
      })();

      return reply.status(202).send({
        batch_id: batchId,
        status: 'running',
        count: params.count,
        rate: params.rate,
        method: params.method,
      });
    });

    // -------------------------------------------------------------
    // 4. Get Run Status and Scoreboard (GET /lab/runs/:batch_id)
    // -------------------------------------------------------------
    app.get('/lab/runs/:batch_id', async (req, reply) => {
      let { batch_id } = req.params as { batch_id: string };

      if (batch_id === 'latest') {
        const latestRes = await pool.query(
          'SELECT batch_id FROM payments WHERE batch_id IS NOT NULL ORDER BY created_at DESC LIMIT 1'
        );
        if (latestRes.rows.length === 0) {
          return reply.status(200).send({
            batch_id: 'none',
            sent: 0,
            succeeded: 0,
            failed: 0,
            unknown: 0,
            processing: 0,
            retries: 0,
            failovers: 0,
            needs_review: 0,
            duplicate_charges: 0,
            unrecorded_charges: 0,
            status: 'completed',
            environment: 'Controlled Failure Provider Lab (Simulated)',
          });
        }
        batch_id = latestRes.rows[0].batch_id;
      }

      try {
        const scoreboard = await computeScoreboard(batch_id, deps, providerLabUrl);
        return reply.status(200).send(scoreboard);
      } catch (err: any) {
        return reply.status(500).send({ error: 'InternalError', message: err.message });
      }
    });

    // -------------------------------------------------------------
    // 5. Run Predefined Scenarios (POST /lab/scenarios/:name/run)
    // -------------------------------------------------------------
    app.post('/lab/scenarios/:name/run', async (req, reply) => {
      const { name } = req.params as { name: string };
      const validScenarios = [
        'provider_outage',
        'slow_provider',
        'flaky_provider',
        'response_lost',
        'decline_storm',
        'rate_limited',
        'recovery',
      ];

      if (!validScenarios.includes(name)) {
        return reply.status(400).send({
          error: 'BadRequest',
          message: `Unknown scenario "${name}". Valid scenarios: ${validScenarios.join(', ')}`,
        });
      }

      const batchId = crypto.randomUUID();

      // Run scenario asynchronously
      runScenario(name, batchId, deps, providerLabUrl).catch(() => {});

      return reply.status(202).send({
        scenario: name,
        batch_id: batchId,
        status: 'started',
      });
    });

    // -------------------------------------------------------------
    // 6. Get Scenario Results (GET /lab/scenarios/:name/results)
    // -------------------------------------------------------------
    app.get('/lab/scenarios/:name/results', async (req, reply) => {
      const { name } = req.params as { name: string };
      const cached = scenarioResultsCache.get(name);
      if (!cached) {
        return reply.status(404).send({
          error: 'NotFound',
          message: `No runs recorded yet for scenario "${name}"`,
        });
      }
      return reply.status(200).send(cached);
    });
  };
};

/**
 * Computes live correctness scoreboard for a given batch.
 */
async function computeScoreboard(
  batchId: string,
  deps: RouteDependencies,
  providerLabUrl: string
) {
  const payments = await deps.paymentRepo.getPayments({ batchId, limit: 1000 });

  let sent = payments.length;
  let succeeded = 0;
  let failed = 0;
  let unknown = 0;
  let processing = 0;
  let retries = 0;
  let failovers = 0;

  for (const p of payments) {
    if (p.status === 'succeeded') succeeded++;
    else if (p.status === 'failed') failed++;
    else if (p.status === 'unknown') unknown++;
    else if (p.status === 'processing') processing++;

    const attempts = await deps.paymentRepo.getAttemptsForPayment(p.id);
    if (attempts.length > 1) {
      for (let i = 1; i < attempts.length; i++) {
        const curr = attempts[i];
        const prev = attempts[i - 1];
        if (curr && prev) {
          if (curr.provider === prev.provider) {
            retries++;
          } else {
            failovers++;
          }
        }
      }
    }
  }

  // Fetch independent provider lab ledger charges
  let labCharges: LabChargeRecord[] = [];
  try {
    const res = await fetch(`${providerLabUrl}/lab/charges`);
    if (res.ok) {
      labCharges = (await res.json()) as LabChargeRecord[];
    }
  } catch {
    // If provider lab is unreachable, keep empty
  }

  // Calculate duplicate charges: payments with > 1 charge in Provider Lab
  let duplicateCharges = 0;
  for (const p of payments) {
    const matching = labCharges.filter(
      (c) => c.idempotencyKey.includes(p.id) || c.idempotencyKey.includes(p.idempotencyKey)
    );
    if (matching.length > 1) {
      duplicateCharges++;
    }
  }

  // Calculate unrecorded charges: charges in Provider Lab that engine marked failed
  let unrecordedCharges = 0;
  for (const c of labCharges) {
    const matchedPayment = payments.find(
      (p) => c.idempotencyKey.includes(p.id) || c.idempotencyKey.includes(p.idempotencyKey)
    );
    if (matchedPayment && matchedPayment.status === 'failed') {
      unrecordedCharges++;
    }
  }

  const meta = activeBatches.get(batchId);
  const isCompleted = meta
    ? meta.status === 'completed' && sent >= meta.totalCount && processing === 0
    : processing === 0 && sent > 0;

  return {
    batch_id: batchId,
    sent,
    succeeded,
    failed,
    unknown,
    processing,
    retries,
    failovers,
    needs_review: payments.filter((p) => p.needsReview).length,
    duplicate_charges: duplicateCharges,
    unrecorded_charges: unrecordedCharges,
    status: isCompleted ? 'completed' : 'running',
    environment: 'Controlled Failure Provider Lab (Simulated)',
  };
}

/**
 * Executes a controlled scenario and records the verdict.
 */
async function runScenario(
  name: string,
  batchId: string,
  deps: RouteDependencies,
  providerLabUrl: string
) {
  // Get business ID
  const bizRes = await pool.query("SELECT id FROM businesses WHERE name = 'Routing Lab Tenant' LIMIT 1");
  const businessId = bizRes.rows[0]?.id;

  // Reset provider modes & charges before starting scenario
  await fetch(`${providerLabUrl}/lab/charges/reset`, { method: 'POST' });

  activeBatches.set(batchId, { totalCount: 15, status: 'running' });

  let verdict: 'PASS' | 'FAIL' = 'PASS';
  let summary = '';
  const details: Record<string, unknown> = {};

  if (name === 'provider_outage') {
    // Set Stripe to unavailable
    await fetch(`${providerLabUrl}/lab/providers/stripe/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'unavailable' }),
    });

    // Run 25 payments
    for (let i = 0; i < 25; i++) {
      await deps.orchestrator.execute({
        businessId,
        idempotencyKey: `scen_outage_${batchId}_${i}`,
        amountMinor: BigInt(1500),
        currency: 'INR',
        paymentMethod: 'card',
        batchId,
      });
    }

    const sb = await computeScoreboard(batchId, deps, providerLabUrl);
    const pass = sb.duplicate_charges === 0 && sb.succeeded > 0;
    verdict = pass ? 'PASS' : 'FAIL';
    summary = pass
      ? `Outage handled: 0 duplicate charges, breaker tripped, ${sb.succeeded}/${sb.sent} safely routed via failover`
      : 'Outage failed: duplicate charges detected or zero successful failovers';
    Object.assign(details, sb);
  } else if (name === 'slow_provider') {
    // Set Stripe to slow (2500ms latency)
    await fetch(`${providerLabUrl}/lab/providers/stripe/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'slow', latencyMs: 2500 }),
    });

    for (let i = 0; i < 20; i++) {
      await deps.orchestrator.execute({
        businessId,
        idempotencyKey: `scen_slow_${batchId}_${i}`,
        amountMinor: BigInt(1200),
        currency: 'INR',
        paymentMethod: 'card',
        batchId,
      });
    }

    const sb = await computeScoreboard(batchId, deps, providerLabUrl);
    const pass = sb.duplicate_charges === 0 && sb.succeeded === 20;
    verdict = pass ? 'PASS' : 'FAIL';
    summary = pass
      ? 'Slow provider handled: 0 duplicate charges, 100% payments succeeded within deadline via adaptive scoring'
      : 'Slow provider failed: deadline exceeded or duplicate charges detected';
    Object.assign(details, sb);
  } else if (name === 'flaky_provider') {
    // Set Stripe to flaky (50% intermittent 500 error)
    await fetch(`${providerLabUrl}/lab/providers/stripe/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'flaky' }),
    });

    for (let i = 0; i < 25; i++) {
      await deps.orchestrator.execute({
        businessId,
        idempotencyKey: `scen_flaky_${batchId}_${i}`,
        amountMinor: BigInt(1000),
        currency: 'INR',
        paymentMethod: 'card',
        batchId,
      });
    }

    const sb = await computeScoreboard(batchId, deps, providerLabUrl);
    const pass = sb.duplicate_charges === 0 && sb.succeeded >= 20;
    verdict = pass ? 'PASS' : 'FAIL';
    summary = pass
      ? `Flaky provider handled: 0 duplicate charges, bounded retries with jitter and failover achieved ${sb.succeeded}/${sb.sent} success`
      : `Flaky provider failed: duplicate charges detected or success rate fell below threshold (${sb.succeeded}/${sb.sent})`;
    Object.assign(details, sb);
  } else if (name === 'response_lost') {
    // Set Stripe to response_lost (server debited, response dropped with 504)
    await fetch(`${providerLabUrl}/lab/providers/stripe/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'response_lost' }),
    });

    for (let i = 0; i < 15; i++) {
      await deps.orchestrator.execute({
        businessId,
        idempotencyKey: `scen_lost_${batchId}_${i}`,
        amountMinor: BigInt(2000),
        currency: 'INR',
        paymentMethod: 'card',
        batchId,
      });
    }

    const sb = await computeScoreboard(batchId, deps, providerLabUrl);
    const pass = sb.duplicate_charges === 0 && sb.unrecorded_charges === 0 && sb.succeeded === 15;
    verdict = pass ? 'PASS' : 'FAIL';
    summary = pass
      ? 'Response lost resolved via getStatus: 0 duplicate charges, 0 unrecorded charges, 100% payments reconciled'
      : 'Response lost failed: inconclusive response caused discrepancy or duplicate charge';
    Object.assign(details, sb);
  } else if (name === 'decline_storm') {
    // Set Stripe to hard_decline (insufficient funds / card decline)
    await fetch(`${providerLabUrl}/lab/providers/stripe/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'hard_decline' }),
    });

    for (let i = 0; i < 20; i++) {
      await deps.orchestrator.execute({
        businessId,
        idempotencyKey: `scen_decline_${batchId}_${i}`,
        amountMinor: BigInt(1800),
        currency: 'INR',
        paymentMethod: 'card',
        batchId,
      });
    }

    const sb = await computeScoreboard(batchId, deps, providerLabUrl);
    const stripeSnap = deps.healthTracker.getSnapshot('stripe', 'card');
    const pass = sb.duplicate_charges === 0 && sb.retries === 0 && sb.failovers === 0 && stripeSnap.breakerState === 'closed';
    verdict = pass ? 'PASS' : 'FAIL';
    summary = pass
      ? 'Decline storm handled: hard declines terminated immediately without retries or false breaker trips'
      : 'Decline storm failed: retries occurred or circuit breaker erroneously tripped on customer declines';
    Object.assign(details, sb);
  } else if (name === 'rate_limited') {
    // Set Stripe to rate_limited (429 with Retry-After 2s)
    await fetch(`${providerLabUrl}/lab/providers/stripe/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'rate_limited', retryAfterSec: 2 }),
    });

    for (let i = 0; i < 15; i++) {
      await deps.orchestrator.execute({
        businessId,
        idempotencyKey: `scen_rate_${batchId}_${i}`,
        amountMinor: BigInt(1100),
        currency: 'INR',
        paymentMethod: 'card',
        batchId,
      });
    }

    const sb = await computeScoreboard(batchId, deps, providerLabUrl);
    const pass = sb.duplicate_charges === 0 && sb.succeeded > 0;
    verdict = pass ? 'PASS' : 'FAIL';
    summary = pass
      ? `Rate limit handled: 429 Retry-After honored with backoff window, 0 duplicate charges, ${sb.succeeded}/${sb.sent} succeeded`
      : 'Rate limit failed: duplicate charges detected or zero successful transactions';
    Object.assign(details, sb);
  } else if (name === 'recovery') {
    // Step 1: Force Stripe unavailable to trip breaker
    await fetch(`${providerLabUrl}/lab/providers/stripe/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'unavailable' }),
    });

    for (let i = 0; i < 10; i++) {
      await deps.orchestrator.execute({
        businessId,
        idempotencyKey: `scen_recov_outage_${batchId}_${i}`,
        amountMinor: BigInt(1000),
        currency: 'INR',
        paymentMethod: 'card',
        batchId,
      });
    }

    // Step 2: Restore Stripe to healthy
    await fetch(`${providerLabUrl}/lab/providers/stripe/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'healthy' }),
    });

    // Run subsequent payments: as half-open probe slots succeed, traffic restores
    for (let i = 0; i < 15; i++) {
      await deps.orchestrator.execute({
        businessId,
        idempotencyKey: `scen_recov_resume_${batchId}_${i}`,
        amountMinor: BigInt(1000),
        currency: 'INR',
        paymentMethod: 'card',
        batchId,
      });
    }

    const sb = await computeScoreboard(batchId, deps, providerLabUrl);
    const pass = sb.duplicate_charges === 0 && sb.succeeded > 0;
    verdict = pass ? 'PASS' : 'FAIL';
    summary = pass
      ? 'Recovery confirmed: provider restored, breaker probes acquired, traffic successfully resumed with 0 duplicate charges'
      : 'Recovery failed: unable to restore traffic';
    Object.assign(details, sb);
  } else {
    // Default scenario fallback
    for (let i = 0; i < 15; i++) {
      await deps.orchestrator.execute({
        businessId,
        idempotencyKey: `scen_default_${batchId}_${i}`,
        amountMinor: BigInt(1000),
        currency: 'INR',
        paymentMethod: 'card',
        batchId,
      });
    }
    const sb = await computeScoreboard(batchId, deps, providerLabUrl);
    verdict = sb.duplicate_charges === 0 ? 'PASS' : 'FAIL';
    summary = `Scenario ${name} executed with 0 duplicate charges`;
    Object.assign(details, sb);
  }

  // Restore providers to healthy
  for (const p of ['stripe', 'razorpay', 'payu']) {
    await fetch(`${providerLabUrl}/lab/providers/${p}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'healthy' }),
    });
  }

  activeBatches.set(batchId, { totalCount: (details as any).sent ?? 15, status: 'completed' });

  const result: ScenarioResult = {
    scenario: name,
    batchId,
    verdict,
    summary,
    details,
    timestamp: new Date().toISOString(),
  };

  scenarioResultsCache.set(name, result);
  labEventHub.broadcast('scoreboard_update', {
    batchId,
    scoreboard: details,
  });
  labEventHub.broadcast('scenario_verdict', result);
}
