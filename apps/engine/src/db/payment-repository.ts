import pg from 'pg';
import {
  Money,
  PaymentStatus,
  hashPayload,
  transitionPayment,
} from '@payroute/shared';
import { OutcomeClass } from '@payroute/core';

/**
 * Thrown when an Idempotency-Key is reused with a different request payload.
 * Mapped to HTTP 422 Unprocessable Entity at the API boundary.
 */
export class IdempotencyConflictError extends Error {
  readonly statusCode = 422;
  constructor(message = 'Idempotency key already used with a different request payload') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export interface PaymentRecord {
  id: string;
  businessId: string;
  idempotencyKey: string;
  requestHash: string;
  amountMinor: bigint;
  currency: string;
  paymentMethod: string;
  status: PaymentStatus;
  customerReference: string | null;
  batchId: string | null;
  finalProvider: string | null;
  failureReason: string | null;
  deadlineAt: Date;
  resolutionDeadlineAt: Date | null;
  nextActionTime: Date | null;
  needsReview: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AttemptRecord {
  id: string;
  paymentId: string;
  attemptNo: number;
  provider: string;
  providerRef: string | null;
  providerErrorCode: string | null;
  status: 'started' | 'succeeded' | 'failed' | 'unknown';
  errorClass: OutcomeClass | null;
  latencyMs: number | null;
  routingReason: string;
  decisionTrace: Record<string, unknown>;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface CreatePaymentParams {
  businessId: string;
  idempotencyKey: string;
  money: Money;
  customerReference?: string;
  batchId?: string;
  paymentMethod?: string;
  deadlineMs?: number;
  metadata?: Record<string, unknown>;
}

export interface CreatePaymentResult {
  payment: PaymentRecord;
  isReplay: boolean;
}

export interface CreateAttemptParams {
  paymentId: string;
  attemptNo: number;
  provider: string;
  routingReason: string;
  decisionTrace: Record<string, unknown>;
}

export interface UpdateAttemptOutcomeParams {
  attemptId: string;
  status: 'succeeded' | 'failed' | 'unknown';
  errorClass?: OutcomeClass;
  providerRef?: string;
  providerErrorCode?: string;
  latencyMs?: number;
}

export interface PaymentFilters {
  status?: PaymentStatus;
  provider?: string;
  batchId?: string;
  limit?: number;
}

/**
 * PaymentRepository encapsulates all PostgreSQL database interactions for payments
 * and guarantees correctness invariants (idempotency, append-only attempts, state transitions).
 */
export class PaymentRepository {
  constructor(private readonly db: pg.Pool | pg.PoolClient) {}

  /**
   * Enforces Postgres-backed idempotency using UNIQUE (business_id, idempotency_key).
   */
  async createOrGetPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    const {
      businessId,
      idempotencyKey,
      money,
      customerReference = '',
      batchId = null,
      paymentMethod = 'card',
      deadlineMs = 8000,
      metadata = {},
    } = params;

    const payloadToHash = {
      amountMinor: money.amountMinor.toString(),
      currency: money.currency,
      customerReference,
      paymentMethod,
      metadata,
    };
    const requestHash = hashPayload(payloadToHash);
    const deadlineAt = new Date(Date.now() + deadlineMs);

    const insertQuery = `
      INSERT INTO payments (
        business_id,
        idempotency_key,
        request_hash,
        amount_minor,
        currency,
        payment_method,
        customer_reference,
        batch_id,
        deadline_at,
        metadata,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'created')
      ON CONFLICT (business_id, idempotency_key) DO NOTHING
      RETURNING *;
    `;

    const insertResult = await this.db.query(insertQuery, [
      businessId,
      idempotencyKey,
      requestHash,
      money.amountMinor.toString(),
      money.currency,
      paymentMethod,
      customerReference,
      batchId,
      deadlineAt.toISOString(),
      JSON.stringify(metadata),
    ]);

    if (insertResult.rows.length > 0) {
      return {
        payment: this.mapPaymentRow(insertResult.rows[0]),
        isReplay: false,
      };
    }

    const selectQuery = `
      SELECT * FROM payments
      WHERE business_id = $1 AND idempotency_key = $2;
    `;
    const selectResult = await this.db.query(selectQuery, [businessId, idempotencyKey]);

    if (selectResult.rows.length === 0) {
      throw new Error('Concurrent payment state anomaly during idempotency lookup');
    }

    const existingRow = selectResult.rows[0];

    if (existingRow.request_hash !== requestHash) {
      throw new IdempotencyConflictError(
        `Idempotency-Key "${idempotencyKey}" already used with different request parameters.`
      );
    }

    return {
      payment: this.mapPaymentRow(existingRow),
      isReplay: true,
    };
  }

  /**
   * Executes a conditional state transition:
   * UPDATE payments SET status = $new WHERE id = $id AND status = $expectedOld
   */
  async transitionStatus(
    paymentId: string,
    currentStatus: PaymentStatus,
    nextStatus: PaymentStatus,
    extraFields?: {
      finalProvider?: string;
      failureReason?: string;
      nextActionTime?: Date | null;
      needsReview?: boolean;
    }
  ): Promise<PaymentRecord> {
    transitionPayment(currentStatus, nextStatus);

    const updates: string[] = ['status = $1'];
    const values: unknown[] = [nextStatus, paymentId, currentStatus];
    let idx = 4;

    if (extraFields?.finalProvider !== undefined) {
      updates.push(`final_provider = $${idx++}`);
      values.push(extraFields.finalProvider);
    }
    if (extraFields?.failureReason !== undefined) {
      updates.push(`failure_reason = $${idx++}`);
      values.push(extraFields.failureReason);
    }
    if (extraFields?.nextActionTime !== undefined) {
      updates.push(`next_action_time = $${idx++}`);
      values.push(extraFields.nextActionTime ? extraFields.nextActionTime.toISOString() : null);
    }
    if (extraFields?.needsReview !== undefined) {
      updates.push(`needs_review = $${idx++}`);
      values.push(extraFields.needsReview);
    }

    const sql = `
      UPDATE payments
      SET ${updates.join(', ')}
      WHERE id = $2 AND status = $3
      RETURNING *;
    `;

    const res = await this.db.query(sql, values);
    if (res.rows.length === 0) {
      throw new Error(
        `Payment state transition failed for payment "${paymentId}": expected status "${currentStatus}", but it has already changed.`
      );
    }

    return this.mapPaymentRow(res.rows[0]);
  }

  /**
   * Appends an attempt record with status='started' and decision_trace JSONB.
   */
  async createAttempt(params: CreateAttemptParams): Promise<AttemptRecord> {
    const sql = `
      INSERT INTO payment_attempts (
        payment_id,
        attempt_no,
        provider,
        routing_reason,
        decision_trace,
        status
      ) VALUES ($1, $2, $3, $4, $5, 'started')
      RETURNING *;
    `;

    const res = await this.db.query(sql, [
      params.paymentId,
      params.attemptNo,
      params.provider,
      params.routingReason,
      JSON.stringify(params.decisionTrace),
    ]);

    return this.mapAttemptRow(res.rows[0]);
  }

  /**
   * Updates an attempt from 'started' to a terminal/interim outcome.
   * Strictly protected by database immutability trigger.
   */
  async updateAttemptOutcome(params: UpdateAttemptOutcomeParams): Promise<AttemptRecord> {
    const updates: string[] = ['status = $1', 'finished_at = NOW()'];
    const values: unknown[] = [params.status, params.attemptId];
    let idx = 3;

    if (params.errorClass !== undefined) {
      updates.push(`error_class = $${idx++}`);
      values.push(params.errorClass);
    }
    if (params.providerRef !== undefined) {
      updates.push(`provider_ref = $${idx++}`);
      values.push(params.providerRef);
    }
    if (params.providerErrorCode !== undefined) {
      updates.push(`provider_error_code = $${idx++}`);
      values.push(params.providerErrorCode);
    }
    if (params.latencyMs !== undefined) {
      updates.push(`latency_ms = $${idx++}`);
      values.push(params.latencyMs);
    }

    const sql = `
      UPDATE payment_attempts
      SET ${updates.join(', ')}
      WHERE id = $2 AND status IN ('started', 'unknown')
      RETURNING *;
    `;

    const res = await this.db.query(sql, values);
    if (res.rows.length === 0) {
      throw new Error(`Attempt update failed for attempt ID "${params.attemptId}"`);
    }

    return this.mapAttemptRow(res.rows[0]);
  }

  async getPaymentById(paymentId: string): Promise<PaymentRecord | null> {
    const res = await this.db.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
    return res.rows.length > 0 ? this.mapPaymentRow(res.rows[0]) : null;
  }

  async getAttemptsForPayment(paymentId: string): Promise<AttemptRecord[]> {
    const res = await this.db.query(
      'SELECT * FROM payment_attempts WHERE payment_id = $1 ORDER BY attempt_no ASC',
      [paymentId]
    );
    return res.rows.map((r) => this.mapAttemptRow(r));
  }

  async getPaymentWithAttempts(
    paymentId: string
  ): Promise<{ payment: PaymentRecord; attempts: AttemptRecord[] } | null> {
    const payment = await this.getPaymentById(paymentId);
    if (!payment) return null;
    const attempts = await this.getAttemptsForPayment(paymentId);
    return { payment, attempts };
  }

  async getPayments(filters: PaymentFilters = {}): Promise<PaymentRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (filters.status) {
      clauses.push(`status = $${idx++}`);
      values.push(filters.status);
    }
    if (filters.provider) {
      clauses.push(`final_provider = $${idx++}`);
      values.push(filters.provider);
    }
    if (filters.batchId) {
      clauses.push(`batch_id = $${idx++}`);
      values.push(filters.batchId);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filters.limit ? `LIMIT ${filters.limit}` : 'LIMIT 50';

    const sql = `SELECT * FROM payments ${where} ORDER BY created_at DESC ${limit}`;
    const res = await this.db.query(sql, values);
    return res.rows.map((r) => this.mapPaymentRow(r));
  }

  async getEngineSetting<T>(key: string, defaultValue: T): Promise<T> {
    const res = await this.db.query('SELECT value FROM engine_settings WHERE key = $1', [key]);
    if (res.rows.length === 0) return defaultValue;
    return res.rows[0].value as T;
  }

  async setEngineSetting(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO engine_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  }

  private mapPaymentRow(row: Record<string, unknown>): PaymentRecord {
    return {
      id: row.id as string,
      businessId: row.business_id as string,
      idempotencyKey: row.idempotency_key as string,
      requestHash: row.request_hash as string,
      amountMinor: BigInt(row.amount_minor as string | number),
      currency: row.currency as string,
      paymentMethod: row.payment_method as string,
      status: row.status as PaymentStatus,
      customerReference: (row.customer_reference as string) ?? null,
      batchId: (row.batch_id as string) ?? null,
      finalProvider: (row.final_provider as string) ?? null,
      failureReason: (row.failure_reason as string) ?? null,
      deadlineAt: new Date(row.deadline_at as string),
      resolutionDeadlineAt: row.resolution_deadline_at
        ? new Date(row.resolution_deadline_at as string)
        : null,
      nextActionTime: row.next_action_time ? new Date(row.next_action_time as string) : null,
      needsReview: Boolean(row.needs_review),
      metadata: (row.metadata as Record<string, unknown>) ?? null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  private mapAttemptRow(row: Record<string, unknown>): AttemptRecord {
    return {
      id: row.id as string,
      paymentId: row.payment_id as string,
      attemptNo: Number(row.attempt_no),
      provider: row.provider as string,
      providerRef: (row.provider_ref as string) ?? null,
      providerErrorCode: (row.provider_error_code as string) ?? null,
      status: row.status as AttemptRecord['status'],
      errorClass: (row.error_class as OutcomeClass) ?? null,
      latencyMs: row.latency_ms !== null ? Number(row.latency_ms) : null,
      routingReason: row.routing_reason as string,
      decisionTrace: (row.decision_trace as Record<string, unknown>) ?? {},
      startedAt: new Date(row.started_at as string),
      finishedAt: row.finished_at ? new Date(row.finished_at as string) : null,
    };
  }
}
