import { describe, it, expect } from 'vitest';
import { InvariantChecker, LabChargeRecord } from '../invariant-checker.js';
import { PaymentRecord, AttemptRecord } from '../../db/payment-repository.js';

describe('InvariantChecker - Financial Invariant Verification', () => {
  const mockPayment = (status: PaymentRecord['status']): PaymentRecord => ({
    id: 'pay_inv_1',
    businessId: 'biz_1',
    idempotencyKey: 'idem_inv_1',
    requestHash: 'hash',
    amountMinor: 1000n,
    currency: 'INR',
    paymentMethod: 'card',
    status,
    customerReference: null,
    batchId: null,
    finalProvider: status === 'succeeded' ? 'razorpay' : null,
    failureReason: null,
    deadlineAt: new Date(Date.now() - 10000),
    resolutionDeadlineAt: null,
    nextActionTime: null,
    needsReview: false,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const mockAttempt = (status: AttemptRecord['status']): AttemptRecord => ({
    id: 'att_1',
    paymentId: 'pay_inv_1',
    attemptNo: 1,
    provider: 'razorpay',
    providerRef: 'ref_1',
    providerErrorCode: null,
    status,
    errorClass: status === 'succeeded' ? 'success' : 'hard_decline',
    latencyMs: 120,
    routingReason: 'priority',
    decisionTrace: {},
    startedAt: new Date(),
    finishedAt: new Date(),
  });

  it('Catches violation if succeeded payment has 0 or >1 succeeded attempts', () => {
    const payment = mockPayment('succeeded');
    // 0 succeeded attempts
    const v1 = InvariantChecker.checkAttemptSuccessConsistency(payment, [mockAttempt('failed')]);
    expect(v1).toHaveLength(1);
    expect(v1[0].rule).toBe('SINGLE_SUCCEEDED_ATTEMPT');

    // Exactly 1 succeeded attempt -> 0 violations
    const v2 = InvariantChecker.checkAttemptSuccessConsistency(payment, [mockAttempt('succeeded')]);
    expect(v2).toHaveLength(0);

    // 2 succeeded attempts -> critical violation!
    const v3 = InvariantChecker.checkAttemptSuccessConsistency(payment, [
      mockAttempt('succeeded'),
      mockAttempt('succeeded'),
    ]);
    expect(v3).toHaveLength(1);
    expect(v3[0].rule).toBe('SINGLE_SUCCEEDED_ATTEMPT');
  });

  it('Catches violation if failed or processing payment has a succeeded attempt', () => {
    const payment = mockPayment('failed');
    const v = InvariantChecker.checkAttemptSuccessConsistency(payment, [mockAttempt('succeeded')]);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('NO_SUCCESS_FOR_NON_SUCCEEDED_PAYMENT');
  });

  it('Catches duplicate charges recorded in Provider Lab ledger', () => {
    const labCharges: LabChargeRecord[] = [
      {
        provider: 'razorpay',
        providerRef: 'ref_1',
        idempotencyKey: 'pay_inv_1_1',
        amountMinor: '1000',
        currency: 'INR',
        status: 'succeeded',
      },
      {
        provider: 'stripe',
        providerRef: 'ref_2',
        idempotencyKey: 'pay_inv_1_2',
        amountMinor: '1000',
        currency: 'INR',
        status: 'succeeded',
      },
    ];

    const violations = InvariantChecker.checkZeroDuplicateCharges('pay_inv_1', 'idem_inv_1', labCharges);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('ZERO_DUPLICATE_CHARGES');
    expect(violations[0].message).toContain('DUPLICATE CHARGE DETECTED');
  });

  it('Catches terminal state regression violations', () => {
    const v1 = InvariantChecker.checkNoTerminalRegression('pay_1', 'succeeded', 'processing');
    expect(v1).toHaveLength(1);
    expect(v1[0].rule).toBe('TERMINAL_IMMUTABILITY');

    const v2 = InvariantChecker.checkNoTerminalRegression('pay_1', 'failed', 'processing');
    expect(v2).toHaveLength(1);

    const v3 = InvariantChecker.checkNoTerminalRegression('pay_1', 'processing', 'succeeded');
    expect(v3).toHaveLength(0); // Legal transition
  });

  it('Catches stranded payments past deadline without next action or review flag', () => {
    const stranded = mockPayment('unknown'); // deadlineAt is in the past, nextActionTime is null, needsReview is false
    const violations = InvariantChecker.checkNoStrandedPayments([stranded]);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('NO_STRANDED_PAYMENTS');

    stranded.needsReview = true;
    expect(InvariantChecker.checkNoStrandedPayments([stranded])).toHaveLength(0);
  });
});
