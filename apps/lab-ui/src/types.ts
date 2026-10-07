export interface ProviderInfo {
  name: string;
  enabled: boolean;
  priority: number;
  cost_bps: number;
  timeout_ms: number;
  supported_methods: string[];
  supported_currencies: string[];
  breaker_state: 'closed' | 'open' | 'half_open';
  smoothed_success_rate: number;
  p95_latency_ms: number;
  consecutive_opens: number;
  current_mode?: string;
}

export interface ScoreboardData {
  batch_id: string;
  sent: number;
  succeeded: number;
  failed: number;
  unknown: number;
  processing: number;
  retries: number;
  failovers: number;
  needs_review?: number;
  duplicate_charges: number;
  unrecorded_charges: number;
  status: 'running' | 'completed';
  environment: string;
}

export interface PaymentAttempt {
  id: string;
  attempt_no: number;
  provider: string;
  provider_ref: string | null;
  status: 'started' | 'succeeded' | 'failed' | 'unknown';
  error_class: string | null;
  latency_ms: number | null;
  routing_reason: string;
  decision_trace?: {
    strategy?: string;
    chosenProvider?: string;
    isExplorationPick?: boolean;
    candidates?: Array<{
      provider: string;
      eligible: boolean;
      exclusionReason?: string;
      smoothedSuccessRate?: number;
      p95LatencyMs?: number;
      costBps?: number;
      score?: number;
    }>;
  };
  started_at: string;
  finished_at: string | null;
}

export interface PaymentItem {
  id: string;
  idempotency_key: string;
  amount_minor: string;
  currency: string;
  payment_method: string;
  status: 'created' | 'processing' | 'succeeded' | 'failed' | 'unknown';
  final_provider: string | null;
  failure_reason: string | null;
  batch_id: string | null;
  request_hash?: string;
  created_at: string;
  attempts?: PaymentAttempt[];
}

export interface ScenarioResult {
  scenario: string;
  batchId: string;
  verdict: 'PASS' | 'FAIL';
  summary: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export type FailureMode =
  | 'healthy'
  | 'slow'
  | 'flaky'
  | 'unavailable'
  | 'response_lost'
  | 'hard_decline'
  | 'soft_decline'
  | 'rate_limited'
  | 'config_error';
