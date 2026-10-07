export const CURRENCY_EXPONENTS: Record<string, number> = {
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  AUD: 2,
  CAD: 2,
  SGD: 2,
};

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string;
}

export function parseMoney(amount: string | number | bigint, currency: string): Money {
  const curr = currency.trim();
  if (!/^[A-Z]{3}$/.test(curr)) {
    throw new Error(`Invalid ISO 4217 currency code: "${currency}". Must be 3 uppercase letters.`);
  }

  if (typeof amount === 'number') {
    if (!Number.isInteger(amount)) {
      throw new Error(`Floating point amounts are not allowed: ${amount}. Use integer minor units.`);
    }
  } else if (typeof amount === 'string') {
    if (amount.includes('.') || amount.includes(',')) {
      throw new Error(`Floating point strings are not allowed: "${amount}". Use integer minor units.`);
    }
    if (!/^-?\d+$/.test(amount.trim())) {
      throw new Error(`Invalid numeric string for amount: "${amount}".`);
    }
  }

  const amountMinor = BigInt(amount);
  if (amountMinor <= 0n) {
    throw new Error(`Amount must be greater than zero. Received: ${amountMinor}`);
  }

  return { amountMinor, currency: curr };
}

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
