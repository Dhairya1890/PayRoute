import { OutcomeClass } from '@payroute/core';

export interface SubmitPaymentRequest {
  paymentId: string;
  amountMinor: bigint;
  currency: string;
  paymentMethod: string;
  customerReference?: string;
  metadata?: Record<string, unknown>;
}

export interface SubmitPaymentResult {
  providerRef: string;
  status: 'succeeded' | 'requires_action' | 'pending';
  rawResponse: unknown;
}

export interface GetStatusResult {
  providerRef: string;
  status: 'succeeded' | 'failed' | 'not_found' | 'pending';
  amountMinor?: bigint;
  currency?: string;
  rawResponse: unknown;
}

export interface CancelResult {
  success: boolean;
  supported: boolean;
  reason?: string;
}

export interface ProviderCapabilities {
  supportsIdempotency: boolean;
  supportsStatusLookup: boolean;
  supportsCancel: boolean;
  supportedMethods: readonly string[];
  supportedCurrencies: readonly string[];
}

/**
 * Universal Provider Adapter Interface
 * 
 * All payment providers (Razorpay, Stripe, PayU, and Provider Lab mocks) implement this contract.
 * The routing engine, retry logic, and circuit breaker only communicate through this interface.
 */
export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  /**
   * Submit payment request carrying a stable idempotency reference.
   */
  submit(request: SubmitPaymentRequest, idempotencyReference: string): Promise<SubmitPaymentResult>;

  /**
   * Query the provider for the authoritative state of a payment.
   * Essential for resolving ambiguous outcomes without double charging.
   */
  getStatus(idempotencyReference: string, providerRef?: string): Promise<GetStatusResult>;

  /**
   * Attempt provider-side cancel or void if supported.
   */
  cancel(idempotencyReference: string, providerRef?: string): Promise<CancelResult>;

  /**
   * Classify any response or error into one of the 9 standard outcome classes.
   */
  classify(responseOrError: unknown): OutcomeClass;
}
