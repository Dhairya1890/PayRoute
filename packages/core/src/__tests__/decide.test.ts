import { describe, it, expect } from 'vitest';
import {
  decide,
  DecisionContext,
  OutcomeClass,
} from '../decide.js';

describe('decide() - Pure Decision Logic Matrix', () => {
  const baseContext: DecisionContext = {
    paymentId: 'pay_123',
    currentProvider: 'razorpay',
    attemptNumber: 1,
    providerAttempts: { razorpay: 1, stripe: 0, payu: 0 },
    maxAttemptsTotal: 3,
    maxAttemptsPerProvider: 2,
    remainingDeadlineMs: 7000,
    minAttemptTimeoutMs: 2000,
    retryBudgetRemaining: 5,
    cascadesUsed: 0,
    maxCascades: 1,
    isIdempotencyHonored: true,
    isCurrentProviderBreakerClosed: true,
    availableFailoverCandidates: ['stripe', 'payu'],
  };

  it('success -> Finish successfully', () => {
    const action = decide('success', baseContext);
    expect(action).toEqual({ type: 'finish', outcome: 'succeeded' });
  });

  it('hard_decline -> Fail payment immediately with decline reason, no retry on any provider', () => {
    const action = decide('hard_decline', {
      ...baseContext,
      declineReason: 'Card reported stolen',
    });
    expect(action).toEqual({
      type: 'fail',
      reason: 'Card reported stolen',
      errorClass: 'hard_decline',
      retryable: false,
    });
  });

  it('soft_decline -> Fail over to next provider if cascade budget remains', () => {
    const action = decide('soft_decline', {
      ...baseContext,
      cascadesUsed: 0,
      maxCascades: 1,
      availableFailoverCandidates: ['stripe'],
    });
    expect(action).toEqual({
      type: 'failover',
      nextProvider: 'stripe',
      reason: 'Soft decline cascade to next provider',
    });
  });

  it('soft_decline -> Fail payment if cascade cap reached', () => {
    const action = decide('soft_decline', {
      ...baseContext,
      cascadesUsed: 1,
      maxCascades: 1,
      availableFailoverCandidates: ['stripe'],
      declineReason: 'Issuer unavailable',
    });
    expect(action).toEqual({
      type: 'fail',
      reason: 'Issuer unavailable',
      errorClass: 'soft_decline',
      retryable: false,
    });
  });

  it('not_sent -> Fail over immediately to next provider', () => {
    const action = decide('not_sent', baseContext);
    expect(action).toEqual({
      type: 'failover',
      nextProvider: 'stripe',
      reason: 'Request not sent to provider (connection/DNS failure)',
    });
  });

  it('rate_limited -> Retry same provider if Retry-After fits deadline and under cap', () => {
    const action = decide('rate_limited', {
      ...baseContext,
      retryAfterMs: 500,
      remainingDeadlineMs: 5000,
    });
    expect(action).toEqual({
      type: 'retry_same',
      provider: 'razorpay',
      delayMs: 500,
      reason: 'Rate limited by provider; honoring Retry-After window',
    });
  });

  it('rate_limited -> Failover if Retry-After exceeds remaining deadline', () => {
    const action = decide('rate_limited', {
      ...baseContext,
      retryAfterMs: 6000,
      remainingDeadlineMs: 4000,
      availableFailoverCandidates: ['stripe'],
    });
    expect(action).toEqual({
      type: 'failover',
      nextProvider: 'stripe',
      reason: 'Rate limited and Retry-After exceeds remaining deadline; failing over',
    });
  });

  it('config_error -> Failover, trip breaker, and raise alert', () => {
    const action = decide('config_error', baseContext);
    expect(action).toEqual({
      type: 'failover',
      nextProvider: 'stripe',
      tripBreaker: true,
      alert: true,
      reason: 'Provider authentication or configuration failure (401/403)',
    });
  });

  it('bad_request -> Fail payment as internal bug and alert', () => {
    const action = decide('bad_request', baseContext);
    expect(action).toEqual({
      type: 'fail',
      reason: 'Internal bad request error (4xx) caused by invalid request format',
      errorClass: 'bad_request',
      retryable: false,
      alert: true,
    });
  });

  it('transient_known -> Retry same provider once if conditions hold', () => {
    const action = decide('transient_known', {
      ...baseContext,
      backoffDelayMs: 300,
    });
    expect(action).toEqual({
      type: 'retry_same',
      provider: 'razorpay',
      delayMs: 300,
      reason: 'Known transient error; retrying same provider with backoff',
    });
  });

  it('transient_known -> Failover if per-provider cap is reached', () => {
    const action = decide('transient_known', {
      ...baseContext,
      providerAttempts: { razorpay: 2, stripe: 0, payu: 0 },
      maxAttemptsPerProvider: 2,
      availableFailoverCandidates: ['stripe'],
    });
    expect(action).toEqual({
      type: 'failover',
      nextProvider: 'stripe',
      reason: 'Per-provider attempt limit reached; failing over',
    });
  });

  it('ambiguous -> Query status first before deciding next action', () => {
    const action = decide('ambiguous', baseContext);
    expect(action).toEqual({
      type: 'query_status',
      provider: 'razorpay',
      reason: 'Ambiguous outcome (timeout/5xx); must verify provider status before retry or failover',
    });
  });

  describe('Boundary Conditions', () => {
    it('fails immediately if remaining deadline is shorter than minimum attempt timeout', () => {
      const action = decide('not_sent', {
        ...baseContext,
        remainingDeadlineMs: 1500,
        minAttemptTimeoutMs: 2000,
      });
      expect(action).toEqual({
        type: 'fail',
        reason: 'Payment deadline exceeded; insufficient time for next attempt',
        errorClass: 'deadline_exceeded',
        retryable: false,
      });
    });

    it('fails if total attempts cap is reached', () => {
      const action = decide('not_sent', {
        ...baseContext,
        attemptNumber: 3,
        maxAttemptsTotal: 3,
      });
      expect(action).toEqual({
        type: 'fail',
        reason: 'Maximum total payment attempts (3) exhausted',
        errorClass: 'attempts_exhausted',
        retryable: false,
      });
    });

    it('fails if no failover candidates remain', () => {
      const action = decide('not_sent', {
        ...baseContext,
        availableFailoverCandidates: [],
      });
      expect(action).toEqual({
        type: 'fail',
        reason: 'All eligible payment providers have been exhausted',
        errorClass: 'providers_exhausted',
        retryable: false,
      });
    });
  });
});
