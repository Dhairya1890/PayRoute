import { createHash } from 'node:crypto';

/**
 * Recursively canonicalizes a value so that object keys are sorted alphabetically.
 * Ensures consistent serialization regardless of key insertion order or formatting.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJson(item));
    return `[${items.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const pairs = sortedKeys
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalizeJson(record[k])}`);

  return `{${pairs.join(',')}}`;
}

/**
 * Computes a SHA-256 hash of a payload using canonical JSON sorting.
 * 
 * Used for idempotency validation:
 * - If client sends the same Idempotency-Key with identical body -> same hash -> return cached payment.
 * - If client sends the same Idempotency-Key with different body -> different hash -> return 422 Conflict.
 */
export function hashPayload(payload: unknown): string {
  const canonical = canonicalizeJson(payload);
  return createHash('sha256').update(canonical).digest('hex');
}
