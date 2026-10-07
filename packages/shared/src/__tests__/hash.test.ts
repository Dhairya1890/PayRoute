import { describe, it, expect } from 'vitest';
import { hashPayload, canonicalizeJson } from '../hash.js';

describe('Payload Hashing for Idempotency', () => {
  it('generates deterministic SHA-256 hash regardless of object key order', () => {
    const objA = { amountMinor: 1000, currency: 'INR', customerId: 'cust_123' };
    const objB = { customerId: 'cust_123', currency: 'INR', amountMinor: 1000 };

    const hashA = hashPayload(objA);
    const hashB = hashPayload(objB);

    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[a-f0-9]{64}$/); // 64 hex characters (SHA-256)
  });

  it('generates different hashes for different payloads', () => {
    const objA = { amountMinor: 1000, currency: 'INR' };
    const objB = { amountMinor: 2000, currency: 'INR' };

    expect(hashPayload(objA)).not.toBe(hashPayload(objB));
  });

  it('handles nested objects deterministically', () => {
    const objA = { meta: { b: 2, a: 1 }, items: [{ y: 2, x: 1 }] };
    const objB = { items: [{ x: 1, y: 2 }], meta: { a: 1, b: 2 } };

    expect(canonicalizeJson(objA)).toBe(canonicalizeJson(objB));
    expect(hashPayload(objA)).toBe(hashPayload(objB));
  });
});
