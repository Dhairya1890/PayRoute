export interface ScoreParams {
  smoothedSuccessRate: number;
  p95LatencyMs: number;
  costBps: number;
  maxExpectedLatencyMs?: number;
  maxExpectedCostBps?: number;
  weightLatency?: number;
  weightCost?: number;
}

/**
 * Calculates smoothed success rate using a Bayesian prior.
 * 
 * Formula:
 * (ok + prior_ok) / (attempts + prior_n)
 * Default prior: 19 successes out of 20 attempts (0.95 prior).
 * 
 * Why:
 * Prevents cold-start skew or thin traffic spikes (e.g. 1 failure out of 1 request)
 * from artificially cratering a provider's health score to 0%.
 */
export function calculateSmoothedSuccessRate(
  ok: number,
  attempts: number,
  priorOk = 19,
  priorN = 20
): number {
  return (ok + priorOk) / (attempts + priorN);
}

export function normalizeLatency(p95LatencyMs: number, maxExpectedLatencyMs = 1000): number {
  return Math.min(1.0, Math.max(0, p95LatencyMs) / maxExpectedLatencyMs);
}

export function normalizeCost(costBps: number, maxExpectedCostBps = 500): number {
  return Math.min(1.0, Math.max(0, costBps) / maxExpectedCostBps);
}

/**
 * Calculates the composite routing score:
 * score = success_smoothed - w_lat * normalized_p95 - w_cost * normalized_cost
 * Default starting weights: 0.1 for latency, 0.1 for cost.
 */
export function calculateScore(params: ScoreParams): number {
  const {
    smoothedSuccessRate,
    p95LatencyMs,
    costBps,
    maxExpectedLatencyMs = 1000,
    maxExpectedCostBps = 500,
    weightLatency = 0.1,
    weightCost = 0.1,
  } = params;

  const normalizedP95 = normalizeLatency(p95LatencyMs, maxExpectedLatencyMs);
  const normalizedCost = normalizeCost(costBps, maxExpectedCostBps);

  return smoothedSuccessRate - weightLatency * normalizedP95 - weightCost * normalizedCost;
}
