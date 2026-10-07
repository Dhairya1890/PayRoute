import autocannon from 'autocannon';
import {
  ENGINE_URL,
  ENGINE_API_KEY,
  ensureServicesRunning,
  resetProviderLab,
  setProviderMode,
  verifyZeroDuplicateCharges,
} from '../utils/setup-env.js';
import { extractReport, printTerminalReport, ScenarioReport } from '../utils/report-formatter.js';

export interface BreakerStormOptions {
  connections?: number;
  duration?: number;
}

export async function runBreakerStorm(
  options: BreakerStormOptions = {}
): Promise<ScenarioReport> {
  await ensureServicesRunning();
  await resetProviderLab();

  const connections = options.connections ?? 30;
  const duration = options.duration ?? 8;

  console.log('[Breaker Storm Benchmark] Injecting Razorpay outage (unavailable mode)...');
  await setProviderMode('razorpay', 'unavailable');

  console.log(
    `[Breaker Storm Benchmark] Firing load under primary outage (${connections} connections, ${duration}s)...`
  );

  const instance = autocannon({
    url: `${ENGINE_URL}/payments`,
    method: 'POST',
    connections,
    duration,
    headers: {
      'content-type': 'application/json',
      'x-api-key': ENGINE_API_KEY,
    },
    setupClient: (client) => {
      let counter = 0;
      const updateRequest = () => {
        counter++;
        const idKey = `bench_breaker_${Date.now()}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
        client.setHeaders({
          'content-type': 'application/json',
          'x-api-key': ENGINE_API_KEY,
          'idempotency-key': idKey,
        });
        client.setBody(
          JSON.stringify({
            amount_minor: 1999,
            currency: 'INR',
            payment_method: 'card',
          })
        );
      };

      updateRequest();
      client.on('response', () => {
        updateRequest();
      });
    },
  });

  const result = await new Promise<autocannon.Result>((resolve) => {
    instance.on('done', (res) => resolve(res));
  });

  // Query engine providers to inspect breaker state
  try {
    const provRes = await fetch(`${ENGINE_URL}/providers`, {
      headers: { 'x-api-key': ENGINE_API_KEY },
    });
    if (provRes.ok) {
      const providersData = await provRes.json();
      console.log('  PROVIDER BREAKER STATES AFTER LOAD:');
      for (const p of providersData) {
        const rate = typeof p.smoothed_success_rate === 'number'
          ? `${(p.smoothed_success_rate * 100).toFixed(1)}%`
          : 'N/A';
        console.log(`  • ${p.name.padEnd(10)}: Breaker [${p.breaker_state || 'closed'}] | Success Rate: ${rate}`);
      }
    }
  } catch {
    // Non-fatal
  }

  // Restore provider back to healthy
  await setProviderMode('razorpay', 'healthy');

  // Verify financial invariants
  const invariantCheck = await verifyZeroDuplicateCharges();

  const report = extractReport('Circuit Breaker Storm & Dynamic Failover', result, {
    passed: invariantCheck.passed,
    duplicateCharges: invariantCheck.duplicateKeys.length,
  });

  printTerminalReport(report);
  return report;
}

// Auto-run if executed directly
if (process.argv[1]?.replace(/\\/g, '/').endsWith('breaker-storm.ts')) {
  runBreakerStorm().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
