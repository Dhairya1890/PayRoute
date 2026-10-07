import { calculateScore, calculateSmoothedSuccessRate } from './scoring.js';

export type StrategyType = 'priority' | 'lowest_cost' | 'weighted';
export type PolicyType = 'full' | 'baseline';

export interface ProviderStats {
  ok: number;
  attempts: number;
  p95LatencyMs: number;
}

export interface ProviderCandidate {
  name: string;
  enabled: boolean;
  priority: number;
  costBps: number;
  timeoutMs: number;
  supportedMethods: string[];
  supportedCurrencies: string[];
  breakerState: 'closed' | 'open' | 'half_open';
  hasProbeSlot: boolean;
  backoffUntil: Date | null;
  stats: ProviderStats;
}

export interface RoutingContext {
  paymentMethod: string;
  currency: string;
  attemptNumber: number;
  perProviderAttempts: Record<string, number>;
  maxAttemptsPerProvider: number;
  hardDeclinedProviders: Set<string>;
  strategy: StrategyType;
  policy: PolicyType;
  explorationShare: number; // e.g. 0.05 for 5%
  now: Date;
  random: () => number;
}

export interface CandidateTrace {
  name: string;
  eligible: boolean;
  exclusionReason?: string;
  score?: number;
  smoothedSuccessRate?: number;
  p95LatencyMs?: number;
  costBps?: number;
}

export interface DecisionTrace {
  strategy: StrategyType;
  policy: PolicyType;
  chosenProvider: string;
  isExplorationPick: boolean;
  candidates: CandidateTrace[];
}

export interface SelectionResult {
  chosenProvider: string;
  isExplorationPick: boolean;
  decisionTrace: DecisionTrace;
}

/**
 * Pure provider selection and explainable decision trace generator.
 * Implements Section 9 (Candidate Set, Strategies, Exploration, Trace).
 */
export function selectProvider(
  candidates: ProviderCandidate[],
  context: RoutingContext
): SelectionResult {
  const candidateTraces: CandidateTrace[] = [];
  const eligibleCandidates: Array<{
    candidate: ProviderCandidate;
    score: number;
    smoothedSuccessRate: number;
  }> = [];

  // 1. Evaluate Eligibility and Record Explanations
  for (const c of candidates) {
    let eligible = true;
    let exclusionReason: string | undefined;

    if (!c.enabled) {
      eligible = false;
      exclusionReason = 'Provider is disabled by configuration or operator kill switch';
    } else if (!c.supportedMethods.includes(context.paymentMethod)) {
      eligible = false;
      exclusionReason = `Provider does not support method ${context.paymentMethod}`;
    } else if (!c.supportedCurrencies.includes(context.currency)) {
      eligible = false;
      exclusionReason = `Provider does not support currency ${context.currency}`;
    } else if (context.policy === 'full') {
      if (c.breakerState === 'open') {
        eligible = false;
        exclusionReason = 'Circuit breaker is open (high recent failure rate)';
      } else if (c.breakerState === 'half_open' && !c.hasProbeSlot) {
        eligible = false;
        exclusionReason = 'Circuit breaker is half-open with no probe slots available';
      } else if (c.backoffUntil && c.backoffUntil > context.now) {
        eligible = false;
        exclusionReason = `Provider in rate-limit backoff window until ${c.backoffUntil.toISOString()}`;
      } else if ((context.perProviderAttempts[c.name] ?? 0) >= context.maxAttemptsPerProvider) {
        eligible = false;
        exclusionReason = `Per-provider attempt cap (${context.maxAttemptsPerProvider}) reached for this payment`;
      } else if (context.hardDeclinedProviders.has(c.name)) {
        eligible = false;
        exclusionReason = 'Provider previously returned a non-retryable hard decline for this payment';
      }
    }

    const smoothedRate = calculateSmoothedSuccessRate(c.stats.ok, c.stats.attempts);
    const score = calculateScore({
      smoothedSuccessRate: smoothedRate,
      p95LatencyMs: c.stats.p95LatencyMs,
      costBps: c.costBps,
    });

    candidateTraces.push({
      name: c.name,
      eligible,
      exclusionReason,
      score,
      smoothedSuccessRate: smoothedRate,
      p95LatencyMs: c.stats.p95LatencyMs,
      costBps: c.costBps,
    });

    if (eligible) {
      eligibleCandidates.push({
        candidate: c,
        score,
        smoothedSuccessRate: smoothedRate,
      });
    }
  }

  if (eligibleCandidates.length === 0) {
    throw new Error('No eligible payment providers available matching request criteria');
  }

  // 2. Baseline policy: Single provider by configured priority
  if (context.policy === 'baseline') {
    eligibleCandidates.sort((a, b) => a.candidate.priority - b.candidate.priority);
    const chosen = eligibleCandidates[0]!.candidate.name;
    return {
      chosenProvider: chosen,
      isExplorationPick: false,
      decisionTrace: {
        strategy: context.strategy,
        policy: context.policy,
        chosenProvider: chosen,
        isExplorationPick: false,
        candidates: candidateTraces,
      },
    };
  }

  // 3. Sort eligible candidates according to strategy
  switch (context.strategy) {
    case 'priority':
      eligibleCandidates.sort((a, b) => a.candidate.priority - b.candidate.priority);
      break;

    case 'lowest_cost':
      // Cheapest among candidates with acceptable success rate (>= 85%)
      const successFloor = 0.85;
      eligibleCandidates.sort((a, b) => {
        const aHealthy = a.smoothedSuccessRate >= successFloor;
        const bHealthy = b.smoothedSuccessRate >= successFloor;
        if (aHealthy && !bHealthy) return -1;
        if (!aHealthy && bHealthy) return 1;
        return a.candidate.costBps - b.candidate.costBps;
      });
      break;

    case 'weighted':
      // Highest composite score
      eligibleCandidates.sort((a, b) => b.score - a.score);
      break;
  }

  let chosenProvider = eligibleCandidates[0]!.candidate.name;
  let isExplorationPick = false;

  // 4. Exploration (Section 9 Rule 5):
  // For first attempts only, with small probability (5%), pick a random non-top candidate
  // so that recovery of downgraded/recovering providers is discovered organically.
  if (
    context.attemptNumber === 1 &&
    eligibleCandidates.length > 1 &&
    context.explorationShare > 0
  ) {
    const roll = context.random();
    if (roll < context.explorationShare) {
      // Pick randomly among remaining non-top candidates
      const nonTopCandidates = eligibleCandidates.slice(1);
      const randomIndex = Math.floor(context.random() * nonTopCandidates.length);
      chosenProvider = nonTopCandidates[randomIndex]!.candidate.name;
      isExplorationPick = true;
    }
  }

  return {
    chosenProvider,
    isExplorationPick,
    decisionTrace: {
      strategy: context.strategy,
      policy: context.policy,
      chosenProvider,
      isExplorationPick,
      candidates: candidateTraces,
    },
  };
}
