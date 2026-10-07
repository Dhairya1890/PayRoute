import { OutcomeClass } from './classification.js';

export interface DecisionContext {
  paymentId: string;
  currentProvider: string;
  attemptNumber: number;
  providerAttempts: Record<string, number>;
  maxAttemptsTotal: number;
  maxAttemptsPerProvider: number;
  remainingDeadlineMs: number;
  minAttemptTimeoutMs: number;
  retryBudgetRemaining: number;
  cascadesUsed: number;
  maxCascades: number;
  isIdempotencyHonored: boolean;
  isCurrentProviderBreakerClosed: boolean;
  availableFailoverCandidates: string[];
  declineReason?: string;
  retryAfterMs?: number;
  backoffDelayMs?: number;
}

export type DecisionAction =
  | { type: 'finish'; outcome: 'succeeded' }
  | {
      type: 'fail';
      reason: string;
      errorClass?: string;
      retryable: boolean;
      alert?: boolean;
    }
  | {
      type: 'retry_same';
      provider: string;
      delayMs: number;
      reason: string;
    }
  | {
      type: 'failover';
      nextProvider: string;
      reason: string;
      tripBreaker?: boolean;
      alert?: boolean;
    }
  | {
      type: 'query_status';
      provider: string;
      reason: string;
    };

/**
 * Pure decision function: decide(outcome, context) -> DecisionAction
 * 
 * Implements Section 6 Rule 10:
 * Encapsulates all retry, failover, circuit breaker trigger, and status check decisions.
 * Free of I/O, clocks, and external dependencies for 100% deterministic testability.
 */
export function decide(outcome: OutcomeClass, context: DecisionContext): DecisionAction {
  // 1. Success finishes immediately
  if (outcome === 'success') {
    return { type: 'finish', outcome: 'succeeded' };
  }

  // 2. Ambiguous outcome: MUST query status first before any retry or failover!
  // Prevents double-charging the customer when a timed-out request actually went through.
  if (outcome === 'ambiguous') {
    return {
      type: 'query_status',
      provider: context.currentProvider,
      reason: 'Ambiguous outcome (timeout/5xx); must verify provider status before retry or failover',
    };
  }

  // 3. Deadline check: If remaining deadline is too tight to complete another attempt, fail immediately
  if (context.remainingDeadlineMs < context.minAttemptTimeoutMs) {
    return {
      type: 'fail',
      reason: 'Payment deadline exceeded; insufficient time for next attempt',
      errorClass: 'deadline_exceeded',
      retryable: false,
    };
  }

  // 4. Total attempt cap exhausted
  if (context.attemptNumber >= context.maxAttemptsTotal) {
    return {
      type: 'fail',
      reason: `Maximum total payment attempts (${context.maxAttemptsTotal}) exhausted`,
      errorClass: 'attempts_exhausted',
      retryable: false,
    };
  }

  // Helper for failover candidates
  const hasFailover = context.availableFailoverCandidates.length > 0;
  const nextCandidate = context.availableFailoverCandidates[0];

  switch (outcome) {
    case 'hard_decline':
      // Hard decline (stolen card, insufficient funds): Final failure, never retried anywhere
      return {
        type: 'fail',
        reason: context.declineReason ?? 'Hard decline: payment refused by issuer',
        errorClass: 'hard_decline',
        retryable: false,
      };

    case 'soft_decline':
      // Soft decline (issuer down): Allow 1 cascade failover if budget remains
      if (context.cascadesUsed < context.maxCascades && context.retryBudgetRemaining > 0 && hasFailover) {
        return {
          type: 'failover',
          nextProvider: nextCandidate!,
          reason: 'Soft decline cascade to next provider',
        };
      }
      return {
        type: 'fail',
        reason: context.declineReason ?? 'Soft decline: cascading limit reached or no failover candidate',
        errorClass: 'soft_decline',
        retryable: false,
      };

    case 'not_sent':
      // Request never left our network (DNS/connection reset): Failover immediately
      if (hasFailover) {
        return {
          type: 'failover',
          nextProvider: nextCandidate!,
          reason: 'Request not sent to provider (connection/DNS failure)',
        };
      }
      return {
        type: 'fail',
        reason: 'All eligible payment providers have been exhausted',
        errorClass: 'providers_exhausted',
        retryable: false,
      };

    case 'rate_limited':
      // 429: If Retry-After fits deadline and under per-provider cap, wait and retry same provider
      if (
        context.retryAfterMs !== undefined &&
        context.retryAfterMs + context.minAttemptTimeoutMs <= context.remainingDeadlineMs &&
        (context.providerAttempts[context.currentProvider] ?? 0) < context.maxAttemptsPerProvider &&
        context.isCurrentProviderBreakerClosed
      ) {
        return {
          type: 'retry_same',
          provider: context.currentProvider,
          delayMs: context.retryAfterMs,
          reason: 'Rate limited by provider; honoring Retry-After window',
        };
      }
      if (hasFailover) {
        return {
          type: 'failover',
          nextProvider: nextCandidate!,
          reason: 'Rate limited and Retry-After exceeds remaining deadline; failing over',
        };
      }
      return {
        type: 'fail',
        reason: 'Rate limited and all providers exhausted',
        errorClass: 'rate_limited',
        retryable: false,
      };

    case 'config_error':
      // 401/403 credentials rejected: Fail over, trip breaker immediately, raise alert
      if (hasFailover) {
        return {
          type: 'failover',
          nextProvider: nextCandidate!,
          tripBreaker: true,
          alert: true,
          reason: 'Provider authentication or configuration failure (401/403)',
        };
      }
      return {
        type: 'fail',
        reason: 'Provider configuration error and no alternative provider available',
        errorClass: 'config_error',
        retryable: false,
        alert: true,
      };

    case 'bad_request':
      // 4xx caused by our request schema: Log bug, fail without retry
      return {
        type: 'fail',
        reason: 'Internal bad request error (4xx) caused by invalid request format',
        errorClass: 'bad_request',
        retryable: false,
        alert: true,
      };

    case 'transient_known':
      // Provider documents response as not processed: Safe to retry same provider if conditions hold
      const currentProviderAttempts = context.providerAttempts[context.currentProvider] ?? 0;
      const canRetrySame =
        context.isIdempotencyHonored &&
        context.isCurrentProviderBreakerClosed &&
        currentProviderAttempts < context.maxAttemptsPerProvider &&
        (context.backoffDelayMs ?? 200) + context.minAttemptTimeoutMs <= context.remainingDeadlineMs &&
        context.retryBudgetRemaining > 0;

      if (canRetrySame) {
        return {
          type: 'retry_same',
          provider: context.currentProvider,
          delayMs: context.backoffDelayMs ?? 200,
          reason: 'Known transient error; retrying same provider with backoff',
        };
      }

      if (hasFailover) {
        return {
          type: 'failover',
          nextProvider: nextCandidate!,
          reason:
            currentProviderAttempts >= context.maxAttemptsPerProvider
              ? 'Per-provider attempt limit reached; failing over'
              : 'Same-provider retry conditions not met; failing over',
        };
      }

      return {
        type: 'fail',
        reason: 'Transient error and all provider attempts exhausted',
        errorClass: 'transient_known',
        retryable: false,
      };
  }
}
