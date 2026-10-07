/**
 * Payment Lifecycle States
 * 
 * - created: Record inserted, client idempotency established, awaiting provider selection.
 * - processing: Provider selected, attempt record committed, charge in flight.
 * - requires_action: Customer interaction required (e.g. 3-D Secure OTP, bank redirect).
 * - succeeded: Confirmed successful charge. Terminal state.
 * - failed: Confirmed decline or all retry/failover attempts exhausted. Terminal state.
 * - unknown: Ambiguous outcome (timeout/5xx) where provider status is inconclusive.
 *            Awaits worker status check or webhook resolution.
 */
export type PaymentStatus =
  | 'created'
  | 'processing'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'unknown';

/**
 * Payment Attempt Lifecycle States
 * 
 * - started: Short DB transaction committed, HTTP call to provider dispatched.
 * - succeeded: Provider confirmed successful charge. Terminal state.
 * - failed: Provider returned decline or failure known not to have charged. Terminal state.
 * - unknown: Ambiguous network error or timeout. Awaits status check resolution.
 */
export type PaymentAttemptStatus = 'started' | 'succeeded' | 'failed' | 'unknown';

/**
 * Allowed transitions for Payment state machine.
 * Any transition not explicitly listed is forbidden.
 * 
 * KEY INVARIANT: Terminal states (succeeded, failed) have an empty set of transitions.
 * Once a payment reaches a terminal state, it can NEVER change again.
 */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, ReadonlySet<PaymentStatus>>> = {
  created: new Set<PaymentStatus>(['processing']),
  processing: new Set<PaymentStatus>(['succeeded', 'failed', 'unknown', 'requires_action']),
  requires_action: new Set<PaymentStatus>(['processing', 'failed']),
  unknown: new Set<PaymentStatus>(['succeeded', 'failed']),
  succeeded: new Set<PaymentStatus>([]), // Terminal: no transitions permitted
  failed: new Set<PaymentStatus>([]),    // Terminal: no transitions permitted
};

/**
 * Allowed transitions for Payment Attempt state machine.
 */
export const ATTEMPT_TRANSITIONS: Readonly<Record<PaymentAttemptStatus, ReadonlySet<PaymentAttemptStatus>>> = {
  started: new Set<PaymentAttemptStatus>(['succeeded', 'failed', 'unknown']),
  unknown: new Set<PaymentAttemptStatus>(['succeeded', 'failed']),
  succeeded: new Set<PaymentAttemptStatus>([]), // Terminal
  failed: new Set<PaymentAttemptStatus>([]),    // Terminal
};

/**
 * Checks whether a payment transition from currentStatus to nextStatus is legal.
 */
export function canTransitionPayment(currentStatus: PaymentStatus, nextStatus: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[currentStatus]?.has(nextStatus) ?? false;
}

/**
 * Enforces payment state transition according to the transition table.
 * Throws an Error on any illegal transition to prevent state corruption.
 */
export function transitionPayment(currentStatus: PaymentStatus, nextStatus: PaymentStatus): PaymentStatus {
  if (!canTransitionPayment(currentStatus, nextStatus)) {
    throw new Error(
      `Illegal transition for Payment from "${currentStatus}" to "${nextStatus}". Terminal states cannot regress.`
    );
  }
  return nextStatus;
}

/**
 * Checks whether an attempt transition from currentStatus to nextStatus is legal.
 */
export function canTransitionAttempt(currentStatus: PaymentAttemptStatus, nextStatus: PaymentAttemptStatus): boolean {
  return ATTEMPT_TRANSITIONS[currentStatus]?.has(nextStatus) ?? false;
}

/**
 * Enforces attempt state transition according to the transition table.
 */
export function transitionAttempt(
  currentStatus: PaymentAttemptStatus,
  nextStatus: PaymentAttemptStatus
): PaymentAttemptStatus {
  if (!canTransitionAttempt(currentStatus, nextStatus)) {
    throw new Error(
      `Illegal transition for Payment Attempt from "${currentStatus}" to "${nextStatus}". Terminal states cannot regress.`
    );
  }
  return nextStatus;
}

/**
 * Helper to check if a status is terminal.
 */
export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

export function isTerminalAttemptStatus(status: PaymentAttemptStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}
