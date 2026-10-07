import { z } from 'zod';

/**
 * Currency exponent map per ISO 4217.
 * Defines the number of decimal digits (minor unit scale) for each currency.
 * e.g., INR, USD, EUR have 2 decimal places (100 paise = 1 INR).
 * JPY, KRW have 0 decimal places (no sub-units in common transactions).
 * BHD, KWD have 3 decimal places.
 */
export const CURRENCY_EXPONENTS: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  AUD: 2,
  CAD: 2,
  SGD: 2,
  AED: 2,
};

/**
 * Standard ISO 4217 Currency Code validation (3 uppercase ASCII letters).
 */
export const CurrencySchema = z
  .string()
  .trim()
  .length(3, 'Currency must be a 3-letter ISO 4217 code')
  .regex(/^[A-Z]{3}$/, 'Currency must be uppercase ISO 4217 code (e.g., INR, USD)');

/**
 * Money representation:
 * 1. amountMinor: Stored as BigInt to avoid IEEE-754 floating-point inaccuracies
 *    (e.g., in floating-point math, 0.1 + 0.2 !== 0.3, which causes rounding leaks in financial systems).
 * 2. currency: ISO 4217 standard currency code.
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string;
}

/**
 * Zod schema for Money validation at system boundaries (HTTP request payloads).
 * Enforces positive integers and converts numbers/strings safely to BigInt.
 */
export const MoneySchema = z.object({
  amountMinor: z.union([
    z.bigint(),
    z.number().int('Amount in minor units must be an integer').finite(),
    z.string().regex(/^\d+$/, 'Amount string must contain only digits'),
  ]).transform((val, ctx) => {
    try {
      const parsed = typeof val === 'bigint' ? val : BigInt(val);
      if (parsed <= 0n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Amount must be greater than zero (positive integer minor units)',
        });
        return z.NEVER;
      }
      return parsed;
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid integer format for amountMinor',
      });
      return z.NEVER;
    }
  }),
  currency: CurrencySchema,
});

/**
 * Validates and constructs a Money instance.
 * Throws explicit errors if floats, negative numbers, zeroes, or invalid currencies are passed.
 */
export function parseMoney(amount: string | number | bigint, currency: string): Money {
  // Validate currency first
  const parsedCurrency = CurrencySchema.safeParse(currency);
  if (!parsedCurrency.success) {
    throw new Error(`Invalid ISO 4217 currency code: "${currency}". Must be 3 uppercase letters.`);
  }

  // Reject floating-point representation in numbers or strings
  if (typeof amount === 'number') {
    if (!Number.isInteger(amount)) {
      throw new Error(`Floating point amounts are not allowed: ${amount}. Use integer minor units.`);
    }
  } else if (typeof amount === 'string') {
    if (amount.includes('.') || amount.includes(',')) {
      throw new Error(`Floating point strings are not allowed: "${amount}". Use integer minor units (e.g., paise).`);
    }
    if (!/^-?\d+$/.test(amount.trim())) {
      throw new Error(`Invalid numeric string for amount: "${amount}".`);
    }
  }

  const amountMinor = BigInt(amount);
  if (amountMinor <= 0n) {
    throw new Error(`Amount must be greater than zero. Received: ${amountMinor}`);
  }

  return {
    amountMinor,
    currency: parsedCurrency.data,
  };
}

export function validateMoneyInput(amount: unknown, currency: unknown): Money {
  const result = MoneySchema.safeParse({ amountMinor: amount, currency });
  if (!result.success) {
    throw new Error(result.error.issues.map((i) => i.message).join('; '));
  }
  return result.data;
}

/**
 * Formats a Money object into a human-readable display string without floating-point math.
 * e.g., amountMinor: 1050n, currency: 'INR' -> "10.50 INR"
 * e.g., amountMinor: 500n, currency: 'JPY' -> "500 JPY"
 */
export function formatMoney(money: Money): string {
  const exponent = CURRENCY_EXPONENTS[money.currency] ?? 2;
  const str = money.amountMinor.toString();

  if (exponent === 0) {
    return `${str} ${money.currency}`;
  }

  const padded = str.padStart(exponent + 1, '0');
  const integerPart = padded.slice(0, padded.length - exponent);
  const fractionalPart = padded.slice(padded.length - exponent);

  return `${integerPart}.${fractionalPart} ${money.currency}`;
}
