import autocannon from 'autocannon';
import {
  ENGINE_URL,
  ENGINE_API_KEY,
  ensureServicesRunning,
  resetProviderLab,
  verifyZeroDuplicateCharges,
} from '../utils/setup-env.js';
import { extractReport, printTerminalReport, ScenarioReport } from '../utils/report-formatter.js';

export interface PaymentsThroughputOptions {
  connections?: number;
  duration?: number;
}

export async function runPaymentsThroughput(
  options: PaymentsThroughputOptions = {}
): Promise<ScenarioReport> {
  await ensureServicesRunning();
  await resetProviderLab();

  const connections = options.connections ?? parseInt(process.env.BENCH_CONNECTIONS || '50', 10);
  const duration = options.duration ?? parseInt(process.env.BENCH_DURATION || '10', 10);

  console.log(`[Throughput Benchmark] Warming up & preparing run (${connections} connections, ${duration}s)...`);

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
        const idKey = `bench_tp_${Date.now()}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
        client.setHeaders({
          'content-type': 'application/json',
          'x-api-key': ENGINE_API_KEY,
          'idempotency-key': idKey,
        });
        client.setBody(
          JSON.stringify({
            amount_minor: 2500,
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

  // Post-benchmark invariant check
  const invariantCheck = await verifyZeroDuplicateCharges();

  const report = extractReport('Payment Ingestion Throughput', result, {
    passed: invariantCheck.passed,
    duplicateCharges: invariantCheck.duplicateKeys.length,
  });

  printTerminalReport(report);
  return report;
}

// Auto-run if executed directly
if (process.argv[1]?.replace(/\\/g, '/').endsWith('payments-throughput.ts')) {
  runPaymentsThroughput().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
