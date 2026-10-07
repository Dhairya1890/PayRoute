import autocannon from 'autocannon';
import {
  ENGINE_URL,
  ENGINE_API_KEY,
  ensureServicesRunning,
} from '../utils/setup-env.js';
import { extractReport, printTerminalReport, ScenarioReport } from '../utils/report-formatter.js';

export interface TelemetryReadOptions {
  connections?: number;
  duration?: number;
}

export async function runTelemetryRead(
  options: TelemetryReadOptions = {}
): Promise<ScenarioReport> {
  await ensureServicesRunning();

  const connections = options.connections ?? 50;
  const duration = options.duration ?? 8;

  console.log(
    `[Telemetry Read Benchmark] Benchmarking in-memory provider telemetry path (${connections} connections, ${duration}s)...`
  );

  const instance = autocannon({
    url: `${ENGINE_URL}/providers`,
    method: 'GET',
    connections,
    duration,
    headers: {
      'x-api-key': ENGINE_API_KEY,
    },
  });

  const result = await new Promise<autocannon.Result>((resolve) => {
    instance.on('done', (res) => resolve(res));
  });

  const report = extractReport('In-Memory Telemetry Read Scalability', result, {
    passed: result.errors === 0 && (result.non2xx ?? 0) === 0,
  });

  printTerminalReport(report);
  return report;
}

// Auto-run if executed directly
if (process.argv[1]?.replace(/\\/g, '/').endsWith('telemetry-read.ts')) {
  runTelemetryRead().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
