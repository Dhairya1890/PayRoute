import { ensureServicesRunning } from './utils/setup-env.js';
import { generateMarkdownSummary, ScenarioReport } from './utils/report-formatter.js';
import { runPaymentsThroughput } from './scenarios/payments-throughput.js';
import { runIdempotencyRace } from './scenarios/idempotency-race.js';
import { runBreakerStorm } from './scenarios/breaker-storm.js';
import { runTelemetryRead } from './scenarios/telemetry-read.js';

async function main(): Promise<void> {
  console.log('\n======================================================');
  console.log('       PAYROUTE COMPREHENSIVE BENCHMARK SUITE          ');
  console.log('======================================================\n');

  try {
    await ensureServicesRunning();
  } catch (err: any) {
    console.error('\nPre-flight check failed:');
    console.error(err.message);
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const scenarioArg = args.find((a) => a.startsWith('--scenario='))?.split('=')[1] || args[0] || 'all';

  const reports: ScenarioReport[] = [];

  if (scenarioArg === 'payments' || scenarioArg === 'all') {
    const report = await runPaymentsThroughput();
    reports.push(report);
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (scenarioArg === 'idempotency' || scenarioArg === 'all') {
    const report = await runIdempotencyRace();
    reports.push(report);
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (scenarioArg === 'breaker' || scenarioArg === 'all') {
    const report = await runBreakerStorm();
    reports.push(report);
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (scenarioArg === 'telemetry' || scenarioArg === 'all') {
    const report = await runTelemetryRead();
    reports.push(report);
  }

  if (reports.length > 1) {
    console.log('\n======================================================');
    console.log('           OVERALL BENCHMARK SUITE SUMMARY            ');
    console.log('======================================================\n');
    console.log(generateMarkdownSummary(reports));
    console.log('\n======================================================\n');
  }

  const allPassed = reports.every((r) => r.invariantStatus === 'PASSED' || r.invariantStatus === undefined);
  if (!allPassed) {
    console.error('One or more benchmarks violated system invariants!');
    process.exit(1);
  } else {
    console.log('All financial invariants and SLA metrics verified successfully.');
  }
}

main().catch((err) => {
  console.error('Fatal benchmark suite failure:', err);
  process.exit(1);
});
