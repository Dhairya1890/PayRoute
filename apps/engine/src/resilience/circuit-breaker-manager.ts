import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Redis } from 'ioredis';
import { OutcomeClass } from '@payroute/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerInfo {
  state: BreakerState;
  openedAt: number | null;
  cooldownUntil: number | null;
  consecutiveOpens: number;
  probesInflight: number;
  probesOk: number;
}

export interface AcquireProbeResult {
  allowed: boolean;
  state: BreakerState;
  probesInflight: number;
  reason?: string;
}

export interface RecordOutcomeParams {
  provider: string;
  method: string;
  outcome: OutcomeClass;
  latencyMs: number;
  nowSec?: number; // Injectable clock for deterministic testing
}

export interface CircuitBreakerManagerOptions {
  redis: Redis;
  subRedis?: Redis;
  pubsubChannel?: string;
}

/**
 * CircuitBreakerManager coordinates distributed circuit breakers and rolling health counters in Redis.
 * All state mutations are executed via atomic Lua scripts to guarantee zero race conditions.
 */
export class CircuitBreakerManager {
  private readonly redis: Redis;
  private readonly channel: string;

  private recordOutcomeSha: string | null = null;
  private acquireProbeSha: string | null = null;
  private recordProbeSha: string | null = null;

  constructor(options: CircuitBreakerManagerOptions) {
    this.redis = options.redis;
    this.channel = options.pubsubChannel ?? 'breaker:events';
  }

  /**
   * Loads Lua scripts into Redis script cache (SCRIPT LOAD) for high-performance execution.
   */
  async init(): Promise<void> {
    const luaDir = path.join(__dirname, 'lua');

    const [recordOutcomeSrc, acquireProbeSrc, recordProbeSrc] = await Promise.all([
      fs.readFile(path.join(luaDir, 'record_outcome.lua'), 'utf8'),
      fs.readFile(path.join(luaDir, 'acquire_probe.lua'), 'utf8'),
      fs.readFile(path.join(luaDir, 'record_probe.lua'), 'utf8'),
    ]);

    const [sha1, sha2, sha3] = (await Promise.all([
      this.redis.script('LOAD', recordOutcomeSrc),
      this.redis.script('LOAD', acquireProbeSrc),
      this.redis.script('LOAD', recordProbeSrc),
    ])) as [string, string, string];

    this.recordOutcomeSha = sha1;
    this.acquireProbeSha = sha2;
    this.recordProbeSha = sha3;
  }

  async close(): Promise<void> {
    // Cleanup if needed
  }

  /**
   * Atomically records an outcome in the rolling window bucket and evaluates breaker trip conditions.
   */
  async recordOutcome(params: RecordOutcomeParams): Promise<string> {
    const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / 10);

    const healthKey = `health:${params.provider}:${params.method}:${bucket}`;
    const breakerKey = `breaker:${params.provider}:${params.method}`;
    const windowPrefix = `health:${params.provider}:${params.method}:`;

    if (!this.recordOutcomeSha) {
      await this.init();
    }

    const result = (await this.redis.evalsha(
      this.recordOutcomeSha!,
      3,
      healthKey,
      breakerKey,
      this.channel,
      nowSec.toString(),
      params.outcome,
      (params.latencyMs ?? 0).toString(),
      windowPrefix,
      params.provider,
      params.method
    )) as string;

    return result;
  }

  /**
   * Atomically requests a probe slot if breaker is half-open or transitions open to half-open after cooldown.
   */
  async acquireProbe(
    provider: string,
    method: string,
    nowSec?: number,
    maxProbes = 3
  ): Promise<AcquireProbeResult> {
    const currentSec = nowSec ?? Math.floor(Date.now() / 1000);
    const breakerKey = `breaker:${provider}:${method}`;

    if (!this.acquireProbeSha) {
      await this.init();
    }

    const res = (await this.redis.evalsha(
      this.acquireProbeSha!,
      2,
      breakerKey,
      this.channel,
      currentSec.toString(),
      maxProbes.toString(),
      provider,
      method
    )) as [number, string, number];

    const [allowedNum, stateStr, inflightNum] = res;
    const allowed = allowedNum === 1;
    const state = stateStr as BreakerState;

    let reason: string | undefined;
    if (!allowed) {
      if (state === 'open') {
        reason = 'Circuit breaker is open (cooldown in progress)';
      } else if (state === 'half_open') {
        reason = `Half-open probe limit reached (${maxProbes} concurrent probes inflight)`;
      }
    }

    return {
      allowed,
      state,
      probesInflight: inflightNum,
      reason,
    };
  }

  /**
   * Records outcome of a probe request (success or failure) to either close breaker or re-open with doubled cooldown.
   */
  async recordProbeResult(
    provider: string,
    method: string,
    success: boolean,
    nowSec?: number,
    requiredProbes = 3
  ): Promise<BreakerState> {
    const currentSec = nowSec ?? Math.floor(Date.now() / 1000);
    const breakerKey = `breaker:${provider}:${method}`;

    if (!this.recordProbeSha) {
      await this.init();
    }

    const res = (await this.redis.evalsha(
      this.recordProbeSha!,
      2,
      breakerKey,
      this.channel,
      currentSec.toString(),
      success ? '1' : '0',
      requiredProbes.toString(),
      provider,
      method
    )) as string;

    return res as BreakerState;
  }

  /**
   * Fetches current breaker state and metadata from Redis.
   */
  async getBreakerState(provider: string, method: string): Promise<BreakerInfo> {
    const breakerKey = `breaker:${provider}:${method}`;
    const vals = await this.redis.hmget(
      breakerKey,
      'state',
      'opened_at',
      'cooldown_until',
      'consecutive_opens',
      'probes_inflight',
      'probes_ok'
    );

    const state = (vals[0] as BreakerState) || 'closed';
    const openedAt = vals[1] ? Number(vals[1]) : null;
    const cooldownUntil = vals[2] ? Number(vals[2]) : null;
    const consecutiveOpens = vals[3] ? Number(vals[3]) : 0;
    const probesInflight = vals[4] ? Number(vals[4]) : 0;
    const probesOk = vals[5] ? Number(vals[5]) : 0;

    return {
      state,
      openedAt,
      cooldownUntil,
      consecutiveOpens,
      probesInflight,
      probesOk,
    };
  }

  /**
   * Sets rate-limit backoff window for a provider.
   */
  async setBackoff(provider: string, durationMs: number, nowSec?: number): Promise<void> {
    const currentSec = nowSec ?? Math.floor(Date.now() / 1000);
    const until = currentSec + Math.ceil(durationMs / 1000);
    const key = `backoff:${provider}`;
    await this.redis.set(key, until.toString(), 'EX', Math.ceil(durationMs / 1000));
  }

  /**
   * Checks if a provider is in an active backoff window.
   */
  async isBackoffActive(provider: string, nowSec?: number): Promise<boolean> {
    const currentSec = nowSec ?? Math.floor(Date.now() / 1000);
    const key = `backoff:${provider}`;
    const val = await this.redis.get(key);
    if (!val) return false;
    return Number(val) > currentSec;
  }
}
