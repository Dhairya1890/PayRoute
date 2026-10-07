import {
  selectProvider,
  ProviderCandidate,
  RoutingContext,
  StrategyType,
  PolicyType,
  calculateBackoffWithFullJitter,
} from '@payroute/core';
import { parseMoney } from '@payroute/shared';
import { ProviderAdapter } from '@payroute/providers';
import { PaymentRepository, PaymentRecord, AttemptRecord } from '../db/payment-repository.js';
import { CircuitBreakerManager } from '../resilience/circuit-breaker-manager.js';
import { HealthTracker } from '../resilience/health-tracker.js';
import { ProviderConfigCache } from './provider-config-cache.js';

export interface PaymentOrchestratorOptions {
  paymentRepo: PaymentRepository;
  breakerManager: CircuitBreakerManager;
  healthTracker: HealthTracker;
  configCache?: ProviderConfigCache;
  adapters: Map<string, ProviderAdapter>;
  strategy?: StrategyType;
  policy?: PolicyType;
  explorationShare?: number;
  syncDeadlineMs?: number;
  maxAttemptsPerPayment?: number;
  maxAttemptsPerProvider?: number;
  randomSource?: () => number;
}

export interface ExecutePaymentParams {
  businessId: string;
  idempotencyKey: string;
  amountMinor: bigint;
  currency: string;
  paymentMethod?: string;
  customerReference?: string;
  batchId?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutePaymentResult {
  payment: PaymentRecord;
  attempts: AttemptRecord[];
  isReplay: boolean;
}

/**
 * PaymentOrchestrator coordinates the end-to-end execution of a payment request.
 * 
 * Non-Negotiable Invariants Enforced:
 * 1. Postgres-enforced idempotency (no duplicate payments).
 * 2. Never double-charge: on ambiguous outcome, queries provider status first. Never fails over from unknown state.
 * 3. Short DB transactions: commits 'processing' and attempt BEFORE making provider HTTP calls.
 * 4. Append-only attempt history with decision trace recording why every provider was selected.
 * 5. Declines never trip breaker; only infrastructure and provider faults affect breaker.
 */
export class PaymentOrchestrator {
  private readonly paymentRepo: PaymentRepository;
  private readonly breakerManager: CircuitBreakerManager;
  private readonly healthTracker: HealthTracker;
  private readonly configCache?: ProviderConfigCache;
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly defaultStrategy: StrategyType;
  private readonly defaultPolicy: PolicyType;
  private readonly explorationShare: number;
  private readonly syncDeadlineMs: number;
  private readonly maxAttemptsPerPayment: number;
  private readonly maxAttemptsPerProvider: number;
  private readonly randomSource: () => number;

  constructor(options: PaymentOrchestratorOptions) {
    this.paymentRepo = options.paymentRepo;
    this.breakerManager = options.breakerManager;
    this.healthTracker = options.healthTracker;
    this.configCache = options.configCache;
    this.adapters = options.adapters;
    this.defaultStrategy = options.strategy ?? 'weighted';
    this.defaultPolicy = options.policy ?? 'full';
    this.explorationShare = options.explorationShare ?? 0.05;
    this.syncDeadlineMs = options.syncDeadlineMs ?? 8000;
    this.maxAttemptsPerPayment = options.maxAttemptsPerPayment ?? 3;
    this.maxAttemptsPerProvider = options.maxAttemptsPerProvider ?? 2;
    this.randomSource = options.randomSource ?? Math.random;
  }

