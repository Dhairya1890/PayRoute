import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { decide, DecisionContext } from '../decide.js';
import { OutcomeClass } from '../classification.js';
import {
  canTransitionPayment,
  transitionPayment,
  canTransitionAttempt,
  transitionAttempt,
  PaymentState,
  AttemptState,
} from '../transition-tables.js';
import { calculateSmoothedSuccessRate } from '../scoring.js';

describe('Property-Based Invariant Verification (fast-check)', () => {
  const arbitraryOutcome: fc.Arbitrary<OutcomeClass> = fc.constantFrom(
    'success',
    'hard_decline',
    'soft_decline',
    'not_sent',
    'rate_limited',
    'config_error',
    'bad_request',
    'transient_known',
    'ambiguous'
  );

  const arbitraryContext: fc.Arbitrary<DecisionContext> = fc.record({
    paymentId: fc.uuid(),
    currentProvider: fc.constantFrom('stripe', 'razorpay', 'payu'),
    attemptNumber: fc.integer({ min: 1, max: 10 }),
    providerAttempts: fc.dictionary(
      fc.constantFrom('stripe', 'razorpay', 'payu'),
      fc.integer({ min: 0, max: 10 })
    ),
    maxAttemptsTotal: fc.integer({ min: 1, max: 5 }),
    maxAttemptsPerProvider: fc.integer({ min: 1, max: 3 }),
    remainingDeadlineMs: fc.integer({ min: -1000, max: 20000 }),
    minAttemptTimeoutMs: fc.integer({ min: 100, max: 3000 }),
    retryBudgetRemaining: fc.integer({ min: 0, max: 100 }),
    cascadesUsed: fc.integer({ min: 0, max: 5 }),
    maxCascades: fc.integer({ min: 0, max: 2 }),
    isIdempotencyHonored: fc.boolean(),
    isCurrentProviderBreakerClosed: fc.boolean(),
    availableFailoverCandidates: fc.array(fc.constantFrom('stripe', 'razorpay', 'payu'), { maxLength: 3 }),
    declineReason: fc.option(fc.string(), { nil: undefined }),
    retryAfterMs: fc.option(fc.integer({ min: 50, max: 5000 }), { nil: undefined }),
    backoffDelayMs: fc.option(fc.integer({ min: 50, max: 2000 }), { nil: undefined }),
  });

  it('Property: Ambiguous outcome NEVER triggers failover or retry; always queries status first (Rule 3 & 10)', () => {
    fc.assert(
      fc.property(arbitraryContext, (context) => {
        const action = decide('ambiguous', context);
        // Invariant: MUST be query_status. Never failover, retry_same, fail, or finish.
        expect(action.type).toBe('query_status');
        if (action.type === 'query_status') {
          expect(action.provider).toBe(context.currentProvider);
        }
      }),
      { numRuns: 500 }
    );
  });

  it('Property: Hard decline NEVER triggers failover or retry anywhere; always fails with decline reason', () => {
    fc.assert(
      fc.property(arbitraryContext, (context) => {
        const action = decide('hard_decline', context);
        // Hard decline is always terminal fail
        expect(action.type).toBe('fail');
        if (action.type === 'fail') {
          expect(action.retryable).toBe(false);
        }
      }),
      { numRuns: 500 }
    );
  });

  it('Property: Success ALWAYS finishes immediately', () => {
    fc.assert(
      fc.property(arbitraryContext, (context) => {
        const action = decide('success', context);
        expect(action).toEqual({ type: 'finish', outcome: 'succeeded' });
      }),
      { numRuns: 200 }
    );
  });

  it('Property: When total attempts exhausted, non-success non-ambiguous outcomes always fail', () => {
    fc.assert(
      fc.property(
        arbitraryContext.filter((ctx) => ctx.attemptNumber >= ctx.maxAttemptsTotal),
        arbitraryOutcome.filter((o) => o !== 'success' && o !== 'ambiguous'),
        (context, outcome) => {
          const action = decide(outcome, context);
          expect(action.type).toBe('fail');
          if (action.type === 'fail') {
            expect(action.retryable).toBe(false);
          }
        }
      ),
      { numRuns: 500 }
    );
  });

  it('Property: Terminal payment states (succeeded, failed) CANNOT transition to any state', () => {
    const allStates: PaymentState[] = ['created', 'processing', 'unknown', 'succeeded', 'failed'];
    const terminalStates: PaymentState[] = ['succeeded', 'failed'];

    fc.assert(
      fc.property(
        fc.constantFrom(...terminalStates),
        fc.constantFrom(...allStates),
        (terminal, target) => {
          expect(canTransitionPayment(terminal, target)).toBe(false);
          expect(() => transitionPayment(terminal, target)).toThrow(/Illegal transition/);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property: Terminal attempt states (succeeded, failed) CANNOT transition to any state', () => {
    const allAttemptStates: AttemptState[] = ['started', 'unknown', 'succeeded', 'failed'];
    const terminalAttemptStates: AttemptState[] = ['succeeded', 'failed'];

    fc.assert(
      fc.property(
        fc.constantFrom(...terminalAttemptStates),
        fc.constantFrom(...allAttemptStates),
        (terminal, target) => {
          expect(canTransitionAttempt(terminal, target)).toBe(false);
          expect(() => transitionAttempt(terminal, target)).toThrow(/Illegal transition/);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property: Smoothed success rate is always in [0, 1] and monotonic with successes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (successes, extraFailures) => {
          const total = successes + extraFailures;
          const rate = calculateSmoothedSuccessRate(successes, total);
          expect(rate).toBeGreaterThanOrEqual(0);
          expect(rate).toBeLessThanOrEqual(1);

          // Monotonicity: adding a success should not decrease the rate
          const ratePlusSuccess = calculateSmoothedSuccessRate(successes + 1, total + 1);
          expect(ratePlusSuccess).toBeGreaterThanOrEqual(rate - 1e-9);
        }
      ),
      { numRuns: 500 }
    );
  });
});
