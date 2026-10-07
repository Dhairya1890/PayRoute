import { describe, it, expect } from 'vitest';
import {
  canTransitionPayment,
  transitionPayment,
  canTransitionAttempt,
  transitionAttempt,
} from '../state-machine.js';

describe('State Machine - Transitions and Invariants', () => {
  describe('Payment state transitions', () => {
    it('allows legal forward transitions from created', () => {
      expect(canTransitionPayment('created', 'processing')).toBe(true);
      expect(transitionPayment('created', 'processing')).toBe('processing');
    });

    it('allows legal transitions from processing', () => {
      expect(canTransitionPayment('processing', 'succeeded')).toBe(true);
      expect(canTransitionPayment('processing', 'failed')).toBe(true);
      expect(canTransitionPayment('processing', 'unknown')).toBe(true);
      expect(canTransitionPayment('processing', 'requires_action')).toBe(true);
    });

    it('allows legal transitions for requires_action', () => {
      expect(canTransitionPayment('requires_action', 'processing')).toBe(true);
      expect(canTransitionPayment('requires_action', 'failed')).toBe(true);
    });

    it('allows resolution from unknown to terminal states', () => {
      expect(canTransitionPayment('unknown', 'succeeded')).toBe(true);
      expect(canTransitionPayment('unknown', 'failed')).toBe(true);
    });

    it('REJECTS illegal transitions and terminal regressions', () => {
      // Succeeded cannot regress to any state
      expect(canTransitionPayment('succeeded', 'failed')).toBe(false);
      expect(canTransitionPayment('succeeded', 'processing')).toBe(false);
      expect(canTransitionPayment('succeeded', 'unknown')).toBe(false);
      expect(() => transitionPayment('succeeded', 'failed')).toThrow(/Illegal transition/);

      // Failed cannot regress to any state
      expect(canTransitionPayment('failed', 'succeeded')).toBe(false);
      expect(canTransitionPayment('failed', 'processing')).toBe(false);
      expect(() => transitionPayment('failed', 'succeeded')).toThrow(/Illegal transition/);

      // Cannot skip processing from created directly to succeeded
      expect(canTransitionPayment('created', 'succeeded')).toBe(false);
      expect(() => transitionPayment('created', 'succeeded')).toThrow(/Illegal transition/);
    });
  });

  describe('Payment Attempt state transitions', () => {
    it('allows legal forward transitions from started', () => {
      expect(canTransitionAttempt('started', 'succeeded')).toBe(true);
      expect(canTransitionAttempt('started', 'failed')).toBe(true);
      expect(canTransitionAttempt('started', 'unknown')).toBe(true);
    });

    it('allows resolution from unknown to terminal states', () => {
      expect(canTransitionAttempt('unknown', 'succeeded')).toBe(true);
      expect(canTransitionAttempt('unknown', 'failed')).toBe(true);
    });

    it('REJECTS attempt terminal state regressions', () => {
      expect(canTransitionAttempt('succeeded', 'failed')).toBe(false);
      expect(canTransitionAttempt('failed', 'succeeded')).toBe(false);
      expect(canTransitionAttempt('succeeded', 'started')).toBe(false);
      expect(() => transitionAttempt('succeeded', 'failed')).toThrow(/Illegal transition/);
    });
  });
});
