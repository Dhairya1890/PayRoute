/**
 * Standard Outcome Classes for PayRoute
 * 
 * Every provider adapter classifies all responses and errors into exactly one of these classes.
 * This decouples provider-specific error payloads from engine decision logic.
 */
export type OutcomeClass =
  | 'success'
  | 'hard_decline'
  | 'soft_decline'
  | 'not_sent'
  | 'rate_limited'
  | 'config_error'
  | 'bad_request'
  | 'transient_known'
  | 'ambiguous';

/**
 * Knowledge of whether the customer was charged.
 */
export type ChargeKnowledge = 'charged' | 'not_charged' | 'unknown';

export interface OutcomeMetadata {
  readonly knowledge: ChargeKnowledge;
  readonly countsTowardBreaker: 'success' | 'failure' | 'none';
  readonly tripsBreakerImmediately: boolean;
}

export const OUTCOME_METADATA: Record<OutcomeClass, OutcomeMetadata> = {
  success: {
    knowledge: 'charged',
    countsTowardBreaker: 'success',
    tripsBreakerImmediately: false,
  },
  hard_decline: {
    knowledge: 'not_charged',
    countsTowardBreaker: 'none',
    tripsBreakerImmediately: false,
  },
  soft_decline: {
    knowledge: 'not_charged',
    countsTowardBreaker: 'none',
    tripsBreakerImmediately: false,
  },
  not_sent: {
    knowledge: 'not_charged',
    countsTowardBreaker: 'failure',
    tripsBreakerImmediately: false,
  },
  rate_limited: {
    knowledge: 'not_charged',
    countsTowardBreaker: 'none',
    tripsBreakerImmediately: false,
  },
  config_error: {
    knowledge: 'not_charged',
    countsTowardBreaker: 'failure',
    tripsBreakerImmediately: true, // Bad API keys/credentials trip breaker immediately
  },
  bad_request: {
    knowledge: 'not_charged',
    countsTowardBreaker: 'none', // Bug on our end, not provider health issue
    tripsBreakerImmediately: false,
  },
  transient_known: {
    knowledge: 'not_charged',
    countsTowardBreaker: 'failure',
    tripsBreakerImmediately: false,
  },
  ambiguous: {
    knowledge: 'unknown',
    countsTowardBreaker: 'failure',
    tripsBreakerImmediately: false,
  },
};

export function isCustomerCharged(outcome: OutcomeClass): boolean {
  return OUTCOME_METADATA[outcome].knowledge === 'charged';
}

export function isCustomerKnownNotCharged(outcome: OutcomeClass): boolean {
  return OUTCOME_METADATA[outcome].knowledge === 'not_charged';
}

export function isAmbiguousOutcome(outcome: OutcomeClass): boolean {
  return OUTCOME_METADATA[outcome].knowledge === 'unknown';
}
