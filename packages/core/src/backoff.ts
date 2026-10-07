export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  random?: () => number;
}

/**
 * Calculates exponential backoff with full jitter.
 * 
 * Formula:
 * calculated = min(cap, base * 2^(attempt - 1))
 * delay = floor(random() * calculated)
 * 
 * Why Full Jitter:
 * Avoids the "thundering herd" problem where multiple concurrently retrying requests
 * hammer the recovering provider at the exact same synchronized intervals.
 * 
 * Clocks and randomness are injectable to keep core logic 100% deterministic and testable.
 */
export function calculateBackoffWithFullJitter(
  attemptNumber: number,
  options: BackoffOptions = {}
): number {
  const {
    baseMs = 200,
    capMs = 2000,
    random = Math.random,
  } = options;

  const expFactor = Math.pow(2, Math.max(0, attemptNumber - 1));
  const calculated = Math.min(capMs, baseMs * expFactor);

  return Math.floor(random() * calculated);
}
