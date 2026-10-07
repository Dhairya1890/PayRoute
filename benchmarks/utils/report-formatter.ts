import type { Result } from 'autocannon';

export interface ScenarioReport {
  scenarioName: string;
  targetUrl: string;
  durationSec: number;
  connections: number;
  rpsMean: number;
  rpsMax: number;
  totalRequests: number;
  res2xx: number;
  non2xx: number;
  timeouts: number;
  errors: number;
  latencyMinMs: number;
  latencyP50Ms: number;
  latencyP75Ms: number;
  latencyP90Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  latencyMaxMs: number;
  duplicateCharges?: number;
  invariantStatus?: 'PASSED' | 'FAILED';
}

/**
 * Extracts a concise ScenarioReport from an Autocannon Result.
 */
export function extractReport(
  scenarioName: string,
  result: Result,
  invariantCheck?: { passed: boolean; duplicateCharges?: number }
): ScenarioReport {
  return {
    scenarioName,
    targetUrl: result.url,
    durationSec: typeof result.duration === 'number' ? result.duration : 10,
    connections: result.connections,
    rpsMean: Math.round(result.requests.mean * 10) / 10,
    rpsMax: result.requests.max,
    totalRequests: result.requests.total,
    res2xx: result['2xx'] ?? result.res2xx ?? (result.requests.total - (result.non2xx ?? 0)),
    non2xx: result.non2xx ?? 0,
    timeouts: result.timeouts,
    errors: result.errors,
    latencyMinMs: result.latency.min,
    latencyP50Ms: result.latency.p50,
    latencyP75Ms: result.latency.p75,
    latencyP90Ms: result.latency.p90,
    latencyP95Ms: result.latency.p97_5, // closest standard autocannon percentile
    latencyP99Ms: result.latency.p99,
    latencyMaxMs: result.latency.max,
    duplicateCharges: invariantCheck?.duplicateCharges ?? 0,
    invariantStatus: invariantCheck ? (invariantCheck.passed ? 'PASSED' : 'FAILED') : undefined,
  };
}

/**
 * Prints a clean, high-impact terminal summary for a benchmark run.
 */
export function printTerminalReport(report: ScenarioReport): void {
  const divider = '─'.repeat(72);
  const doubleDivider = '═'.repeat(72);

  console.log('\n' + doubleDivider);
  console.log(`  PAYROUTE BENCHMARK: ${report.scenarioName.toUpperCase()}`);
  console.log(doubleDivider);
  console.log(`  Target:       ${report.targetUrl}`);
  console.log(`  Concurrency:  ${report.connections} parallel connections`);
  console.log(`  Duration:     ${report.durationSec}s`);
  console.log(divider);
  console.log('  THROUGHPUT METRICS');
  console.log(`  • Average RPS:       ${report.rpsMean.toLocaleString()} req/sec`);
  console.log(`  • Peak RPS:          ${report.rpsMax.toLocaleString()} req/sec`);
  console.log(`  • Total Requests:    ${report.totalRequests.toLocaleString()}`);
  console.log(`  • 2xx Responses:     ${report.res2xx.toLocaleString()}`);
  console.log(`  • Non-2xx Responses: ${report.non2xx.toLocaleString()}`);
  console.log(`  • Errors / Timeouts: ${report.errors} / ${report.timeouts}`);
  console.log(divider);
  console.log('  LATENCY DISTRIBUTION (ms)');
  console.log(`  • Min:               ${report.latencyMinMs} ms`);
  console.log(`  • p50 (Median):      ${report.latencyP50Ms} ms`);
  console.log(`  • p75:               ${report.latencyP75Ms} ms`);
  console.log(`  • p90:               ${report.latencyP90Ms} ms`);
  console.log(`  • p95 / p97.5:       ${report.latencyP95Ms} ms`);
  console.log(`  • p99:               ${report.latencyP99Ms} ms`);
  console.log(`  • Max:               ${report.latencyMaxMs} ms`);

  if (report.invariantStatus) {
    console.log(divider);
    console.log('  FINANCIAL INVARIANT VERIFICATION');
    const symbol = report.invariantStatus === 'PASSED' ? '✓' : '✗';
    console.log(`  [${symbol}] Status:            ${report.invariantStatus}`);
    console.log(`  • Duplicate Debits:  ${report.duplicateCharges ?? 0} (Rule 3 Invariant: Exactly 0 allowed)`);
  }
  console.log(doubleDivider + '\n');
}

/**
 * Formats a Markdown table summarizing multiple scenario reports for documentation or README.
 */
export function generateMarkdownSummary(reports: ScenarioReport[]): string {
  const header = `| Scenario | Concurrency | RPS (Avg) | p50 Latency | p95 Latency | p99 Latency | 2xx Success | Invariants |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`;

  const rows = reports.map((r) => {
    const successRate = r.totalRequests > 0
      ? `${((r.res2xx / r.totalRequests) * 100).toFixed(1)}%`
      : '0%';
    const inv = r.invariantStatus === 'PASSED' ? '✓ PASSED' : '✗ FAILED';
    return `| **${r.scenarioName}** | ${r.connections} | ${r.rpsMean} req/s | ${r.latencyP50Ms} ms | ${r.latencyP95Ms} ms | ${r.latencyP99Ms} ms | ${successRate} | ${inv} |`;
  });

  return `${header}\n${rows.join('\n')}`;
}
