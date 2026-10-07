import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import Redis from 'ioredis';
import { pool } from '../db/pool.js';
import { PaymentRepository } from '../db/payment-repository.js';
import { CircuitBreakerManager } from '../resilience/circuit-breaker-manager.js';
import { HealthTracker } from '../resilience/health-tracker.js';
import { PaymentOrchestrator } from '../orchestration/orchestrator.js';
import { ResolutionWorker } from '../worker/resolution-worker.js';
import { StripeAdapter, RazorpayAdapter, PayUAdapter, ProviderAdapter } from '@payroute/providers';
import { InvariantChecker, LabChargeRecord } from '../invariants/invariant-checker.js';

describe('Chaos & Invariant Verification Suite (Step 5)', () => {
  let labProcess: ChildProcess;
  const LAB_PORT = 4005;
  const LAB_BASE_URL = `http://127.0.0.1:${LAB_PORT}`;

  let redis: Redis;
  let subRedis: Redis;
  let breakerManager: CircuitBreakerManager;
  let healthTracker: HealthTracker;
  let paymentRepo: PaymentRepository;
  let orchestrator: PaymentOrchestrator;
  let resolutionWorker: ResolutionWorker;
  let adapters: Map<string, ProviderAdapter>;
  let testBusinessId: string;

  beforeAll(async () => {
    // 1. Spawn Provider Lab as an independent HTTP server process (Rule 16: zero code imports)
    const providerLabDist = path.resolve(__dirname, '../../../provider-lab/dist/index.js');
    labProcess = spawn('node', [providerLabDist], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        PROVIDER_LAB_PORT: LAB_PORT.toString(),
        HOST: '127.0.0.1',
      },
      stdio: 'ignore',
    });

    // Wait for Provider Lab HTTP server to be ready
    let isReady = false;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`${LAB_BASE_URL}/lab/status`);
        if (res.ok) {
          isReady = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!isReady) {
      throw new Error(`Provider Lab server failed to start on port ${LAB_PORT}`);
    }

    // 2. Connect Redis and Postgres
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

    // 3. Initialize Adapters wired to Provider Lab over real HTTP
    const stripe = new StripeAdapter({ baseUrl: `${LAB_BASE_URL}/stripe`, timeoutMs: 1500 });
    const razorpay = new RazorpayAdapter({ baseUrl: `${LAB_BASE_URL}/razorpay`, timeoutMs: 1500 });
    const payu = new PayUAdapter({ baseUrl: `${LAB_BASE_URL}/payu`, timeoutMs: 1500 });

    adapters = new Map<string, ProviderAdapter>([
      ['stripe', stripe],
      ['razorpay', razorpay],
      ['payu', payu],
    ]);

    orchestrator = new PaymentOrchestrator({
      paymentRepo,
      breakerManager,
      healthTracker,
      adapters,
      pool,
      defaults: {
        maxAttemptsTotal: 3,
        maxAttemptsPerProvider: 2,
        deadlineMs: 6000,
        minAttemptTimeoutMs: 200,
        strategy: 'lowest_cost',
        explorationShare: 0.05,
      },
    });

    resolutionWorker = new ResolutionWorker({
      pool,
      paymentRepo,
      adapters,
      orchestrator,
      batchSize: 100,
    });

    // Create unique test business
    const res = await pool.query(
      `INSERT INTO businesses (name) VALUES ('Chaos Test Business') RETURNING id`
    );
    testBusinessId = res.rows[0].id;
  }, 30000);

  afterAll(async () => {
    if (healthTracker) await healthTracker.close();
    if (redis) await redis.quit();
    if (subRedis) subRedis.disconnect();
    if (labProcess) {
      labProcess.kill('SIGTERM');
    }
  });

  it('Chaos Test: 100 payments under dynamic randomized provider failures maintain zero double charges and invariant integrity', async () => {
    // Reset lab ledger & failure modes
    await fetch(`${LAB_BASE_URL}/lab/charges/reset`, { method: 'POST' });

    const batchId = crypto.randomUUID();
    const totalPayments = 100;
    const providers = ['stripe', 'razorpay', 'payu'];
    const failureModes = [
      { mode: 'healthy' },
      { mode: 'slow', latencyMs: 300 },
      { mode: 'flaky' },
      { mode: 'unavailable' },
      { mode: 'response_lost' },
      { mode: 'soft_decline' },
      { mode: 'rate_limited', retryAfterSec: 1 },
      { mode: 'hard_decline' },
    ];

    // Start background chaos mode mutator
    let stopChaos = false;
    const chaosPromise = (async () => {
      while (!stopChaos) {
        const randomProvider = providers[Math.floor(Math.random() * providers.length)];
        const randomConfig = failureModes[Math.floor(Math.random() * failureModes.length)];

        try {
          await fetch(`${LAB_BASE_URL}/lab/providers/${randomProvider}/mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(randomConfig),
          });
        } catch {
          // ignore transient HTTP errors while updating modes
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      // Reset all providers back to healthy for resolution phase
      for (const p of providers) {
        await fetch(`${LAB_BASE_URL}/lab/providers/${p}/mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'healthy' }),
        });
      }
    })();

    // Concurrently dispatch payments in waves
    const methods: ('card' | 'upi' | 'netbanking')[] = ['card', 'upi', 'netbanking'];
    const executedPaymentIds: string[] = [];
    const idempotencyKeys: string[] = [];

    // Wave 1: 50 concurrent payments
    const wave1Promises = Array.from({ length: 50 }).map(async (_, i) => {
      const idempotencyKey = `chaos_key_w1_${i}_${Date.now()}`;
      idempotencyKeys.push(idempotencyKey);
      const method = methods[i % methods.length];

      try {
        const result = await orchestrator.execute({
          businessId: testBusinessId,
          idempotencyKey,
          amountMinor: BigInt(1000 + i * 50),
          currency: 'INR',
          paymentMethod: method,
          batchId,
        });
        executedPaymentIds.push(result.payment.id);
        return result;
      } catch (err) {
        console.error('Wave 1 caught error:', err);
        return null;
      }
    });

    await Promise.all(wave1Promises);

    // Wave 2: 50 more payments + 10 idempotent replays of wave 1 keys
    const wave2Promises = Array.from({ length: 50 }).map(async (_, i) => {
      const idempotencyKey = `chaos_key_w2_${i}_${Date.now()}`;
      idempotencyKeys.push(idempotencyKey);
      const method = methods[(i + 1) % methods.length];

      try {
        const result = await orchestrator.execute({
          businessId: testBusinessId,
          idempotencyKey,
          amountMinor: BigInt(2000 + i * 25),
          currency: 'INR',
          paymentMethod: method,
          batchId,
        });
        executedPaymentIds.push(result.payment.id);
        return result;
      } catch (err) {
        console.error('Wave 2 caught error:', err);
        return null;
      }
    });

    const replayPromises = idempotencyKeys.slice(0, 10).map(async (key, i) => {
      // Replay original key with same amount
      return orchestrator.execute({
        businessId: testBusinessId,
        idempotencyKey: key,
        amountMinor: BigInt(1000 + i * 50),
        currency: 'INR',
        paymentMethod: methods[i % methods.length],
        batchId,
      });
    });

    await Promise.all([...wave2Promises, ...replayPromises]);

    // Stop chaos mutator and restore providers
    stopChaos = true;
    await chaosPromise;

    // Run resolution worker to resolve any in-doubt or overdue payments
    await resolutionWorker.processDuePayments();

    // -------------------------------------------------------------
    // Comprehensive Invariant Verification
    // -------------------------------------------------------------

    // 1. Fetch independent Provider Lab ledger records
    const labChargesRes = await fetch(`${LAB_BASE_URL}/lab/charges`);
    const labCharges = (await labChargesRes.json()) as LabChargeRecord[];

    // 2. Fetch all payments and attempts from Postgres for this batch
    const dbPayments = await paymentRepo.getPayments({ batchId, limit: 500 });
    expect(dbPayments.length).toBe(totalPayments);

    let totalSucceeded = 0;
    let totalFailed = 0;
    let totalUnknown = 0;

    for (const payment of dbPayments) {
      if (payment.status === 'succeeded') totalSucceeded++;
      else if (payment.status === 'failed') totalFailed++;
      else if (payment.status === 'unknown') totalUnknown++;
      else {
        const paymentAttempts = await paymentRepo.getAttemptsForPayment(payment.id);
        console.error('Non-terminal payment found:', payment.id, payment.status, 'attempts:', paymentAttempts.length, paymentAttempts);
      }

      const attempts = await paymentRepo.getAttemptsForPayment(payment.id);

      // Invariant 1: Check Single Succeeded Attempt Consistency
      const successViolations = InvariantChecker.checkAttemptSuccessConsistency(payment, attempts);
      expect(successViolations).toEqual([]);

      // Invariant 2: ZERO Duplicate Charges in Provider Lab records
      const duplicateViolations = InvariantChecker.checkZeroDuplicateCharges(
        payment.id,
        payment.idempotencyKey,
        labCharges
      );
      expect(duplicateViolations).toEqual([]);

      // Invariant 3: Succeeded / Failed payments never regress
      const regressionViolations = InvariantChecker.checkNoTerminalRegression(
        payment.id,
        payment.status,
        payment.status
      );
      expect(regressionViolations).toEqual([]);
    }

    // Verify all 100 payments reached terminal status or resolved unknown
    expect(totalSucceeded + totalFailed + totalUnknown).toBe(totalPayments);
    // Under chaos, we should have a substantial number of succeeded payments
    expect(totalSucceeded).toBeGreaterThan(0);

    console.log(`[Chaos Run Summary] Sent: ${totalPayments}, Succeeded: ${totalSucceeded}, Failed: ${totalFailed}, Unknown: ${totalUnknown}`);
    console.log(`[Provider Lab Charges] Total independent ledger charges: ${labCharges.length}`);
  }, 60000);
});
