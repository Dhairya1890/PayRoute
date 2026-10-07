import { PaymentRecord, AttemptRecord } from '../db/payment-repository.js';
import { PaymentStatus } from '@payroute/shared';

export interface InvariantViolation {
  paymentId: string;
  rule: string;
  message: string;
  severity: 'critical' | 'warning';
}

export interface LabChargeRecord {
  provider: string;
  providerRef: string;
  idempotencyKey: string;
  amountMinor: string;
  currency: string;
  status: string;
}

/**
 * PayRoute System Invariant Checker
 * 
 * Verifies core financial correctness invariants across payments, attempts, and the Provider Lab ledger:
 * 1. Single Succeeded Attempt: A succeeded payment has exactly one succeeded attempt.
 * 2. Zero Duplicate Charges: The Provider Lab's independent ledger has at most 1 charge for any payment.
 * 3. Terminal Immutability: Succeeded and failed payments never regress to non-terminal states.
 * 4. No Stranded Payments: No non-terminal payment is past deadline without a scheduled next action or review flag.
 */
export class InvariantChecker {
  /**
   * Invariant 1: Succeeded payments must have exactly 1 succeeded attempt; others must have 0.
   */
  static checkAttemptSuccessConsistency(
    payment: PaymentRecord,
    attempts: AttemptRecord[]
  ): InvariantViolation[] {
    const violations: InvariantViolation[] = [];
    const succeededAttempts = attempts.filter((a) => a.status === 'succeeded');

    if (payment.status === 'succeeded' && succeededAttempts.length !== 1) {
      violations.push({
        paymentId: payment.id,
        rule: 'SINGLE_SUCCEEDED_ATTEMPT',
        message: `Succeeded payment has ${succeededAttempts.length} succeeded attempts (expected exactly 1)`,
        severity: 'critical',
      });
    }

    if (payment.status !== 'succeeded' && succeededAttempts.length > 0) {
      violations.push({
        paymentId: payment.id,
        rule: 'NO_SUCCESS_FOR_NON_SUCCEEDED_PAYMENT',
        message: `Payment status is "${payment.status}" but has ${succeededAttempts.length} succeeded attempts`,
        severity: 'critical',
      });
    }

    return violations;
  }

  /**
   * Invariant 2: ZERO Duplicate Charges in Provider Lab independent ledger.
   */
  static checkZeroDuplicateCharges(
    paymentId: string,
    idempotencyKey: string,
    labCharges: LabChargeRecord[]
  ): InvariantViolation[] {
    const violations: InvariantViolation[] = [];

    const matchingCharges = labCharges.filter((c) =>
      c.idempotencyKey.includes(paymentId) || c.idempotencyKey.includes(idempotencyKey)
    );

    if (matchingCharges.length > 1) {
      violations.push({
        paymentId,
        rule: 'ZERO_DUPLICATE_CHARGES',
        message: `DUPLICATE CHARGE DETECTED: Provider Lab recorded ${matchingCharges.length} distinct charges for payment ${paymentId}`,
        severity: 'critical',
      });
    }

    return violations;
  }

  /**
   * Invariant 3: Terminal Immutability - Terminal payments never regress.
   */
  static checkNoTerminalRegression(
    paymentId: string,
    oldStatus: PaymentStatus,
    newStatus: PaymentStatus
  ): InvariantViolation[] {
    const violations: InvariantViolation[] = [];

    if ((oldStatus === 'succeeded' || oldStatus === 'failed') && oldStatus !== newStatus) {
      violations.push({
        paymentId,
        rule: 'TERMINAL_IMMUTABILITY',
        message: `Illegal state regression: payment attempted transition from terminal state "${oldStatus}" to "${newStatus}"`,
        severity: 'critical',
      });
    }

    return violations;
  }

  /**
   * Invariant 4: No Stranded Payments - Non-terminal payments past deadline must have scheduled next action.
   */
  static checkNoStrandedPayments(
    payments: PaymentRecord[],
    now: Date = new Date()
  ): InvariantViolation[] {
    const violations: InvariantViolation[] = [];

    for (const p of payments) {
      if ((p.status === 'processing' || p.status === 'unknown') && p.deadlineAt <= now) {
        if (!p.nextActionTime && !p.needsReview) {
          violations.push({
            paymentId: p.id,
            rule: 'NO_STRANDED_PAYMENTS',
            message: `Payment ${p.id} in "${p.status}" has passed deadline without next_action_time or needs_review flag`,
            severity: 'critical',
          });
        }
      }
    }

    return violations;
  }
}
