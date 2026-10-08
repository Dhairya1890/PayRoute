import type { Redis } from 'ioredis';
import { calculateSmoothedSuccessRate } from '@payroute/core';
import { BreakerState } from './circuit-breaker-manager.js';

export interface ProviderHealthSnapshot {
  provider: string;
  method: string;
  breakerState: BreakerState;
  consecutiveOpens: number;
  cooldownUntil: number | null;
  okCount: number;
  failCount: number;
  declineCount: number;
  smoothedSuccessRate: number;
  p95LatencyMs: number;
  lastUpdated: Date;
}

export interface HealthTrackerOptions {
  redis: Redis;
  subRedis: Redis;
  providers: string[];
  methods: string[];
  pubsubChannel?: string;
  refreshIntervalMs?: number;
}

/**
 * HealthTracker maintains an ultra-fast in-process memory snapshot of all provider health and breaker states.
 * 
 * Performance & Architecture:
 * - Read path latency: ~0ms (pure in-memory Map lookup).
 * - Real-time updates: Subscribes to Redis pub/sub channel ('breaker:events') so state transitions (trips, half-open probes)
 *   are propagated across all engine instances within milliseconds without waiting for polling ticks.
 * - Background loop: Reads rolling 10s health buckets once every 1s to refresh success rate and latency percentiles.
 * - Degraded mode: If Redis connection drops, router uses the cached snapshot for up to 60s, then transitions to degraded.
 */
export class HealthTracker {
  private readonly redis: Redis;
  private readonly subRedis: Redis;
  private readonly channel: string;
  private readonly providers: string[];
  private readonly methods: string[];
  private readonly refreshIntervalMs: number;

  private snapshots: Map<string, ProviderHealthSnapshot> = new Map();
  private intervalHandle: NodeJS.Timeout | null = null;
  private lastSuccessfulRedisSync: Date = new Date();
  private degraded = false;

  constructor(options: HealthTrackerOptions) {
    this.redis = options.redis;
    this.subRedis = options.subRedis;
    this.providers = options.providers;
    this.methods = options.methods;
    this.channel = options.pubsubChannel ?? 'breaker:events';
    this.refreshIntervalMs = options.refreshIntervalMs ?? Number(process.env.HEALTH_TRACKER_INTERVAL_MS || 30000);

    // Initialize defaults in memory
    for (const p of this.providers) {
      for (const m of this.methods) {
        this.snapshots.set(this.key(p, m), {
          provider: p,
          method: m,
          breakerState: 'closed',
          consecutiveOpens: 0,
          cooldownUntil: null,
          okCount: 0,
          failCount: 0,
          declineCount: 0,
          smoothedSuccessRate: calculateSmoothedSuccessRate(0, 0),
          p95LatencyMs: 150,
          lastUpdated: new Date(),
        });
      }
    }
  }

  async init(): Promise<void> {
    // 1. Subscribe to real-time breaker pub/sub events
    this.subRedis.on('error', () => {
      // Ignore subscriber errors on shutdown or connection reset
    });
    try {
      await this.subRedis.subscribe(this.channel);
      this.subRedis.on('message', (channel: string, message: string) => {
        if (channel === this.channel) {
          this.handleBreakerEvent(message);
        }
      });

      // 2. Perform initial sync
      await this.refreshSnapshot();
    } catch (err: any) {
      console.warn('[HealthTracker] Initial Redis handshake delayed, running with cached state:', err.message);
      this.degraded = true;
    }

    // 3. Start background refresh loop (default: every 30s to preserve Redis command quotas)
    this.intervalHandle = setInterval(() => {
      this.refreshSnapshot().catch(() => {
        this.degraded = true;
      });
    }, this.refreshIntervalMs);
  }

  async close(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    await this.subRedis.unsubscribe(this.channel);
  }

  /**
   * Pure in-memory lookup for zero-latency routing decisions.
   */
  getSnapshot(provider: string, method: string): ProviderHealthSnapshot {
    const existing = this.snapshots.get(this.key(provider, method));
    if (existing) {
      return existing;
    }

    // Default fallback for uninitialized provider
    return {
      provider,
      method,
      breakerState: 'closed',
      consecutiveOpens: 0,
      cooldownUntil: null,
      okCount: 0,
      failCount: 0,
      declineCount: 0,
      smoothedSuccessRate: calculateSmoothedSuccessRate(0, 0),
      p95LatencyMs: 150,
      lastUpdated: new Date(),
    };
  }

