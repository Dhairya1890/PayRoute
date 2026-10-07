import { OutcomeClass } from '@payroute/core';
import {
  ProviderAdapter,
  ProviderCapabilities,
  SubmitPaymentRequest,
  SubmitPaymentResult,
  GetStatusResult,
  CancelResult,
} from './interface.js';

export interface PayUAdapterConfig {
  baseUrl?: string;
  merchantKey?: string;
  merchantSalt?: string;
  timeoutMs?: number;
}

export class PayUAdapter implements ProviderAdapter {
  readonly name = 'payu';
  readonly capabilities: ProviderCapabilities = {
    supportsIdempotency: true,
    supportsStatusLookup: true,
    supportsCancel: false,
    supportedMethods: ['card', 'netbanking'],
    supportedCurrencies: ['INR'],
  };

  private readonly baseUrl: string;
  private readonly merchantKey: string;
  private readonly timeoutMs: number;

  constructor(config: PayUAdapterConfig = {}) {
    this.baseUrl = config.baseUrl || 'https://test.payu.in';
    this.merchantKey = config.merchantKey || process.env.PAYU_KEY || 'payu_test_key';
    this.timeoutMs = config.timeoutMs || 5000;
  }

  async submit(
    request: SubmitPaymentRequest,
    idempotencyReference: string
  ): Promise<SubmitPaymentResult> {
    const url = `${this.baseUrl}/payment`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'merchant-key': this.merchantKey,
        },
        body: JSON.stringify({
          txnid: idempotencyReference,
          amount: (Number(request.amountMinor) / 100).toFixed(2),
          productinfo: request.paymentId,
          firstname: request.customerReference || 'Customer',
          email: 'customer@example.com',
          metadata: {
            paymentId: request.paymentId,
            ...(request.metadata || {}),
          },
          notes: {
            paymentId: request.paymentId,
            ...(request.metadata || {}),
          },
        }),
        signal: controller.signal,
      });

      const body: any = await response.json();

      if (!response.ok) {
        const error = new Error(body.message || 'PayU payment submission failed');
        (error as any).status = response.status;
        throw error;
      }

      return {
        providerRef: body.mihpayid || idempotencyReference,
        status: body.status === 'success' ? 'succeeded' : 'pending',
        rawResponse: body,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getStatus(
    idempotencyReference: string,
    _providerRef?: string
  ): Promise<GetStatusResult> {
    const url = `${this.baseUrl}/verify_payment`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ var1: idempotencyReference }),
        signal: controller.signal,
      });

      const body: any = await response.json();

      if (body.status === 0 || !body.transaction_details?.[idempotencyReference]) {
        return { providerRef: idempotencyReference, status: 'not_found', rawResponse: body };
      }

      const tx = body.transaction_details[idempotencyReference];
      return {
        providerRef: tx.mihpayid || idempotencyReference,
        status: tx.status === 'success' ? 'succeeded' : 'failed',
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
      reason: 'PayU does not support server-side cancellation',
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
      if (err.status >= 500) {
        return 'ambiguous';
      }
    }

    const res = responseOrError as any;
    if (res.status === 'success' || res.status === 'succeeded') {
      return 'success';
    }

    return 'ambiguous';
  }
}
