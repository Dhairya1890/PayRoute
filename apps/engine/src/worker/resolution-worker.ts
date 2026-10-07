import pg from 'pg';
import { ProviderAdapter } from '@payroute/providers';
import { PaymentRepository } from '../db/payment-repository.js';
import { PaymentOrchestrator } from '../orchestration/orchestrator.js';

export interface ResolutionWorkerOptions {
  pool: pg.Pool;
  paymentRepo: PaymentRepository;
  adapters: Map<string, ProviderAdapter>;
  orchestrator: PaymentOrchestrator;
  batchSize?: number;
}

/**
 * ResolutionWorker resolves unknown outcomes and overdue retries in the background.
 * 
 * Guarantees Enforced:
 * 1. Safe concurrent workers: Uses `FOR UPDATE SKIP LOCKED` so multiple instances never double-process.
 * 2. Non-Negotiable Rule 7: An unresolved payment past resolution deadline is NEVER marked failed
 *    (customer may have been charged). Attempts cancel if supported; otherwise flags `needs_review = true`
 *    and halts retries.
 * 3. Zero Double-Charge: Only fails over when provider status authoritatively confirms payment was not charged.
 */
export class ResolutionWorker {
  private readonly pool: pg.Pool;
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly orchestrator: PaymentOrchestrator;
  private readonly batchSize: number;

  constructor(options: ResolutionWorkerOptions) {
    this.pool = options.pool;
    this.adapters = options.adapters;
    this.orchestrator = options.orchestrator;
    this.batchSize = options.batchSize ?? 50;
  }

