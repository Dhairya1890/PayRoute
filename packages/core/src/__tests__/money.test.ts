import { describe, it, expect } from 'vitest';
import {
  parseMoney,
  formatMoney,
} from '../money.js';

describe('Money Utilities - Pure BigInt minor units', () => {
  it('parses valid positive integer minor units as bigint with currency', () => {
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

  it('rejects floating point amounts in numbers or strings', () => {
    expect(() => parseMoney('10.50', 'INR')).toThrow(/integer/i);
    expect(() => parseMoney(99.9, 'USD')).toThrow(/integer/i);
  });

  it('rejects invalid or lowercase currencies', () => {
    expect(() => parseMoney('100', 'inr')).toThrow(/ISO 4217/i);
    expect(() => parseMoney('100', 'US')).toThrow(/ISO 4217/i);
  });

  it('formats amounts correctly without float math', () => {
    expect(formatMoney({ amountMinor: 1050n, currency: 'INR' })).toBe('10.50 INR');
    expect(formatMoney({ amountMinor: 500n, currency: 'JPY' })).toBe('500 JPY');
  });
});
