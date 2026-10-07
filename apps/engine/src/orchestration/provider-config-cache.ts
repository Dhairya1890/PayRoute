import pg from 'pg';
import { StrategyType, PolicyType } from '@payroute/core';

export interface DbProviderConfig {
  name: string;
  enabled: boolean;
  priority: number;
  costBps: number;
  timeoutMs: number;
  supportedMethods: string[];
  supportedCurrencies: string[];
  declineCodeMap: Record<string, string>;
}

export interface DbEngineSettings {
  strategy: StrategyType;
  policy: PolicyType;
  explorationShare: number;
  maxAttemptsPerPayment: number;
  maxAttemptsPerProvider: number;
  syncDeadlineMs: number;
}

export interface ProviderConfigCacheOptions {
  pool: pg.Pool;
  refreshIntervalMs?: number;
}

/**
 * ProviderConfigCache caches provider operational configurations and engine settings in process memory.
 * 
 * Rules Enforced (AGENTS.md Section 9):
 * - Read path (minimal latency): Pure in-memory cache lookup (<1ms).
 * - Refreshed in background every 30s.
 * - Instantly invalidated upon operational updates (e.g. PATCH /providers/:name or PUT /settings).
 */
export class ProviderConfigCache {
  private readonly pool: pg.Pool;
  private readonly refreshIntervalMs: number;

  private providerConfigs: Map<string, DbProviderConfig> = new Map();
  private engineSettings: DbEngineSettings = {
    strategy: 'weighted',
    policy: 'full',
    explorationShare: 0.05,
    maxAttemptsPerPayment: 3,
    maxAttemptsPerProvider: 2,
    syncDeadlineMs: 8000,
  };

  private lastLoadedAt: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private isLoaded: boolean = false;

  constructor(options: ProviderConfigCacheOptions) {
    this.pool = options.pool;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 30000;
  }

  async init(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      this.refresh().catch((err) => {
        console.error('Failed to refresh provider config cache:', err);
      });
    }, this.refreshIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  close(): void {
    this.stop();
  }

  async invalidate(): Promise<void> {
    await this.refresh();
  }

  async getProviderConfigs(): Promise<DbProviderConfig[]> {
    if (!this.isLoaded || Date.now() - this.lastLoadedAt > this.refreshIntervalMs) {
      await this.refresh();
    }
    return Array.from(this.providerConfigs.values()).sort((a, b) => a.priority - b.priority);
  }

  async getEngineSettings(): Promise<DbEngineSettings> {
    if (!this.isLoaded || Date.now() - this.lastLoadedAt > this.refreshIntervalMs) {
      await this.refresh();
    }
    return { ...this.engineSettings };
  }

  private async refresh(): Promise<void> {
    try {
      // 1. Load provider configs from PostgreSQL
      const providerRes = await this.pool.query(
        'SELECT name, enabled, priority, cost_bps, timeout_ms, supported_methods, supported_currencies, decline_code_map FROM provider_config ORDER BY priority ASC'
      );

      const nextConfigs = new Map<string, DbProviderConfig>();
      for (const row of providerRes.rows) {
        nextConfigs.set(row.name, {
          name: row.name,
          enabled: Boolean(row.enabled),
          priority: Number(row.priority),
          costBps: Number(row.cost_bps),
          timeoutMs: Number(row.timeout_ms),
          supportedMethods: Array.isArray(row.supported_methods) ? row.supported_methods : ['card'],
          supportedCurrencies: Array.isArray(row.supported_currencies) ? row.supported_currencies : ['INR'],
          declineCodeMap: (row.decline_code_map as Record<string, string>) || {},
        });
      }

      if (nextConfigs.size > 0) {
        this.providerConfigs = nextConfigs;
      }

      // 2. Load engine settings from PostgreSQL
      const settingsRes = await this.pool.query('SELECT key, value FROM engine_settings');
      for (const row of settingsRes.rows) {
        let val = row.value;
        if (typeof val === 'string') {
          try {
            val = JSON.parse(val);
          } catch {
            // keep raw string
          }
        }

        if (row.key === 'routing_strategy' || row.key === 'strategy') {
          this.engineSettings.strategy = val as StrategyType;
        } else if (row.key === 'policy') {
          this.engineSettings.policy = val as PolicyType;
        } else if (row.key === 'exploration_share') {
          this.engineSettings.explorationShare = Number(val);
        } else if (row.key === 'max_attempts_per_payment') {
          this.engineSettings.maxAttemptsPerPayment = Number(val);
        } else if (row.key === 'max_attempts_per_provider') {
          this.engineSettings.maxAttemptsPerProvider = Number(val);
        } else if (row.key === 'sync_deadline_ms') {
          this.engineSettings.syncDeadlineMs = Number(val);
        }
      }

      this.lastLoadedAt = Date.now();
      this.isLoaded = true;
    } catch (err) {
      console.error('Error refreshing ProviderConfigCache from PostgreSQL:', err);
      // Retain last known in-memory state on transient database failure
    }
  }
}
