import { describe, it, expect } from 'vitest';
import { calculateBackoffWithFullJitter } from '../backoff.js';

describe('Backoff Logic - Full Jitter Exponential Bounds', () => {
  it('calculates exponential delay with base 200ms and cap 2000ms', () => {
    // With random = 1.0 (max jitter edge)
    const maxRandom = () => 1.0;

    expect(calculateBackoffWithFullJitter(1, { random: maxRandom })).toBe(200);
    expect(calculateBackoffWithFullJitter(2, { random: maxRandom })).toBe(400);
    expect(calculateBackoffWithFullJitter(3, { random: maxRandom })).toBe(800);
    expect(calculateBackoffWithFullJitter(4, { random: maxRandom })).toBe(1600);
    expect(calculateBackoffWithFullJitter(5, { random: maxRandom })).toBe(2000); // Capped at 2000ms
    expect(calculateBackoffWithFullJitter(6, { random: maxRandom })).toBe(2000);
  });

  it('scales delay uniformly across [0, calculated] with injectable random', () => {
    // Attempt 2 -> calculated is 400ms
    expect(calculateBackoffWithFullJitter(2, { random: () => 0.0 })).toBe(0);
    expect(calculateBackoffWithFullJitter(2, { random: () => 0.5 })).toBe(200);
    expect(calculateBackoffWithFullJitter(2, { random: () => 0.75 })).toBe(300);
  });

  it('supports custom base and cap parameters', () => {
    const delay = calculateBackoffWithFullJitter(2, {
      baseMs: 100,
      capMs: 500,
      random: () => 1.0,
    });
    // attempt 2: 100 * 2^1 = 200ms
    expect(delay).toBe(200);
  });
});
