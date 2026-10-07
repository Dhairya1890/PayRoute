import { OutcomeClass } from '@payroute/core';
import {
  ProviderAdapter,
  ProviderCapabilities,
  SubmitPaymentRequest,
  SubmitPaymentResult,
  GetStatusResult,
  CancelResult,
} from './interface.js';

export interface StripeAdapterConfig {
  baseUrl?: string;
  secretKey?: string;
  timeoutMs?: number;
}

export class StripeAdapter implements ProviderAdapter {
  readonly name = 'stripe';
  readonly capabilities: ProviderCapabilities = {
    supportsIdempotency: true,
    supportsStatusLookup: true,
    supportsCancel: true,
    supportedMethods: ['card'],
    supportedCurrencies: ['INR', 'USD', 'EUR', 'GBP'],
  };

  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly timeoutMs: number;

  constructor(config: StripeAdapterConfig = {}) {
    this.baseUrl = config.baseUrl || 'https://api.stripe.com';
    this.secretKey = config.secretKey || process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';
    this.timeoutMs = config.timeoutMs || 5000;
  }

  async submit(
    request: SubmitPaymentRequest,
    idempotencyReference: string
  ): Promise<SubmitPaymentResult> {
    const url = `${this.baseUrl}/v1/payment_intents`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Idempotency-Key': idempotencyReference,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: Number(request.amountMinor),
          currency: request.currency.toLowerCase(),
          payment_method_types: ['card'],
          metadata: {
            paymentId: request.paymentId,
            ...(request.metadata || {}),
          },
        }),
        signal: controller.signal,
      });

      const body: any = await response.json();

      if (!response.ok) {
        const error = new Error(body.error?.message || 'Stripe payment intent creation failed');
        (error as any).status = response.status;
        (error as any).code = body.error?.code;
        (error as any).declineCode = body.error?.decline_code;
        (error as any).headers = response.headers;
        throw error;
      }

      return {
        providerRef: body.id,
        status: body.status === 'succeeded' ? 'succeeded' : 'pending',
        rawResponse: body,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getStatus(
    idempotencyReference: string,
    providerRef?: string
  ): Promise<GetStatusResult> {
    const target = providerRef || idempotencyReference;
    if (!target) {
      return { providerRef: '', status: 'not_found', rawResponse: null };
    }

    const url = `${this.baseUrl}/v1/payment_intents/${target}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
        signal: controller.signal,
      });

      if (response.status === 404) {
        return { providerRef: target, status: 'not_found', rawResponse: null };
      }

      const body: any = await response.json();
      return {
        providerRef: body.id,
        status: body.status === 'succeeded' ? 'succeeded' : 'failed',
        amountMinor: body.amount ? BigInt(body.amount) : undefined,
        currency: body.currency?.toUpperCase(),
        rawResponse: body,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async cancel(_idempotencyReference: string, providerRef?: string): Promise<CancelResult> {
    if (!providerRef) {
      return { success: false, supported: true, reason: 'No providerRef provided for cancel' };
    }

    const url = `${this.baseUrl}/v1/payment_intents/${providerRef}/cancel`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.secretKey}` },
      });
      return { success: response.ok, supported: true };
    } catch (err: any) {
      return { success: false, supported: true, reason: err.message };
    }
  }

  classify(responseOrError: unknown): OutcomeClass {
    if (!responseOrError) return 'ambiguous';

    // If it's an Error
    if (responseOrError instanceof Error) {
      const err = responseOrError as any;

      if (err.name === 'AbortError' || err.code === 'ECONNRESET' || err.status === 504 || err.status === 502) {
        return 'ambiguous';
      }

      if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
        return 'not_sent';
      }

      if (err.status === 401 || err.status === 403) {
        return 'config_error';
      }

      if (err.status === 429) {
        return 'rate_limited';
      }

      if (err.code === 'card_declined') {
        const hardDeclines = new Set([
          'stolen_card',
          'lost_card',
          'insufficient_funds',
          'invalid_account',
          'pickup_card',
          'card_velocity_exceeded',
        ]);
        if (hardDeclines.has(err.declineCode)) {
          return 'hard_decline';
        }
        return 'soft_decline';
      }

      if (err.status >= 500) {
        return 'ambiguous';
      }

      if (err.status === 400) {
        return 'bad_request';
      }
    }

    // If it's a response object
    const res = responseOrError as any;
    if (res.status === 'succeeded' || res.status === 'paid') {
      return 'success';
    }

    return 'ambiguous';
  }
}
