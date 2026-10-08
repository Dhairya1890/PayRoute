import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'node:path';

// Ensure monorepo root .env is loaded if running from subpackage directory
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

import { Redis, type RedisOptions } from 'ioredis';
import { pool, sanitizeConnectionUrl } from './db/pool.js';
import { PaymentRepository } from './db/payment-repository.js';
import { CircuitBreakerManager } from './resilience/circuit-breaker-manager.js';
import { HealthTracker } from './resilience/health-tracker.js';
import { PaymentOrchestrator } from './orchestration/orchestrator.js';
import { StripeAdapter, RazorpayAdapter, PayUAdapter, ProviderAdapter } from '@payroute/providers';
import { buildApp } from './api/app.js';
import { ResolutionWorker } from './worker/resolution-worker.js';
import { ProviderConfigCache } from './orchestration/provider-config-cache.js';

export * from './db/payment-repository.js';
export * from './db/pool.js';
export * from './resilience/circuit-breaker-manager.js';
export * from './resilience/health-tracker.js';
export * from './orchestration/orchestrator.js';
export * from './orchestration/provider-config-cache.js';
export * from './api/app.js';
export * from './api/routes.js';
export * from './api/chat-routes.js';
export * from './invariants/invariant-checker.js';
export * from './worker/resolution-worker.js';

import { runMigrations } from './db/migrate.js';

export async function startServer(port = 3000): Promise<void> {
  // 1. Run migrations to ensure PostgreSQL schema is initialized
  try {
    const applied = await runMigrations();
    if (applied.length > 0) {
      console.log(`[Migrations] Applied ${applied.length} migration(s): ${applied.join(', ')}`);
    } else {
      console.log('[Migrations] Schema is up to date');
    }
  } catch (err: any) {
    console.error(`[Migrations] Migration runner error: ${err.message}`);
    throw err;
  }

  const rawRedisUrl = process.env.REDIS_URL;
  let cleanRedisUrl = sanitizeConnectionUrl(rawRedisUrl);
  if (cleanRedisUrl && cleanRedisUrl.includes('upstash.io')) {
    if (!cleanRedisUrl.startsWith('redis://') && !cleanRedisUrl.startsWith('rediss://')) {
      cleanRedisUrl = `rediss://${cleanRedisUrl.replace(/^\/+/, '')}`;
    } else if (cleanRedisUrl.startsWith('redis://')) {
      cleanRedisUrl = cleanRedisUrl.replace(/^redis:\/\//, 'rediss://');
    }
  }

  const redisHost = process.env.REDIS_HOST || '127.0.0.1';
  const redisPort = parseInt(process.env.REDIS_PORT || '6380', 10);
  const targetEnv = process.env.PROVIDER_TARGET || 'lab';

  const isRedisTls = cleanRedisUrl?.startsWith('rediss://') || false;
  const redisOptions: RedisOptions = {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
      return Math.min(times * 100, 3000);
    },
    ...(isRedisTls ? { tls: { rejectUnauthorized: false } } : {}),
  };

  const redis = cleanRedisUrl
    ? new Redis(cleanRedisUrl, redisOptions)
    : new Redis({ host: redisHost, port: redisPort, ...redisOptions });

  const subRedis = cleanRedisUrl
    ? new Redis(cleanRedisUrl, { ...redisOptions, enableReadyCheck: false })
    : new Redis({ host: redisHost, port: redisPort, ...redisOptions, enableReadyCheck: false });

  redis.on('error', (err) => {
    console.warn('[Redis] Connection warning:', err.message);
  });
  subRedis.on('error', (err) => {
    console.warn('[SubRedis] Connection warning:', err.message);
  });

  const paymentRepo = new PaymentRepository(pool);
  const breakerManager = new CircuitBreakerManager({ redis });
  const healthTracker = new HealthTracker({
    redis,
    subRedis,
    providers: ['razorpay', 'stripe', 'payu'],
    methods: ['card', 'upi', 'netbanking'],
  });
  await healthTracker.init();

  const configCache = new ProviderConfigCache({ pool });
  await configCache.init();

  // Adapter configuration based on target environment
  const labUrl = process.env.PROVIDER_LAB_URL || 'http://127.0.0.1:4000';
  const adapters = new Map<string, ProviderAdapter>([
    [
      'razorpay',
      new RazorpayAdapter({
        baseUrl: targetEnv === 'lab' ? `${labUrl}/razorpay` : undefined,
      }),
    ],
    [
      'stripe',
      new StripeAdapter({
        baseUrl: targetEnv === 'lab' ? `${labUrl}/stripe` : undefined,
      }),
    ],
    [
      'payu',
      new PayUAdapter({
        baseUrl: targetEnv === 'lab' ? `${labUrl}/payu` : undefined,
      }),
    ],
  ]);

  const orchestrator = new PaymentOrchestrator({
    paymentRepo,
    breakerManager,
    healthTracker,
    configCache,
    adapters,
  });

  const worker = new ResolutionWorker({
    pool,
    paymentRepo,
    adapters,
    orchestrator,
  });

  // Background resolution worker loop: runs every 5s
  const workerInterval = setInterval(() => {
    worker.processDuePayments().catch((err) => {
      console.error('Error in background resolution worker:', err);
    });
  }, 5000);

  const app = await buildApp({
    orchestrator,
    paymentRepo,
    healthTracker,
    redis,
    configCache,
  });

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`PayRoute Engine running on http://0.0.0.0:${port} (target: ${targetEnv})`);

  const shutdown = async () => {
    clearInterval(workerInterval);
    configCache.close();
    await app.close();
    await healthTracker.close();
    await redis.quit();
    subRedis.disconnect();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Auto-start if executed directly
const scriptPath = process.argv[1]?.replace(/\\/g, '/');
if (scriptPath?.endsWith('dist/index.js') || scriptPath?.endsWith('src/index.ts')) {
  const port = parseInt(process.env.ENGINE_PORT || '3000', 10);
  startServer(port).catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
