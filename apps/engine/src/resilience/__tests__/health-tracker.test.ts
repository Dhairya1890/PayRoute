import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { HealthTracker } from '../health-tracker.js';
import { CircuitBreakerManager } from '../circuit-breaker-manager.js';

describe('HealthTracker - In-Memory Snapshot & Realtime Pub/Sub', () => {
  let redis: Redis;
  let subRedis: Redis;
  let breakerManager: CircuitBreakerManager;
  let healthTracker: HealthTracker;

  const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

  beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    subRedis = new Redis(REDIS_URL);

    // Clean up test keys first
    const keys = await redis.keys('*tracker*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }

    breakerManager = new CircuitBreakerManager({ redis });
    await breakerManager.init();

    healthTracker = new HealthTracker({
      redis,
      subRedis,
      providers: ['tracker_razorpay', 'tracker_stripe'],
      methods: ['card'],
    });
    await healthTracker.init();
  });

  afterAll(async () => {
    await healthTracker.close();
    await redis.quit();
    await subRedis.quit();
  });

  it('updates in-memory snapshot instantly via Redis pub/sub when breaker trips', async () => {
    const provider = 'tracker_razorpay';
    const method = 'card';

    // Verify initial snapshot is closed
    const initialSnapshot = healthTracker.getSnapshot(provider, method);
    expect(initialSnapshot.breakerState).toBe('closed');

    // Trip the breaker via config_error
    await breakerManager.recordOutcome({
      provider,
      method,
      outcome: 'config_error',
      latencyMs: 50,
      nowSec: 1700000000,
    });

    // Poll for up to 2000ms for Redis Pub/Sub message propagation under parallel test suite load
    let isNowOpen = false;
    for (let i = 0; i < 100; i++) {
      if (healthTracker.getSnapshot(provider, method).breakerState === 'open') {
        isNowOpen = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    // In-memory snapshot must now reflect 'open' without waiting for the 1s refresh loop!
    expect(isNowOpen).toBe(true);
    const updatedSnapshot = healthTracker.getSnapshot(provider, method);
    expect(updatedSnapshot.breakerState).toBe('open');
  });

  it('reports healthy status when Redis is accessible', () => {
    expect(healthTracker.isDegraded()).toBe(false);
    expect(healthTracker.getStatus()).toBe('healthy');
  });
});
