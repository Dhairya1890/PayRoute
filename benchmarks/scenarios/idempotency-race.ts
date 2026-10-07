import autocannon from 'autocannon';
import {
  ENGINE_URL,
  ENGINE_API_KEY,
  ensureServicesRunning,
  resetProviderLab,
  verifyZeroDuplicateCharges,
  fetchLabCharges,
} from '../utils/setup-env.js';
import { extractReport, printTerminalReport, ScenarioReport } from '../utils/report-formatter.js';

export interface IdempotencyRaceOptions {
  connections?: number;
  duration?: number;
  keyPoolSize?: number;
}

export async function runIdempotencyRace(
  options: IdempotencyRaceOptions = {}
): Promise<ScenarioReport> {
  await ensureServicesRunning();
  await resetProviderLab();

  const connections = options.connections ?? 50;
  const duration = options.duration ?? 5;
  const keyPoolSize = options.keyPoolSize ?? 5; // 5 keys hammered concurrently across 50 connections

  // Pre-generate the shared key pool
  const sharedKeys = Array.from(
    { length: keyPoolSize },
    (_, i) => `race_key_${Date.now()}_pool_${i}`
  );

  console.log(
    `[Idempotency Race Benchmark] Hammering ${keyPoolSize} shared keys with ${connections} concurrent connections for ${duration}s...`
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
      // Pick a random key from the shared pool on each request
      const updateRequest = () => {
        const selectedKey = sharedKeys[Math.floor(Math.random() * sharedKeys.length)];
        client.setHeaders({
          'content-type': 'application/json',
          'x-api-key': ENGINE_API_KEY,
          'idempotency-key': selectedKey,
        });
        client.setBody(
          JSON.stringify({
            amount_minor: 5000,
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

  // Post-benchmark invariant check: Wait 500ms for any in-flight requests to settle
  await new Promise((r) => setTimeout(r, 500));
  const charges = await fetchLabCharges();
  const dupCheck = await verifyZeroDuplicateCharges();

  // Retrieve payment IDs created for the shared keys from the engine API
  const paymentIds: string[] = [];
  try {
    const listRes = await fetch(`${ENGINE_URL}/payments?limit=50`, {
      headers: { 'x-api-key': ENGINE_API_KEY },
    });
    if (listRes.ok) {
      const list = await listRes.json();
      for (const p of list) {
        if (sharedKeys.includes(p.idempotency_key)) {
          paymentIds.push(p.id);
        }
      }
    }
  } catch {
    // Non-fatal fallback
  }

  // Count charges that belong specifically to the payments created during this race
  const chargesForRace = paymentIds.length > 0
    ? charges.filter((c) => paymentIds.some((pid) => c.idempotencyKey.startsWith(pid)))
    : charges;

  const exactOnePerKey = chargesForRace.length === keyPoolSize;
  const passed = dupCheck.passed && exactOnePerKey;

  const report = extractReport('Idempotency Race & Thundering Herd', result, {
    passed,
    duplicateCharges: dupCheck.duplicateKeys.length,
  });

  console.log(`  • Shared Key Pool Size:        ${keyPoolSize} distinct keys`);
  console.log(`  • Actual Provider Charges:    ${chargesForRace.length} (Expected exactly ${keyPoolSize})`);
  console.log(`  • Exact-1-Charge-Per-Key:      ${exactOnePerKey ? 'YES' : 'NO'}`);

  printTerminalReport(report);
  return report;
}

// Auto-run if executed directly
if (process.argv[1]?.replace(/\\/g, '/').endsWith('idempotency-race.ts')) {
  runIdempotencyRace().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
