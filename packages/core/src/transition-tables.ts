export type PaymentState = 'created' | 'processing' | 'succeeded' | 'failed' | 'unknown';
export type AttemptState = 'started' | 'succeeded' | 'failed' | 'unknown';

export const PAYMENT_TRANSITION_TABLE: Readonly<Record<PaymentState, ReadonlySet<PaymentState>>> = {
  created: new Set<PaymentState>(['processing']),
  processing: new Set<PaymentState>(['succeeded', 'failed', 'unknown']),
  unknown: new Set<PaymentState>(['succeeded', 'failed', 'processing']), // processing allowed if confirmed not charged and attempts remain
  succeeded: new Set<PaymentState>([]), // Terminal: never regresses
  failed: new Set<PaymentState>([]),    // Terminal: never regresses
};

export const ATTEMPT_TRANSITION_TABLE: Readonly<Record<AttemptState, ReadonlySet<AttemptState>>> = {
  started: new Set<AttemptState>(['succeeded', 'failed', 'unknown']),
  unknown: new Set<AttemptState>(['succeeded', 'failed']),
  succeeded: new Set<AttemptState>([]), // Terminal: append-only
  failed: new Set<AttemptState>([]),    // Terminal: append-only
};

export function canTransitionPayment(from: PaymentState, to: PaymentState): boolean {
  return PAYMENT_TRANSITION_TABLE[from]?.has(to) ?? false;
}

export function transitionPayment(from: PaymentState, to: PaymentState): PaymentState {
  if (!canTransitionPayment(from, to)) {
    throw new Error(`Illegal transition for Payment from "${from}" to "${to}". Terminal states cannot regress.`);
  }
  return to;
}

export function canTransitionAttempt(from: AttemptState, to: AttemptState): boolean {
  return ATTEMPT_TRANSITION_TABLE[from]?.has(to) ?? false;
}

export function transitionAttempt(from: AttemptState, to: AttemptState): AttemptState {
  if (!canTransitionAttempt(from, to)) {
    throw new Error(`Illegal transition for Attempt from "${from}" to "${to}". Terminal states cannot regress.`);
  }
  return to;
}