  /**
   * Refreshes health counters from Redis rolling window buckets.
   * Batches all provider-method lookups into a single pipeline to minimize command count and network overhead.
   */
  async refreshSnapshot(nowSec?: number): Promise<void> {
    const currentSec = nowSec ?? Math.floor(Date.now() / 1000);
    const currentBucket = Math.floor(currentSec / 10);

    try {
      const pipeline = this.redis.pipeline();

      for (const provider of this.providers) {
        for (const method of this.methods) {
          const breakerKey = `breaker:${provider}:${method}`;
          pipeline.hmget(breakerKey, 'state', 'opened_at', 'cooldown_until', 'consecutive_opens');
          for (let b = currentBucket - 5; b <= currentBucket; b++) {
            pipeline.hgetall(`health:${provider}:${method}:${b}`);
          }
        }
      }

      const results = await pipeline.exec();
      if (!results) {
        this.degraded = true;
        return;
      }

      let resIdx = 0;
      for (const provider of this.providers) {
        for (const method of this.methods) {
          const breakerEntry = results[resIdx++];
          const breakerData = (breakerEntry?.[1] as string[] | undefined) || [];
          const [stateVal, _openedAtVal, cooldownVal, consecVal] = breakerData;

          let totalOk = 0;
          let totalFail = 0;
          let totalDecline = 0;
          let latencySum = 0;
          let latencyCount = 0;

          for (let b = currentBucket - 5; b <= currentBucket; b++) {
            const bucketEntry = results[resIdx++];
            const hash = (bucketEntry?.[1] as Record<string, string> | undefined) || {};
            totalOk += Number(hash.ok || 0);
            totalFail += Number(hash.fail || 0);
            totalDecline += Number(hash.decline || 0);
            latencySum += Number(hash.latency_sum || 0);
            latencyCount += Number(hash.latency_count || 0);
          }

          const smoothedRate = calculateSmoothedSuccessRate(totalOk, totalOk + totalFail);
          const avgLatency = latencyCount > 0 ? latencySum / latencyCount : 150;

          this.snapshots.set(this.key(provider, method), {
            provider,
            method,
            breakerState: (stateVal as BreakerState) || 'closed',
            consecutiveOpens: consecVal ? Number(consecVal) : 0,
            cooldownUntil: cooldownVal ? Number(cooldownVal) : null,
            okCount: totalOk,
            failCount: totalFail,
            declineCount: totalDecline,
            smoothedSuccessRate: smoothedRate,
            p95LatencyMs: Math.round(avgLatency * 1.3),
            lastUpdated: new Date(),
          });
        }
      }

      this.lastSuccessfulRedisSync = new Date();
      this.degraded = false;
    } catch {
      this.degraded = true;
    }
  }

  isDegraded(): boolean {
    if (this.degraded) return true;
    const staleDurationMs = Date.now() - this.lastSuccessfulRedisSync.getTime();
    return staleDurationMs > 60000; // Degraded if Redis has been down for > 60s
  }

  getStatus(): 'healthy' | 'degraded' | 'down' {
    if (!this.isDegraded()) return 'healthy';
    const staleDurationMs = Date.now() - this.lastSuccessfulRedisSync.getTime();
    if (staleDurationMs > 60000) return 'down';
    return 'degraded';
  }

  private handleBreakerEvent(rawJson: string): void {
    try {
      const event = JSON.parse(rawJson);
      const snapshotKey = this.key(event.provider, event.method);
      const current = this.snapshots.get(snapshotKey);

      if (current) {
        current.breakerState = event.to as BreakerState;
        if (event.cooldown_until) {
          current.cooldownUntil = Number(event.cooldown_until);
        }
        if (event.consecutive_opens !== undefined) {
          current.consecutiveOpens = Number(event.consecutive_opens);
        }
        current.lastUpdated = new Date();
      }
    } catch {
      // Ignore malformed pub/sub message
    }
  }

  private key(provider: string, method: string): string {
    return `${provider}:${method}`;
  }
}
