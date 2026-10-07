import { describe, it, expect } from 'vitest';
import {
  parseMoney,
  formatMoney,
  MoneySchema,
} from '../money.js';

describe('Money utilities - Correctness and Invariants', () => {
  it('accepts valid positive integer minor units as bigint with ISO 4217 currency', () => {
    const money = parseMoney('1500', 'INR');
    expect(money.amountMinor).toBe(1500n);
    expect(money.currency).toBe('INR');
  });

  it('rejects zero amounts', () => {
    expect(() => parseMoney('0', 'INR')).toThrow(/must be greater than zero/i);
    expect(() => parseMoney(0n, 'USD')).toThrow(/must be greater than zero/i);
  });

  it('rejects negative amounts', () => {
    expect(() => parseMoney('-100', 'INR')).toThrow(/must be greater than zero/i);
    expect(() => parseMoney(-50n, 'USD')).toThrow(/must be greater than zero/i);
  });

  it('rejects floating-point numbers explicitly', () => {
    // Strings with decimals or float representations
    expect(() => parseMoney('10.50', 'INR')).toThrow(/integer/i);
    expect(() => parseMoney('99.9', 'USD')).toThrow(/integer/i);
  });

  it('rejects invalid or missing currency codes', () => {
    expect(() => parseMoney('100', '')).toThrow(/ISO 4217/i);
    expect(() => parseMoney('100', 'inr')).toThrow(/ISO 4217/i); // Must be uppercase
    expect(() => parseMoney('100', 'US')).toThrow(/ISO 4217/i); // Must be 3 chars
    expect(() => parseMoney('100', 'USDT')).toThrow(/ISO 4217/i);
  });

  it('formats currency correctly without floating point inaccuracies', () => {
    // 2-decimal currency (INR, USD, EUR)
    expect(formatMoney({ amountMinor: 1050n, currency: 'INR' })).toBe('10.50 INR');
    expect(formatMoney({ amountMinor: 5n, currency: 'USD' })).toBe('0.05 USD');
    expect(formatMoney({ amountMinor: 100n, currency: 'EUR' })).toBe('1.00 EUR');

    // 0-decimal currency (JPY)
    expect(formatMoney({ amountMinor: 500n, currency: 'JPY' })).toBe('500 JPY');
  });

  it('Zod MoneySchema validates and rejects correctly', () => {
    // Valid input
    const valid = MoneySchema.safeParse({ amountMinor: 5000, currency: 'USD' });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data.amountMinor).toBe(5000n);
      expect(valid.data.currency).toBe('USD');
    }

    // Invalid float amount
    const floatResult = MoneySchema.safeParse({ amountMinor: 12.34, currency: 'USD' });
    expect(floatResult.success).toBe(false);

    // Invalid zero amount
    const zeroResult = MoneySchema.safeParse({ amountMinor: 0, currency: 'USD' });
    expect(zeroResult.success).toBe(false);

    // Invalid negative amount
    const negResult = MoneySchema.safeParse({ amountMinor: -100, currency: 'USD' });
    expect(negResult.success).toBe(false);

    // Invalid currency
    const badCurrency = MoneySchema.safeParse({ amountMinor: 1000, currency: 'inr' });
    expect(badCurrency.success).toBe(false);
  });
});
