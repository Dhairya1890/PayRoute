import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { CircuitBreakerManager } from '../circuit-breaker-manager.js';

describe('Circuit Breaker & Rolling Health - Redis & Lua Scripts', () => {
  let redis: Redis;
  let subRedis: Redis;
  let breakerManager: CircuitBreakerManager;

  const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    subRedis = new Redis(REDIS_URL);
    breakerManager = new CircuitBreakerManager({
      redis,
      subRedis,
    });
    await breakerManager.init();
  });

  afterAll(async () => {
    await breakerManager.close();
    await redis.quit();
    await subRedis.quit();
  });

  beforeEach(async () => {
    // Flush test keys before each test
    const keys = await redis.keys('*test*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  describe('Breaker Trip Rules & Rolling Window', () => {
    it('stays CLOSED when requests succeed or volume is below 20 requests', async () => {
      const nowSec = 1700000000;
      const provider = 'test_razorpay';
      const method = 'card';

      // Record 10 successes and 5 failures (total 15 < 20 min threshold)
      for (let i = 0; i < 10; i++) {
        await breakerManager.recordOutcome({
          provider,
          method,
          outcome: 'success',
          latencyMs: 100,
          nowSec,
        });
      }
      for (let i = 0; i < 5; i++) {
        await breakerManager.recordOutcome({
          provider,
          method,
          outcome: 'not_sent',
          latencyMs: 100,
          nowSec,
        });
      }

      const state = await breakerManager.getBreakerState(provider, method);
      expect(state.state).toBe('closed');
    });

    it('DECLINE STORM: hard and soft declines NEVER count toward failure rate or trip breaker', async () => {
      const nowSec = 1700000000;
      const provider = 'test_stripe';
      const method = 'card';

      // Record 5 successes and 50 declines
      for (let i = 0; i < 5; i++) {
        await breakerManager.recordOutcome({
          provider,
          method,
          outcome: 'success',
          latencyMs: 150,
          nowSec,
        });
      }
      for (let i = 0; i < 50; i++) {
        await breakerManager.recordOutcome({
          provider,
          method,
          outcome: 'hard_decline',
          latencyMs: 150,
          nowSec,
        });
        await breakerManager.recordOutcome({
          provider,
          method,
          outcome: 'soft_decline',
          latencyMs: 150,
          nowSec,
        });
      }

      const state = await breakerManager.getBreakerState(provider, method);
      expect(state.state).toBe('closed');
    });

    it('TRIPS to OPEN when failure rate exceeds 50% over rolling window with >= 20 requests', async () => {
      const nowSec = 1700000000;
      const provider = 'test_failing';
      const method = 'card';

      // 9 successes, 11 provider failures (total = 20, failures = 11/20 = 55% > 50%)
      for (let i = 0; i < 9; i++) {
        await breakerManager.recordOutcome({
          provider,
          method,
          outcome: 'success',
          latencyMs: 100,
          nowSec,
        });
      }

      // Record 11 failures
      for (let i = 0; i < 11; i++) {
        await breakerManager.recordOutcome({
          provider,
          method,
          outcome: 'not_sent',
          latencyMs: 100,
          nowSec,
        });
      }

      const state = await breakerManager.getBreakerState(provider, method);
      expect(state.state).toBe('open');
      expect(state.cooldownUntil).toBe(nowSec + 30); // 30s initial cooldown
      expect(state.consecutiveOpens).toBe(1);
    });

    it('CONFIG_ERROR trips breaker to OPEN immediately on 1st error', async () => {
      const nowSec = 1700000000;
      const provider = 'test_bad_creds';
      const method = 'card';

      await breakerManager.recordOutcome({
        provider,
        method,
        outcome: 'config_error',
        latencyMs: 50,
        nowSec,
      });

      const state = await breakerManager.getBreakerState(provider, method);
      expect(state.state).toBe('open');
    });
  });

  describe('Cooldown, Half-Open Probes, and Recovery Lifecycle', () => {
    it('rejects probes while OPEN before cooldown expires, allows 3 probes in HALF-OPEN after cooldown', async () => {
      let currentSec = 1700000000;
      const provider = 'test_probe_lifecycle';
      const method = 'card';

      // Trip the breaker immediately
      await breakerManager.recordOutcome({
        provider,
        method,
        outcome: 'config_error',
        latencyMs: 50,
        nowSec: currentSec,
      });

      // 1. Before cooldown expires (at +10s, cooldown is 30s): probe must be rejected
      currentSec += 10;
      const probe1 = await breakerManager.acquireProbe(provider, method, currentSec);
      expect(probe1.allowed).toBe(false);

      // 2. Advance time past 30s cooldown (+35s)
      currentSec += 25; // now at +35s
      const probeSlot1 = await breakerManager.acquireProbe(provider, method, currentSec);
      expect(probeSlot1.allowed).toBe(true); // Moved to half-open, 1 probe inflight

      // State is now half-open
      const halfState = await breakerManager.getBreakerState(provider, method);
      expect(halfState.state).toBe('half_open');

      // Acquire 2nd probe slot
      const probeSlot2 = await breakerManager.acquireProbe(provider, method, currentSec);
      expect(probeSlot2.allowed).toBe(true);

      // Acquire 3rd probe slot
      const probeSlot3 = await breakerManager.acquireProbe(provider, method, currentSec);
      expect(probeSlot3.allowed).toBe(true);

      // 4th probe exceeds probe limit (3 max concurrent) -> rejected!
      const probeSlot4 = await breakerManager.acquireProbe(provider, method, currentSec);
      expect(probeSlot4.allowed).toBe(false);
      expect(probeSlot4.reason).toMatch(/probe limit reached/i);
    });

    it('RECOVERS to CLOSED when all 3 probes succeed', async () => {
      let currentSec = 1700000000;
      const provider = 'test_recovery';
      const method = 'card';

      // Trip breaker
      await breakerManager.recordOutcome({
        provider,
        method,
        outcome: 'config_error',
        latencyMs: 50,
        nowSec: currentSec,
      });

      // Fast forward past cooldown
      currentSec += 35;

      // Acquire 3 probes and report all 3 as successes
      await breakerManager.acquireProbe(provider, method, currentSec);
      await breakerManager.recordProbeResult(provider, method, true, currentSec);

      await breakerManager.acquireProbe(provider, method, currentSec);
      await breakerManager.recordProbeResult(provider, method, true, currentSec);

      await breakerManager.acquireProbe(provider, method, currentSec);
      await breakerManager.recordProbeResult(provider, method, true, currentSec);

      // Breaker must now be CLOSED and consecutive opens reset
      const finalState = await breakerManager.getBreakerState(provider, method);
      expect(finalState.state).toBe('closed');
      expect(finalState.consecutiveOpens).toBe(0);
    });

    it('DOUBLES cooldown on probe failure up to 5 minutes cap', async () => {
      let currentSec = 1700000000;
      const provider = 'test_doubling';
      const method = 'card';

      // 1st trip: cooldown 30s
      await breakerManager.recordOutcome({
        provider,
        method,
        outcome: 'config_error',
        latencyMs: 50,
        nowSec: currentSec,
      });

      // Advance past 30s
      currentSec += 35;
      await breakerManager.acquireProbe(provider, method, currentSec);

      // Probe FAILS!
      await breakerManager.recordProbeResult(provider, method, false, currentSec);

      // Must re-open immediately with cooldown doubled (60s!)
      const state2 = await breakerManager.getBreakerState(provider, method);
      expect(state2.state).toBe('open');
      expect(state2.consecutiveOpens).toBe(2);
      expect(state2.cooldownUntil).toBe(currentSec + 60); // 60s cooldown

      // Advance past 60s
      currentSec += 65;
      await breakerManager.acquireProbe(provider, method, currentSec);

      // Probe FAILS again!
      await breakerManager.recordProbeResult(provider, method, false, currentSec);

      // Cooldown doubled again (120s!)
      const state3 = await breakerManager.getBreakerState(provider, method);
      expect(state3.state).toBe('open');
      expect(state3.consecutiveOpens).toBe(3);
      expect(state3.cooldownUntil).toBe(currentSec + 120); // 120s cooldown
    });
  });

  describe('Redis Concurrency and Atomicity', () => {
    it('CONCURRENCY: 20 parallel acquireProbe requests in half-open allow exactly 3 and reject 17', async () => {
      let currentSec = 1700000000;
      const provider = 'test_concurrency_probes';
      const method = 'card';

      // Trip breaker
      await breakerManager.recordOutcome({
        provider,
        method,
        outcome: 'config_error',
        latencyMs: 50,
        nowSec: currentSec,
      });

      // Advance time past cooldown
      currentSec += 35;

      // Fire 20 parallel acquireProbe requests concurrently
      const promises = Array.from({ length: 20 }).map(() =>
        breakerManager.acquireProbe(provider, method, currentSec)
      );
      const results = await Promise.all(promises);

      const allowedCount = results.filter((r) => r.allowed).length;
      const rejectedCount = results.filter((r) => !r.allowed).length;

      expect(allowedCount).toBe(3); // Exactly 3 probes allowed!
      expect(rejectedCount).toBe(17);
    });
  });
});