  async execute(params: ExecutePaymentParams): Promise<ExecutePaymentResult> {
    const paymentMethod = params.paymentMethod || 'card';
    const money = parseMoney(params.amountMinor, params.currency);

    // 1. Enforce idempotency via PostgreSQL
    const { payment: initialPayment, isReplay } = await this.paymentRepo.createOrGetPayment({
      businessId: params.businessId,
      idempotencyKey: params.idempotencyKey,
      money,
      customerReference: params.customerReference,
      batchId: params.batchId,
      paymentMethod,
      deadlineMs: this.syncDeadlineMs,
      metadata: params.metadata,
    });

    let currentPayment = initialPayment;

    // If exact replay and payment is terminal or processing, return current record
    if (isReplay && (currentPayment.status === 'succeeded' || currentPayment.status === 'failed')) {
      const attempts = await this.paymentRepo.getAttemptsForPayment(currentPayment.id);
      return { payment: currentPayment, attempts, isReplay: true };
    }

    const attempts: AttemptRecord[] = await this.paymentRepo.getAttemptsForPayment(currentPayment.id);
    const deadlineAt = currentPayment.deadlineAt.getTime();
    let softDeclineCascades = 0;

    // Track per-provider attempt counts
    const attemptsCountByProvider: Record<string, number> = {};
    const hardDeclinedProviders = new Set<string>();

    for (const a of attempts) {
      attemptsCountByProvider[a.provider] = (attemptsCountByProvider[a.provider] || 0) + 1;
      if (a.errorClass === 'hard_decline') {
        hardDeclinedProviders.add(a.provider);
      }
      if (a.errorClass === 'soft_decline') {
        softDeclineCascades++;
      }
    }

    try {
      // Move to processing immediately as orchestration begins
      if (currentPayment.status === 'created') {
        currentPayment = await this.paymentRepo.transitionStatus(
          currentPayment.id,
          'created',
          'processing'
        );
      }

      // 2. Orchestration Loop
      while (currentPayment.status === 'processing') {
      const attemptNo = attempts.length + 1;

      // Check max attempts
      if (attemptNo > this.maxAttemptsPerPayment) {
        currentPayment = await this.paymentRepo.transitionStatus(
          currentPayment.id,
          currentPayment.status,
          'failed',
          { failureReason: 'Max attempts per payment exceeded' }
        );
        break;
      }

      // Check synchronous deadline
      if (Date.now() >= deadlineAt) {
        if (currentPayment.status === 'processing') {
          currentPayment = await this.paymentRepo.transitionStatus(
            currentPayment.id,
            'processing',
            'unknown',
            {
              nextActionTime: new Date(Date.now() + 15000),
              needsReview: false,
            }
          );
        }
        break;
      }

      // Build candidate list from dynamic config cache & health snapshot
      const candidateList: ProviderCandidate[] = [];

      const dynamicConfigs = this.configCache
        ? await this.configCache.getProviderConfigs()
        : null;
      const dynamicSettings = this.configCache
        ? await this.configCache.getEngineSettings()
        : null;

      const activeStrategy = dynamicSettings?.strategy ?? this.defaultStrategy;
      const activePolicy = dynamicSettings?.policy ?? this.defaultPolicy;
      const activeExplorationShare = dynamicSettings?.explorationShare ?? this.explorationShare;

      for (const [name, adapter] of this.adapters.entries()) {
        const health = this.healthTracker.getSnapshot(name, paymentMethod);
        const dbConfig = dynamicConfigs?.find((c) => c.name === name);

        candidateList.push({
          name,
          enabled: dbConfig ? dbConfig.enabled : true,
          priority: dbConfig ? dbConfig.priority : (name === 'razorpay' ? 1 : name === 'stripe' ? 2 : 3),
          costBps: dbConfig ? dbConfig.costBps : (name === 'razorpay' ? 190 : name === 'stripe' ? 290 : 200),
          timeoutMs: dbConfig ? dbConfig.timeoutMs : 5000,
          supportedMethods: dbConfig?.supportedMethods ?? [...adapter.capabilities.supportedMethods],
          supportedCurrencies: dbConfig?.supportedCurrencies ?? [...adapter.capabilities.supportedCurrencies],
          breakerState: health.breakerState,
          hasProbeSlot: health.breakerState === 'half_open',
          backoffUntil: null,
          stats: {
            ok: health.okCount,
            attempts: health.okCount + health.failCount,
            p95LatencyMs: health.p95LatencyMs,
          },
        });
      }

      const routingContext: RoutingContext = {
        paymentMethod,
        currency: params.currency,
        attemptNumber: attemptNo,
        perProviderAttempts: attemptsCountByProvider,
        maxAttemptsPerProvider: this.maxAttemptsPerProvider,
        hardDeclinedProviders,
        strategy: activeStrategy,
        policy: activePolicy,
        explorationShare: activePolicy === 'baseline' ? 0 : activeExplorationShare,
        now: new Date(),
        random: this.randomSource,
      };

      let selection;
      try {
        selection = selectProvider(candidateList, routingContext);
      } catch {
        currentPayment = await this.paymentRepo.transitionStatus(
          currentPayment.id,
          currentPayment.status,
          'failed',
          { failureReason: 'No eligible payment providers available matching request criteria' }
        );
        break;
      }

      const chosenProviderName = selection.chosenProvider;
      const adapter = this.adapters.get(chosenProviderName);
      if (!adapter) {
        throw new Error(`Adapter for provider "${chosenProviderName}" not registered`);
      }

      // Check if provider is in half-open state and requires probe slot
      const health = this.healthTracker.getSnapshot(chosenProviderName, paymentMethod);
      let isProbe = false;
      if (health.breakerState === 'half_open') {
        const probeRes = await this.breakerManager.acquireProbe(chosenProviderName, paymentMethod);
        isProbe = probeRes.allowed;
        if (!isProbe) {
          // Probe slots full, exclude this provider and loop
          attemptsCountByProvider[chosenProviderName] = 999;
          continue;
        }
      }

      // 3. Short DB Transaction: Commit attempt BEFORE HTTP call

      const routingReason = selection.isExplorationPick
        ? 'Exploration pick for recovery observation'
        : `${activeStrategy} routing strategy pick`;

      const attempt = await this.paymentRepo.createAttempt({
        paymentId: currentPayment.id,
        attemptNo,
        provider: chosenProviderName,
        routingReason,
        decisionTrace: selection.decisionTrace as unknown as Record<string, unknown>,
      });
      attempts.push(attempt);
      attemptsCountByProvider[chosenProviderName] = (attemptsCountByProvider[chosenProviderName] || 0) + 1;

      // 4. Provider Call
      const idempotencyRef = `${currentPayment.id}_${attemptNo}`;
      const startTime = Date.now();
      let responseOrError: unknown;
      let submitRes: any = null;

      try {
        submitRes = await adapter.submit(
          {
            paymentId: currentPayment.id,
            amountMinor: params.amountMinor,
            currency: params.currency,
            paymentMethod,
            customerReference: params.customerReference,
            metadata: params.metadata,
          },
          idempotencyRef
        );
        responseOrError = submitRes.rawResponse || submitRes;
      } catch (err) {
        responseOrError = err;
      }

      const latencyMs = Date.now() - startTime;
      const outcomeClass = adapter.classify(responseOrError);

      // Record in circuit breaker
      if (isProbe) {
        await this.breakerManager.recordProbeResult(chosenProviderName, paymentMethod, outcomeClass === 'success');
      } else {
        await this.breakerManager.recordOutcome({
          provider: chosenProviderName,
          method: paymentMethod,
          outcome: outcomeClass,
          latencyMs,
        });
      }

      // 5. Outcome Handling & Zero-Double-Charge Safety
      if (outcomeClass === 'success') {
        const providerRef = submitRes?.providerRef || `${chosenProviderName}_ref`;
        const updatedAttempt = await this.paymentRepo.updateAttemptOutcome({
          attemptId: attempt.id,
          status: 'succeeded',
          providerRef,
          latencyMs,
        });
        attempts[attempts.length - 1] = updatedAttempt;

        currentPayment = await this.paymentRepo.transitionStatus(
          currentPayment.id,
          'processing',
          'succeeded',
          { finalProvider: chosenProviderName }
        );
        break;
      }

      if (outcomeClass === 'hard_decline') {
        const updatedAttempt = await this.paymentRepo.updateAttemptOutcome({
          attemptId: attempt.id,
          status: 'failed',
          errorClass: 'hard_decline',
          latencyMs,
        });
        attempts[attempts.length - 1] = updatedAttempt;

        currentPayment = await this.paymentRepo.transitionStatus(
          currentPayment.id,
          'processing',
          'failed',
          { failureReason: `Payment declined (hard_decline): ${(responseOrError as Error)?.message || 'Customer card issue'}` }
        );
        // Hard decline terminates the payment immediately. NEVER retried anywhere.
        break;
      }

      if (outcomeClass === 'ambiguous') {
        // AMBIGUOUS: Provider timed out or response was dropped!
        // NON-NEGOTIABLE RULE 3: Do NOT fail over blindly! Query status first!
        let statusResult: any = null;
        try {
          statusResult = await adapter.getStatus(idempotencyRef, submitRes?.providerRef);
        } catch {
          statusResult = null; // Status query also failed
        }

        if (statusResult && statusResult.status === 'succeeded') {
          // Original request actually charged the customer!
          const updatedAttempt = await this.paymentRepo.updateAttemptOutcome({
            attemptId: attempt.id,
            status: 'succeeded',
            providerRef: statusResult.providerRef,
            latencyMs,
          });
          attempts[attempts.length - 1] = updatedAttempt;

          currentPayment = await this.paymentRepo.transitionStatus(
            currentPayment.id,
            'processing',
            'succeeded',
            { finalProvider: chosenProviderName }
          );
          break;
        } else if (statusResult && (statusResult.status === 'not_found' || statusResult.status === 'failed')) {
          // Confirmed NOT charged! Safe to record attempt as failed and fail over.
          const updatedAttempt = await this.paymentRepo.updateAttemptOutcome({
            attemptId: attempt.id,
            status: 'failed',
            errorClass: 'ambiguous',
            latencyMs,
          });
          attempts[attempts.length - 1] = updatedAttempt;

          if (activePolicy === 'baseline') {
            currentPayment = await this.paymentRepo.transitionStatus(
              currentPayment.id,
              'processing',
              'failed',
              { failureReason: 'Baseline policy attempt failed: ambiguous (confirmed not charged)' }
            );
            break;
          }

          // Continue loop to fail over
          continue;
        } else {
          // Status query was inconclusive! Customer MAY have been charged!
          // RULE: Mark unknown and stop retrying. Never fail over from an unknown state.
          const updatedAttempt = await this.paymentRepo.updateAttemptOutcome({
            attemptId: attempt.id,
            status: 'unknown',
            errorClass: 'ambiguous',
            latencyMs,
          });
          attempts[attempts.length - 1] = updatedAttempt;

          currentPayment = await this.paymentRepo.transitionStatus(
            currentPayment.id,
            'processing',
            'unknown',
            {
              nextActionTime: new Date(Date.now() + 15000),
              needsReview: false,
            }
          );
          break;
        }
      }

      // Soft decline, not_sent, transient_known, rate_limited
      const updatedAttempt = await this.paymentRepo.updateAttemptOutcome({
        attemptId: attempt.id,
        status: 'failed',
        errorClass: outcomeClass,
        latencyMs,
      });
      attempts[attempts.length - 1] = updatedAttempt;

      if (outcomeClass === 'not_sent' || outcomeClass === 'config_error' || outcomeClass === 'soft_decline') {
        // Non-negotiable rule 10: Never retry the same provider on not_sent, config_error, or soft_decline. Fail over immediately!
        attemptsCountByProvider[chosenProviderName] = this.maxAttemptsPerProvider;
      }

      if (outcomeClass === 'soft_decline') {
        softDeclineCascades++;
        if (softDeclineCascades > 1 || activePolicy === 'baseline') {
          currentPayment = await this.paymentRepo.transitionStatus(
            currentPayment.id,
            'processing',
            'failed',
            { failureReason: 'Soft decline: cascade limit reached' }
          );
          break;
        }
      }

      if (activePolicy === 'baseline') {
        // Baseline policy: single attempt, no retries, no failover
        currentPayment = await this.paymentRepo.transitionStatus(
          currentPayment.id,
          'processing',
          'failed',
          { failureReason: `Baseline policy attempt failed: ${outcomeClass}` }
        );
        break;
      }

      // If transient_known and same provider retry is allowed:
      if (outcomeClass === 'transient_known') {
        const canRetrySame = (attemptsCountByProvider[chosenProviderName] || 0) < this.maxAttemptsPerProvider;
        if (canRetrySame) {
          const backoff = calculateBackoffWithFullJitter(
            attemptsCountByProvider[chosenProviderName],
            { baseMs: 200, capMs: 2000, random: this.randomSource }
          );
          if (Date.now() + backoff < deadlineAt) {
            await new Promise((r) => setTimeout(r, backoff));
            continue; // Retry same provider
          }
        }
      }

      // Otherwise, loop will automatically select the next best eligible provider
    }

    if (currentPayment.status === 'processing') {
      currentPayment = await this.paymentRepo.transitionStatus(
        currentPayment.id,
        'processing',
        'failed',
        { failureReason: `All payment attempts exhausted (${this.maxAttemptsPerPayment} attempts completed without success)` }
      );
    }

      return {
        payment: currentPayment,
        attempts,
        isReplay,
      };
    } catch (unhandledErr) {
      if (currentPayment && (currentPayment.status === 'created' || currentPayment.status === 'processing')) {
        try {
          currentPayment = await this.paymentRepo.transitionStatus(
            currentPayment.id,
            currentPayment.status,
            'failed',
            { failureReason: `Unexpected engine error: ${(unhandledErr as Error)?.message || 'Internal failure'}` }
          );
        } catch {
          // ignore error updating status during unexpected panic
        }
      }
      throw unhandledErr;
    }
  }
}
