import { describe, it, expect } from 'vitest';
import {
  canTransitionPayment,
  transitionPayment,
  canTransitionAttempt,
  transitionAttempt,
} from '../transition-tables.js';

describe('Transition Tables - Legal Transitions & Terminal State Protection', () => {
  describe('Payment Transitions', () => {
    it('allows legal forward transitions from created and processing', () => {
      expect(canTransitionPayment('created', 'processing')).toBe(true);
      expect(canTransitionPayment('processing', 'succeeded')).toBe(true);
      expect(canTransitionPayment('processing', 'failed')).toBe(true);
      expect(canTransitionPayment('processing', 'unknown')).toBe(true);
    });

    it('allows unknown to transition to succeeded, failed, or processing (for retry after confirmed not charged)', () => {
      expect(canTransitionPayment('unknown', 'succeeded')).toBe(true);
      expect(canTransitionPayment('unknown', 'failed')).toBe(true);
      expect(canTransitionPayment('unknown', 'processing')).toBe(true);
    });

    it('REJECTS illegal transitions and terminal regressions', () => {
      expect(canTransitionPayment('succeeded', 'failed')).toBe(false);
      expect(canTransitionPayment('succeeded', 'processing')).toBe(false);
      expect(canTransitionPayment('failed', 'succeeded')).toBe(false);
      expect(canTransitionPayment('failed', 'processing')).toBe(false);
      expect(() => transitionPayment('succeeded', 'failed')).toThrow(/Illegal transition/i);
    });
  });

  describe('Attempt Transitions', () => {
    it('allows legal transitions from started and unknown', () => {
      expect(canTransitionAttempt('started', 'succeeded')).toBe(true);
      expect(canTransitionAttempt('started', 'failed')).toBe(true);
      expect(canTransitionAttempt('started', 'unknown')).toBe(true);
      expect(canTransitionAttempt('unknown', 'succeeded')).toBe(true);
      expect(canTransitionAttempt('unknown', 'failed')).toBe(true);
    });

    it('REJECTS attempt terminal state regressions', () => {
      expect(canTransitionAttempt('succeeded', 'failed')).toBe(false);
      expect(canTransitionAttempt('failed', 'succeeded')).toBe(false);
      expect(() => transitionAttempt('succeeded', 'started')).toThrow(/Illegal transition/i);
    });
  });
});
