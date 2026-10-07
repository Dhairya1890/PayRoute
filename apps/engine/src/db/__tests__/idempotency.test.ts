import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../pool.js';
import {
  PaymentRepository,
  IdempotencyConflictError,
} from '../payment-repository.js';
import { parseMoney } from '@payroute/shared';

describe('Payment Idempotency - Correctness Invariants', () => {
  let businessId: string;
  let repo: PaymentRepository;

  beforeAll(async () => {
    // Insert test business
    const res = await pool.query(
      `INSERT INTO businesses (name, status) VALUES ('Test Merchant Idempotency', 'active') RETURNING id`
    );
    businessId = res.rows[0].id;
    repo = new PaymentRepository(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM payments WHERE business_id = $1', [businessId]);
    await pool.query('DELETE FROM businesses WHERE id = $1', [businessId]);
  });

  it('creates a new payment on initial request and returns isReplay: false', async () => {
    const key = `idem_${Date.now()}_1`;
    const money = parseMoney(2500n, 'INR');

    const result = await repo.createOrGetPayment({
      businessId,
      idempotencyKey: key,
      money,
      customerReference: 'cust_abc_1',
      deadlineMs: 30000,
    });

    expect(result.isReplay).toBe(false);
    expect(result.payment.id).toBeDefined();
    expect(result.payment.amountMinor).toBe(2500n);
    expect(result.payment.currency).toBe('INR');
    expect(result.payment.status).toBe('created');
  });

  it('returns original payment on exact replay (same key, same payload) with isReplay: true', async () => {
    const key = `idem_${Date.now()}_replay`;
    const money = parseMoney(10000n, 'INR');

    // First call
    const first = await repo.createOrGetPayment({
      businessId,
      idempotencyKey: key,
      money,
      customerReference: 'cust_replay',
      deadlineMs: 30000,
    });
    expect(first.isReplay).toBe(false);

    // Second call with same body
    const second = await repo.createOrGetPayment({
      businessId,
      idempotencyKey: key,
      money,
      customerReference: 'cust_replay',
      deadlineMs: 30000,
    });
    expect(second.isReplay).toBe(true);
    expect(second.payment.id).toBe(first.payment.id);
    expect(second.payment.amountMinor).toBe(first.payment.amountMinor);
    expect(second.payment.requestHash).toBe(first.payment.requestHash);
  });

  it('rejects key reuse with a different body with HTTP 422 IdempotencyConflictError', async () => {
    const key = `idem_${Date.now()}_conflict`;

    // First request: 5000 INR
    await repo.createOrGetPayment({
      businessId,
      idempotencyKey: key,
      money: parseMoney(5000n, 'INR'),
      customerReference: 'cust_original',
      deadlineMs: 30000,
    });

    // Second request: Same key, different amount (9000 INR)
    await expect(
      repo.createOrGetPayment({
        businessId,
        idempotencyKey: key,
        money: parseMoney(9000n, 'INR'),
        customerReference: 'cust_original',
        deadlineMs: 30000,
      })
    ).rejects.toThrow(IdempotencyConflictError);

    // Third request: Same key, different customerReference
    await expect(
      repo.createOrGetPayment({
        businessId,
        idempotencyKey: key,
        money: parseMoney(5000n, 'INR'),
        customerReference: 'cust_different',
        deadlineMs: 30000,
      })
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('CONCURRENCY INVARIANT: 50 parallel requests with same key produce exactly 1 payment record', async () => {
    const key = `idem_stress_${Date.now()}`;
    const money = parseMoney(15000n, 'INR');
    const customerReference = 'cust_parallel_50';

    // Launch 50 simultaneous parallel requests
    const promises = Array.from({ length: 50 }).map(() =>
      repo.createOrGetPayment({
        businessId,
        idempotencyKey: key,
        money,
        customerReference,
        deadlineMs: 30000,
      })
    );

    const results = await Promise.all(promises);

    // Verify all 50 resolved to the exact same payment ID
    const firstPaymentId = results[0]?.payment.id;
    expect(firstPaymentId).toBeDefined();

    for (const res of results) {
      expect(res.payment.id).toBe(firstPaymentId);
    }

    // Verify exactly one was marked as the creator (isReplay: false), and 49 were replays (isReplay: true)
    const creators = results.filter((r) => !r.isReplay);
    const replays = results.filter((r) => r.isReplay);
    expect(creators.length).toBe(1);
    expect(replays.length).toBe(49);

    // Query database directly to assert COUNT = 1
    const dbCount = await pool.query(
      `SELECT COUNT(*) FROM payments WHERE business_id = $1 AND idempotency_key = $2`,
      [businessId, key]
    );
    expect(Number(dbCount.rows[0].count)).toBe(1);
  });
});
