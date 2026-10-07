import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StripeAdapter } from '../stripe.js';
import { RazorpayAdapter } from '../razorpay.js';
import { PayUAdapter } from '../payu.js';
import http from 'node:http';

describe('Provider Adapters', () => {
  let mockServer: http.Server;
  let serverUrl: string;
  let mockHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeEach(async () => {
    mockServer = http.createServer((req, res) => {
      mockHandler(req, res);
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as any;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  describe('StripeAdapter', () => {
    it('submits payment with idempotency key and returns providerRef', async () => {
      let receivedHeaders: any;
      let receivedBody: any;

      mockHandler = (req, res) => {
        receivedHeaders = req.headers;
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => {
          receivedBody = JSON.parse(data);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'pi_test_123',
              status: 'succeeded',
            })
          );
        });
      };

      const adapter = new StripeAdapter({ baseUrl: serverUrl, secretKey: 'sk_test_123' });
      const result = await adapter.submit(
        {
          paymentId: 'pay_1',
          amountMinor: 50000n,
          currency: 'INR',
          paymentMethod: 'card',
        },
        'idem_key_stripe_1'
      );

      expect(result.providerRef).toBe('pi_test_123');
      expect(result.status).toBe('succeeded');
      expect(receivedHeaders['idempotency-key']).toBe('idem_key_stripe_1');
      expect(receivedHeaders['authorization']).toBe('Bearer sk_test_123');
      expect(receivedBody.amount).toBe(50000);
      expect(receivedBody.currency).toBe('inr');
    });

    it('getStatus retrieves payment intent details', async () => {
      mockHandler = (req, res) => {
        expect(req.url).toBe('/v1/payment_intents/pi_test_123');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'pi_test_123',
            status: 'succeeded',
            amount: 50000,
            currency: 'inr',
          })
        );
      };

      const adapter = new StripeAdapter({ baseUrl: serverUrl });
      const status = await adapter.getStatus('idem_key_1', 'pi_test_123');

      expect(status.status).toBe('succeeded');
      expect(status.providerRef).toBe('pi_test_123');
      expect(status.amountMinor).toBe(50000n);
      expect(status.currency).toBe('INR');
    });

    it('classifies hard declines, soft declines, and config errors correctly', () => {
      const adapter = new StripeAdapter();

      const hardErr = new Error('Card declined');
      (hardErr as any).code = 'card_declined';
      (hardErr as any).declineCode = 'insufficient_funds';
      expect(adapter.classify(hardErr)).toBe('hard_decline');

      const softErr = new Error('Card declined');
      (softErr as any).code = 'card_declined';
      (softErr as any).declineCode = 'issuer_unavailable';
      expect(adapter.classify(softErr)).toBe('soft_decline');

      const authErr = new Error('Auth error');
      (authErr as any).status = 401;
      expect(adapter.classify(authErr)).toBe('config_error');

      const rateErr = new Error('Rate limit');
      (rateErr as any).status = 429;
      expect(adapter.classify(rateErr)).toBe('rate_limited');

      const timeoutErr = new Error('Timeout');
      timeoutErr.name = 'AbortError';
      expect(adapter.classify(timeoutErr)).toBe('ambiguous');
    });
  });

  describe('RazorpayAdapter', () => {
    it('submits order with receipt idempotency reference and basic auth', async () => {
      let receivedHeaders: any;
      let receivedBody: any;

      mockHandler = (req, res) => {
        receivedHeaders = req.headers;
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => {
          receivedBody = JSON.parse(data);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'order_rzp_123',
              status: 'paid',
            })
          );
        });
      };

      const adapter = new RazorpayAdapter({
        baseUrl: serverUrl,
        keyId: 'rzp_key',
        keySecret: 'rzp_secret',
      });
      const result = await adapter.submit(
        {
          paymentId: 'pay_rzp_1',
          amountMinor: 25000n,
          currency: 'INR',
          paymentMethod: 'upi',
        },
        'rcpt_12345'
      );

      expect(result.providerRef).toBe('order_rzp_123');
      expect(result.status).toBe('succeeded');
      expect(receivedHeaders['authorization']).toContain('Basic ');
      expect(receivedBody.receipt).toBe('rcpt_12345');
      expect(receivedBody.amount).toBe(25000);
    });

    it('classifies gateway errors as transient_known and bad requests correctly', () => {
      const adapter = new RazorpayAdapter();

      const gwErr = new Error('Gateway error');
      (gwErr as any).code = 'GATEWAY_ERROR';
      expect(adapter.classify(gwErr)).toBe('transient_known');

      const hardErr = new Error('Insufficient funds');
      (hardErr as any).code = 'BAD_REQUEST_ERROR';
      (hardErr as any).reason = 'insufficient_funds';
      expect(adapter.classify(hardErr)).toBe('hard_decline');

      const otherBadRequest = new Error('Invalid format');
      (otherBadRequest as any).code = 'BAD_REQUEST_ERROR';
      (otherBadRequest as any).reason = 'bad_field';
      expect(adapter.classify(otherBadRequest)).toBe('bad_request');
    });
  });

  describe('PayUAdapter', () => {
    it('submits transaction with txnid idempotency reference and verifies via getStatus', async () => {
      let receivedBody: any;

      mockHandler = (req, res) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => {
          if (req.url === '/payment') {
            receivedBody = JSON.parse(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                status: 'success',
                txnid: receivedBody.txnid,
                mihpayid: 'payu_ref_999',
              })
            );
          } else if (req.url === '/verify_payment') {
            const parsed = JSON.parse(data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                status: 1,
                transaction_details: {
                  [parsed.var1]: {
                    mihpayid: 'payu_ref_999',
                    status: 'success',
                  },
                },
              })
            );
          }
        });
      };

      const adapter = new PayUAdapter({ baseUrl: serverUrl, merchantKey: 'key_123' });
      const submitRes = await adapter.submit(
        {
          paymentId: 'pay_payu_1',
          amountMinor: 10000n,
          currency: 'INR',
          paymentMethod: 'card',
        },
        'tx_payu_123'
      );

      expect(submitRes.providerRef).toBe('payu_ref_999');
      expect(submitRes.status).toBe('succeeded');
      expect(receivedBody.txnid).toBe('tx_payu_123');

      const statusRes = await adapter.getStatus('tx_payu_123');
      expect(statusRes.status).toBe('succeeded');
      expect(statusRes.providerRef).toBe('payu_ref_999');
    });

    it('classifies connection failures as not_sent', () => {
      const adapter = new PayUAdapter();
      const connRefused = new Error('Connection refused');
      (connRefused as any).code = 'ECONNREFUSED';
      expect(adapter.classify(connRefused)).toBe('not_sent');
    });
  });
});
