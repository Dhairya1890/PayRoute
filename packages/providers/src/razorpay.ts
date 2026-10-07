import { OutcomeClass } from '@payroute/core';
import {
  ProviderAdapter,
  ProviderCapabilities,
  SubmitPaymentRequest,
  SubmitPaymentResult,
  GetStatusResult,
  CancelResult,
} from './interface.js';

export interface RazorpayAdapterConfig {
  baseUrl?: string;
  keyId?: string;
  keySecret?: string;
  timeoutMs?: number;
}

export class RazorpayAdapter implements ProviderAdapter {
  readonly name = 'razorpay';
  readonly capabilities: ProviderCapabilities = {
    supportsIdempotency: true,
    supportsStatusLookup: true,
    supportsCancel: false, // Confirmed: Razorpay orders cannot be canceled via API
    supportedMethods: ['card', 'upi', 'netbanking'],
    supportedCurrencies: ['INR'],
  };

  private readonly baseUrl: string;
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly timeoutMs: number;

  constructor(config: RazorpayAdapterConfig = {}) {
    this.baseUrl = config.baseUrl || 'https://api.razorpay.com';
    this.keyId = config.keyId || process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder';
    this.keySecret = config.keySecret || process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder';
    this.timeoutMs = config.timeoutMs || 5000;
  }

  private get authHeader(): string {
    const credentials = Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
    return `Basic ${credentials}`;
  }

  async submit(
    request: SubmitPaymentRequest,
    idempotencyReference: string
  ): Promise<SubmitPaymentResult> {
    const url = `${this.baseUrl}/v1/orders`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: Number(request.amountMinor),
          currency: request.currency,
          receipt: idempotencyReference,
          notes: {
            paymentId: request.paymentId,
            ...(request.metadata || {}),
          },
        }),
        signal: controller.signal,
      });

      const body: any = await response.json();

      if (!response.ok) {
        const error = new Error(body.error?.description || 'Razorpay order creation failed');
        (error as any).status = response.status;
        (error as any).code = body.error?.code;
        (error as any).reason = body.error?.reason;
        throw error;
      }

      return {
        providerRef: body.id,
        status: body.status === 'paid' ? 'succeeded' : 'pending',
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

    const url = `${this.baseUrl}/v1/orders/${target}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: this.authHeader },
        signal: controller.signal,
      });

      if (response.status === 404) {
        return { providerRef: target, status: 'not_found', rawResponse: null };
      }

      const body: any = await response.json();
      return {
        providerRef: body.id,
        status: body.status === 'paid' ? 'succeeded' : 'pending',
        amountMinor: body.amount ? BigInt(body.amount) : undefined,
        currency: body.currency,
        rawResponse: body,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async cancel(_idempotencyReference: string, _providerRef?: string): Promise<CancelResult> {
    return {
      success: false,
      supported: false,
      reason: 'Razorpay orders do not support API-based cancellation',
    };
  }

  classify(responseOrError: unknown): OutcomeClass {
    if (!responseOrError) return 'ambiguous';

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

      if (err.code === 'BAD_REQUEST_ERROR') {
        const hardDeclines = new Set(['insufficient_funds', 'card_declined', 'expired_card']);
        if (hardDeclines.has(err.reason)) {
          return 'hard_decline';
        }
        return 'bad_request';
      }

      if (err.code === 'GATEWAY_ERROR') {
        return 'transient_known';
      }

      if (err.status >= 500) {
        return 'ambiguous';
      }
    }

    const res = responseOrError as any;
    if (res.status === 'paid' || res.status === 'succeeded') {
      return 'success';
    }

    return 'ambiguous';
  }
}
