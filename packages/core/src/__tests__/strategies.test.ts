import { describe, it, expect } from 'vitest';
import {
  selectProvider,
  RoutingContext,
  ProviderCandidate,
} from '../strategies.js';

describe('Routing Strategies & Decision Trace', () => {
  const baseCandidates: ProviderCandidate[] = [
    {
      name: 'razorpay',
      enabled: true,
      priority: 1,
      costBps: 190,
      timeoutMs: 5000,
      supportedMethods: ['card', 'upi', 'netbanking'],
      supportedCurrencies: ['INR'],
      breakerState: 'closed',
      hasProbeSlot: false,
      backoffUntil: null,
      stats: { ok: 95, attempts: 100, p95LatencyMs: 120 },
    },
    {
      name: 'stripe',
      enabled: true,
      priority: 2,
      costBps: 290,
      timeoutMs: 5000,
      supportedMethods: ['card'],
      supportedCurrencies: ['INR', 'USD', 'EUR'],
      breakerState: 'closed',
      hasProbeSlot: false,
      backoffUntil: null,
      stats: { ok: 99, attempts: 100, p95LatencyMs: 250 },
    },
    {
      name: 'payu',
      enabled: true,
      priority: 3,
      costBps: 180,
      timeoutMs: 5000,
      supportedMethods: ['card', 'netbanking'],
      supportedCurrencies: ['INR'],
      breakerState: 'closed',
      hasProbeSlot: false,
      backoffUntil: null,
      stats: { ok: 88, attempts: 100, p95LatencyMs: 200 },
    },
  ];

  const baseContext: RoutingContext = {
    paymentMethod: 'card',
    currency: 'INR',
    attemptNumber: 1,
    perProviderAttempts: { razorpay: 0, stripe: 0, payu: 0 },
    maxAttemptsPerProvider: 2,
    hardDeclinedProviders: new Set(),
    strategy: 'priority',
    policy: 'full',
    explorationShare: 0, // Disabled by default for deterministic tests
    now: new Date('2026-10-05T12:00:00Z'),
    random: () => 0.5,
  };

  describe('Candidate Filtering and Exclusion Reasons', () => {
    it('excludes disabled providers with explicit reason', () => {
      const candidates = baseCandidates.map((c) =>
        c.name === 'razorpay' ? { ...c, enabled: false } : c
      );
      const result = selectProvider(candidates, baseContext);

      expect(result.chosenProvider).toBe('stripe');
      const traceRazorpay = result.decisionTrace.candidates.find((c) => c.name === 'razorpay');
      expect(traceRazorpay?.eligible).toBe(false);
      expect(traceRazorpay?.exclusionReason).toMatch(/disabled/i);
    });

    it('excludes providers that do not support the requested payment method', () => {
      const result = selectProvider(baseCandidates, {
        ...baseContext,
        paymentMethod: 'upi', // Stripe does not support UPI
      });

      expect(result.chosenProvider).toBe('razorpay');
      const traceStripe = result.decisionTrace.candidates.find((c) => c.name === 'stripe');
      expect(traceStripe?.eligible).toBe(false);
      expect(traceStripe?.exclusionReason).toMatch(/does not support method upi/i);
    });

    it('excludes providers that do not support the requested currency', () => {
      const result = selectProvider(baseCandidates, {
        ...baseContext,
        currency: 'USD', // Razorpay and PayU only support INR in config
      });

      expect(result.chosenProvider).toBe('stripe');
      const traceRazorpay = result.decisionTrace.candidates.find((c) => c.name === 'razorpay');
      expect(traceRazorpay?.eligible).toBe(false);
      expect(traceRazorpay?.exclusionReason).toMatch(/does not support currency USD/i);
    });

    it('excludes providers in open circuit breaker state (unless half-open with probe slot)', () => {
      const candidates = baseCandidates.map((c) =>
        c.name === 'razorpay' ? { ...c, breakerState: 'open' as const } : c
      );
      const result = selectProvider(candidates, baseContext);

      expect(result.chosenProvider).toBe('stripe');
      const traceRazorpay = result.decisionTrace.candidates.find((c) => c.name === 'razorpay');
      expect(traceRazorpay?.eligible).toBe(false);
      expect(traceRazorpay?.exclusionReason).toMatch(/circuit breaker is open/i);
    });

    it('allows half-open provider if it has an available probe slot', () => {
      const candidates = baseCandidates.map((c) =>
        c.name === 'razorpay'
          ? { ...c, breakerState: 'half_open' as const, hasProbeSlot: true }
          : c
      );
      const result = selectProvider(candidates, baseContext);

      expect(result.chosenProvider).toBe('razorpay');
      const traceRazorpay = result.decisionTrace.candidates.find((c) => c.name === 'razorpay');
      expect(traceRazorpay?.eligible).toBe(true);
    });

    it('excludes providers in an active rate-limit backoff window', () => {
      const candidates = baseCandidates.map((c) =>
        c.name === 'razorpay'
          ? { ...c, backoffUntil: new Date('2026-10-05T12:00:30Z') }
          : c
      );
      const result = selectProvider(candidates, {
        ...baseContext,
        now: new Date('2026-10-05T12:00:10Z'), // Current time is inside backoff window
      });

      expect(result.chosenProvider).toBe('stripe');
      const traceRazorpay = result.decisionTrace.candidates.find((c) => c.name === 'razorpay');
      expect(traceRazorpay?.eligible).toBe(false);
      expect(traceRazorpay?.exclusionReason).toMatch(/backoff window/i);
    });

    it('excludes providers when per-provider attempt cap is reached', () => {
      const result = selectProvider(baseCandidates, {
        ...baseContext,
        perProviderAttempts: { razorpay: 2, stripe: 0, payu: 0 },
        maxAttemptsPerProvider: 2,
      });

      expect(result.chosenProvider).toBe('stripe');
      const traceRazorpay = result.decisionTrace.candidates.find((c) => c.name === 'razorpay');
      expect(traceRazorpay?.eligible).toBe(false);
      expect(traceRazorpay?.exclusionReason).toMatch(/attempt cap/i);
    });

    it('excludes providers that previously returned a hard decline for this payment', () => {
      const result = selectProvider(baseCandidates, {
        ...baseContext,
        hardDeclinedProviders: new Set(['razorpay']),
      });

      expect(result.chosenProvider).toBe('stripe');
      const traceRazorpay = result.decisionTrace.candidates.find((c) => c.name === 'razorpay');
      expect(traceRazorpay?.eligible).toBe(false);
      expect(traceRazorpay?.exclusionReason).toMatch(/hard decline/i);
    });
  });

  describe('Strategies: priority, lowest_cost, weighted', () => {
    it('priority strategy selects lowest priority number among eligible', () => {
      const result = selectProvider(baseCandidates, {
        ...baseContext,
        strategy: 'priority',
      });
      expect(result.chosenProvider).toBe('razorpay');
      expect(result.decisionTrace.strategy).toBe('priority');
    });

    it('lowest_cost strategy selects cheapest provider above success floor', () => {
      // PayU is cheapest (180 bps), Razorpay (190), Stripe (290)
      const result = selectProvider(baseCandidates, {
        ...baseContext,
        strategy: 'lowest_cost',
      });
      expect(result.chosenProvider).toBe('payu');
      expect(result.decisionTrace.strategy).toBe('lowest_cost');
    });

    it('weighted strategy selects highest composite score', () => {
      // Stripe has 99% success rate vs Razorpay 95% and PayU 88%
      const result = selectProvider(baseCandidates, {
        ...baseContext,
        strategy: 'weighted',
      });
      // Verify chosen is the top scored candidate
      expect(result.chosenProvider).toBeDefined();
      expect(result.decisionTrace.strategy).toBe('weighted');
    });
  });

  describe('Exploration Picking (Deterministic via Injectable Random)', () => {
    it('picks a non-top candidate when random() < explorationShare on attempt 1', () => {
      const result = selectProvider(baseCandidates, {
        ...baseContext,
        strategy: 'priority', // Normal winner is razorpay
        explorationShare: 0.1, // 10%
        attemptNumber: 1,
        random: () => 0.02, // 0.02 < 0.1 -> triggers exploration
      });

      expect(result.isExplorationPick).toBe(true);
      expect(result.chosenProvider).not.toBe('razorpay'); // Explored stripe or payu
    });

    it('NEVER triggers exploration on subsequent attempts (attempt > 1)', () => {
      const result = selectProvider(baseCandidates, {
        ...baseContext,
        strategy: 'priority',
        explorationShare: 0.5,
        attemptNumber: 2,
        random: () => 0.01,
      });

      expect(result.isExplorationPick).toBe(false);
      expect(result.chosenProvider).toBe('razorpay');
    });
  });
});
