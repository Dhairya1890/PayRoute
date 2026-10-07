import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../pool.js';

describe('Database Schema Invariants & Triggers', () => {
  let businessId: string;

  beforeAll(async () => {
    // Insert a test business
    const res = await pool.query(
      `INSERT INTO businesses (name, status) VALUES ('Test Merchant Invariants', 'active') RETURNING id`
    );
    businessId = res.rows[0].id;
  });

  afterAll(async () => {
    // Teardown: temporarily set session_replication_role to replica to clean up rows protected by append-only triggers
    await pool.query("SET session_replication_role = 'replica'");
    await pool.query("DELETE FROM audit_log WHERE actor = 'test_actor'");
    await pool.query('DELETE FROM payment_attempts WHERE payment_id IN (SELECT id FROM payments WHERE business_id = $1)', [businessId]);
    await pool.query('DELETE FROM payments WHERE business_id = $1', [businessId]);
    await pool.query('DELETE FROM businesses WHERE id = $1', [businessId]);
    await pool.query("SET session_replication_role = 'origin'");
  });

  describe('Audit Log Immutability Triggers', () => {
    it('allows INSERT into audit_log, but BLOCKS UPDATE and DELETE via trigger', async () => {
      const insertRes = await pool.query(
        `INSERT INTO audit_log (actor, action, entity, entity_id, payload)
         VALUES ('test_actor', 'test_action', 'payment', 'p_1', '{"key": "val"}'::jsonb)
         RETURNING id`
      );
      const auditId = insertRes.rows[0].id;

      // UPDATE must fail with explicit trigger error
      await expect(
        pool.query(`UPDATE audit_log SET action = 'tampered' WHERE id = $1`, [auditId])
      ).rejects.toThrow(/audit_log is append-only: UPDATE, DELETE, and TRUNCATE are prohibited/);

      // DELETE must fail with explicit trigger error
      await expect(
        pool.query(`DELETE FROM audit_log WHERE id = $1`, [auditId])
      ).rejects.toThrow(/audit_log is append-only: UPDATE, DELETE, and TRUNCATE are prohibited/);
    });
  });

  describe('Payment Attempts Immutability & One-Succeeded Constraint', () => {
    it('BLOCKS DELETE on payment_attempts', async () => {
      // Create payment
      const pRes = await pool.query(
        `INSERT INTO payments (
          business_id, idempotency_key, request_hash, amount_minor, currency,
          deadline_at, status
        ) VALUES ($1, 'idem_del_test', 'hash123', 5000, 'INR', NOW() + INTERVAL '10 minutes', 'processing')
        RETURNING id`,
        [businessId]
      );
      const paymentId = pRes.rows[0].id;

      // Insert attempt
      const attRes = await pool.query(
        `INSERT INTO payment_attempts (
          payment_id, attempt_no, provider, routing_reason, status
        ) VALUES ($1, 1, 'razorpay', 'priority', 'started')
        RETURNING id`,
        [paymentId]
      );
      const attemptId = attRes.rows[0].id;

      // Attempting DELETE must fail
      await expect(
        pool.query('DELETE FROM payment_attempts WHERE id = $1', [attemptId])
      ).rejects.toThrow(/payment_attempts is append-only: DELETE is prohibited/);
    });

    it('BLOCKS UPDATE on terminal attempt states (succeeded/failed)', async () => {
      const pRes = await pool.query(
        `INSERT INTO payments (
          business_id, idempotency_key, request_hash, amount_minor, currency,
          deadline_at, status
        ) VALUES ($1, 'idem_terminal_att_test', 'hash_term', 5000, 'INR', NOW() + INTERVAL '10 minutes', 'processing')
        RETURNING id`,
        [businessId]
      );
      const paymentId = pRes.rows[0].id;

      const attRes = await pool.query(
        `INSERT INTO payment_attempts (
          payment_id, attempt_no, provider, routing_reason, status
        ) VALUES ($1, 1, 'stripe', 'priority', 'started')
        RETURNING id`,
        [paymentId]
      );
      const attemptId = attRes.rows[0].id;

      // Move started -> succeeded (legal outcome transition)
      await pool.query(
        `UPDATE payment_attempts SET status = 'succeeded', finished_at = NOW() WHERE id = $1`,
        [attemptId]
      );

      // Mutating a terminal attempt must be rejected by trigger!
      await expect(
        pool.query(`UPDATE payment_attempts SET status = 'failed' WHERE id = $1`, [attemptId])
      ).rejects.toThrow(/Terminal attempt \(status=succeeded\) cannot be updated/);
    });

    it('ENFORCES at most one succeeded attempt per payment via partial unique index', async () => {
      const pRes = await pool.query(
        `INSERT INTO payments (
          business_id, idempotency_key, request_hash, amount_minor, currency,
          deadline_at, status
        ) VALUES ($1, 'idem_one_success_test', 'hash_succ', 7500, 'INR', NOW() + INTERVAL '10 minutes', 'processing')
        RETURNING id`,
        [businessId]
      );
      const paymentId = pRes.rows[0].id;

      // Attempt 1 succeeds
      await pool.query(
        `INSERT INTO payment_attempts (
          payment_id, attempt_no, provider, routing_reason, status
        ) VALUES ($1, 1, 'razorpay', 'priority', 'succeeded')`,
        [paymentId]
      );

      // Attempt 2 trying to also be marked succeeded must fail with unique violation!
      await expect(
        pool.query(
          `INSERT INTO payment_attempts (
            payment_id, attempt_no, provider, routing_reason, status
          ) VALUES ($1, 2, 'stripe', 'failover', 'succeeded')`,
          [paymentId]
        )
      ).rejects.toThrow(/uq_one_success_per_payment/);
    });
  });

  describe('CHECK Constraints on Currency and Amounts', () => {
    it('REJECTS non-positive amounts (CHECK amount_minor > 0)', async () => {
      await expect(
        pool.query(
          `INSERT INTO payments (
            business_id, idempotency_key, request_hash, amount_minor, currency, deadline_at
          ) VALUES ($1, 'idem_neg', 'h', 0, 'INR', NOW() + INTERVAL '10 minutes')`,
          [businessId]
        )
      ).rejects.toThrow(/check constraint/i);
    });

    it('REJECTS invalid currency codes (CHECK currency ~ ^[A-Z]{3}$)', async () => {
      await expect(
        pool.query(
          `INSERT INTO payments (
            business_id, idempotency_key, request_hash, amount_minor, currency, deadline_at
          ) VALUES ($1, 'idem_bad_curr', 'h', 100, 'inr', NOW() + INTERVAL '10 minutes')`,
          [businessId]
        )
      ).rejects.toThrow(/check constraint/i);
    });
  });
});