  async processDuePayments(): Promise<number> {
    const client = await this.pool.connect();
    let processedCount = 0;

    try {
      // 1. Fetch due payments with row-level lock skipping locked rows
      const sql = `
        SELECT * FROM payments
        WHERE status IN ('processing', 'unknown')
          AND next_action_time IS NOT NULL
          AND next_action_time <= NOW()
        ORDER BY next_action_time ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED;
      `;

      await client.query('BEGIN');
      const { rows } = await client.query(sql, [this.batchSize]);

      for (const row of rows) {
        await this.resolveSinglePayment(client, row);
        processedCount++;
      }

      await client.query('COMMIT');
      return processedCount;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async resolveSinglePayment(client: pg.PoolClient, paymentRow: Record<string, unknown>): Promise<void> {
    const paymentId = paymentRow.id as string;
    const resolutionDeadlineAt = paymentRow.resolution_deadline_at
      ? new Date(paymentRow.resolution_deadline_at as string)
      : null;
    const now = new Date();

    // Fetch the latest attempt
    const attemptsRes = await client.query(
      `SELECT * FROM payment_attempts WHERE payment_id = $1 ORDER BY attempt_no DESC LIMIT 1`,
      [paymentId]
    );

    if (attemptsRes.rows.length === 0) {
      // Anomaly: no attempts recorded
      await client.query(
        `UPDATE payments SET next_action_time = NULL, needs_review = true WHERE id = $1`,
        [paymentId]
      );
      return;
    }

    const lastAttempt = attemptsRes.rows[0];
    const adapter = this.adapters.get(lastAttempt.provider);
    const idempotencyRef = `${paymentId}_${lastAttempt.attempt_no}`;

    // -------------------------------------------------------------
    // Case 1: Resolution deadline expired
    // -------------------------------------------------------------
    if (resolutionDeadlineAt && resolutionDeadlineAt <= now) {
      if (adapter && adapter.capabilities.supportsCancel) {
        try {
          const cancelRes = await adapter.cancel(idempotencyRef, lastAttempt.provider_ref);
          if (cancelRes.success) {
            // Cancel confirmed on provider backend: safe to mark failed
            await client.query(
              `UPDATE payment_attempts
               SET status = 'failed', error_class = 'ambiguous', finished_at = NOW()
               WHERE id = $1 AND status IN ('started', 'unknown')`,
              [lastAttempt.id]
            );
            await client.query(
              `UPDATE payments
               SET status = 'failed', failure_reason = 'Resolution deadline expired: voided/canceled on provider', next_action_time = NULL
               WHERE id = $1`,
              [paymentId]
            );
            return;
          }
        } catch {
          // Cancel failed or timed out
        }
      }

      // Non-negotiable Rule 7: Cannot confirm cancel -> LEAVE UNKNOWN, flag needs_review, STOP retrying!
      await client.query(
        `UPDATE payments
         SET needs_review = true, next_action_time = NULL
         WHERE id = $1`,
        [paymentId]
      );
      return;
    }

    // -------------------------------------------------------------
    // Case 2: Within resolution deadline: Query provider authoritative status
    // -------------------------------------------------------------
    if (!adapter) {
      await client.query(
        `UPDATE payments SET next_action_time = NULL, needs_review = true WHERE id = $1`,
        [paymentId]
      );
      return;
    }

    let statusResult: any = null;
    try {
      statusResult = await adapter.getStatus(idempotencyRef, lastAttempt.provider_ref);
    } catch {
      statusResult = null; // Status query failed or gateway unavailable
    }

    if (statusResult && statusResult.status === 'succeeded') {
      // 2A: Confirmed charged!
      await client.query(
        `UPDATE payment_attempts
         SET status = 'succeeded', provider_ref = COALESCE($1, provider_ref), finished_at = NOW()
         WHERE id = $2 AND status IN ('started', 'unknown')`,
        [statusResult.providerRef, lastAttempt.id]
      );

      await client.query(
        `UPDATE payments
         SET status = 'succeeded', final_provider = $1, next_action_time = NULL
         WHERE id = $2`,
        [lastAttempt.provider, paymentId]
      );
    } else if (statusResult && (statusResult.status === 'not_found' || statusResult.status === 'failed')) {
      // 2B: Confirmed NOT charged! Safe to record attempt as failed and fail over
      await client.query(
        `UPDATE payment_attempts
         SET status = 'failed', error_class = 'ambiguous', finished_at = NOW()
         WHERE id = $1 AND status IN ('started', 'unknown')`,
        [lastAttempt.id]
      );

      // Check total attempts for this payment
      const countRes = await client.query(
        `SELECT COUNT(*) FROM payment_attempts WHERE payment_id = $1`,
        [paymentId]
      );
      const attemptCount = parseInt(countRes.rows[0].count, 10);

      if (attemptCount >= 3) {
        // Exceeded attempt budget: mark failed
        await client.query(
          `UPDATE payments SET status = 'failed', failure_reason = 'Max attempts exceeded after uncharged status check', next_action_time = NULL WHERE id = $1`,
          [paymentId]
        );
      } else {
        // Transition to processing so orchestrator can continue routing attempts
        await client.query(
          `UPDATE payments SET status = 'processing', next_action_time = NULL WHERE id = $1`,
          [paymentId]
        );

        // Resume orchestration asynchronously so next eligible provider is tried
        if (this.orchestrator) {
          setImmediate(() => {
            this.orchestrator.execute({
              businessId: paymentRow.business_id as string,
              idempotencyKey: paymentRow.idempotency_key as string,
              amountMinor: BigInt(paymentRow.amount_minor as string | number),
              currency: paymentRow.currency as string,
              paymentMethod: paymentRow.payment_method as string,
              customerReference: paymentRow.customer_reference as string,
              batchId: paymentRow.batch_id as string,
            }).catch((err) => {
              console.error(`ResolutionWorker failed to resume orchestration for payment ${paymentId}:`, err);
            });
          });
        }
      }
    } else {
      // 2C: Status query inconclusive: schedule next check with exponential backoff
      const nextCheck = new Date(Date.now() + 15000); // 15s delay
      await client.query(
        `UPDATE payments SET next_action_time = $1 WHERE id = $2`,
        [nextCheck.toISOString(), paymentId]
      );
    }
  }
}
