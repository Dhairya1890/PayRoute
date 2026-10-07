import dotenv from 'dotenv';
import path from 'node:path';

// Load root .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const ENGINE_URL = process.env.ENGINE_URL || 'http://127.0.0.1:3000';
export const PROVIDER_LAB_URL = process.env.PROVIDER_LAB_URL || 'http://127.0.0.1:4000';
export const ENGINE_API_KEY = process.env.ENGINE_API_KEY || 'pr_test_engine_key_secret';

export interface LabCharge {
  provider: string;
  providerRef: string;
  idempotencyKey: string;
  amountMinor: string;
  currency: string;
  status: string;
}

export interface HealthCheckResult {
  engineOk: boolean;
  labOk: boolean;
  engineStatus?: any;
}

/**
 * Checks connectivity to Engine and Provider Lab.
 */
export async function checkHealth(): Promise<HealthCheckResult> {
  let engineOk = false;
  let labOk = false;
  let engineStatus: any = null;

  try {
    const res = await fetch(`${ENGINE_URL}/health`);
    if (res.ok) {
      engineOk = true;
      engineStatus = await res.json();
    }
  } catch {
    engineOk = false;
  }

  try {
    const res = await fetch(`${PROVIDER_LAB_URL}/lab/status`);
    if (res.ok) {
      labOk = true;
    }
  } catch {
    labOk = false;
  }

  return { engineOk, labOk, engineStatus };
}

/**
 * Asserts that the Engine and Provider Lab are reachable before running benchmarks.
 */
export async function ensureServicesRunning(): Promise<void> {
  const health = await checkHealth();
  if (!health.engineOk) {
    throw new Error(
      `PayRoute Engine is not running at ${ENGINE_URL}. Please start it with: pnpm dev:engine`
    );
  }
  if (!health.labOk) {
    throw new Error(
      `Provider Lab is not running at ${PROVIDER_LAB_URL}. Please start it with: pnpm dev:provider-lab`
    );
  }
}

/**
 * Resets Provider Lab charges ledger and resets all provider failure modes to 'healthy'.
 */
export async function resetProviderLab(): Promise<void> {
  const res = await fetch(`${PROVIDER_LAB_URL}/lab/charges/reset`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`Failed to reset Provider Lab: HTTP ${res.status}`);
  }
}

/**
 * Configures the failure mode of a given provider in the Provider Lab.
 */
export async function setProviderMode(
  provider: string,
  mode: 'healthy' | 'slow' | 'flaky' | 'unavailable' | 'response_lost' | 'hard_decline' | 'soft_decline' | 'rate_limited' | 'config_error',
  options: { latencyMs?: number; retryAfterSec?: number } = {}
): Promise<void> {
  const res = await fetch(`${PROVIDER_LAB_URL}/lab/providers/${provider}/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode, ...options }),
  });
  if (!res.ok) {
    throw new Error(`Failed to set mode for ${provider}: HTTP ${res.status}`);
  }
}

/**
 * Fetches all charges recorded in the Provider Lab's independent ledger.
 */
export async function fetchLabCharges(): Promise<LabCharge[]> {
  const res = await fetch(`${PROVIDER_LAB_URL}/lab/charges`);
  if (!res.ok) {
    throw new Error(`Failed to fetch lab charges: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Verifies the non-negotiable financial invariant:
 * Zero duplicate charges in the independent Provider Lab ledger.
 */
export async function verifyZeroDuplicateCharges(): Promise<{
  totalCharges: number;
  duplicateKeys: string[];
  passed: boolean;
}> {
  const charges = await fetchLabCharges();
  const keyCount = new Map<string, number>();

  for (const c of charges) {
    keyCount.set(c.idempotencyKey, (keyCount.get(c.idempotencyKey) || 0) + 1);
  }

  const duplicateKeys: string[] = [];
  for (const [key, count] of keyCount.entries()) {
    if (count > 1) {
      duplicateKeys.push(`${key} (${count} charges)`);
    }
  }

  return {
    totalCharges: charges.length,
    duplicateKeys,
    passed: duplicateKeys.length === 0,
  };
}

/**
 * Standard HTTP headers with API key authentication.
 */
export function getAuthHeaders(idempotencyKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': ENGINE_API_KEY,
  };
  if (idempotencyKey) {
    headers['idempotency-key'] = idempotencyKey;
  }
  return headers;
}
