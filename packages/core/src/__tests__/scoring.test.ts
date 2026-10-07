import { describe, it, expect } from 'vitest';
import {
  calculateSmoothedSuccessRate,
  calculateScore,
  normalizeLatency,
  normalizeCost,
} from '../scoring.js';

describe('Scoring Logic - Smoothing and Provider Ranking', () => {
  describe('calculateSmoothedSuccessRate', () => {
    it('applies Bayesian prior of 19/20 (0.95) when volume is zero', () => {
      const rate = calculateSmoothedSuccessRate(0, 0);
      expect(rate).toBeCloseTo(19 / 20, 4); // 0.95
    });

    it('prevents single failure from dropping success rate to 0 on thin volume', () => {
      // 1 attempt, 0 successes
      const rate = calculateSmoothedSuccessRate(0, 1);
      // (0 + 19) / (1 + 20) = 19 / 21 ≈ 0.9047
      expect(rate).toBeCloseTo(19 / 21, 4);
    });

    it('converges to true rate as volume increases', () => {
      // 100 attempts, 98 successes
      const rateHigh = calculateSmoothedSuccessRate(98, 100);
      // (98 + 19) / (100 + 20) = 117 / 120 = 0.975
      expect(rateHigh).toBeCloseTo(0.975, 3);

      // 100 attempts, 50 successes
      const rateLow = calculateSmoothedSuccessRate(50, 100);
      // (50 + 19) / (100 + 20) = 69 / 120 = 0.575
      expect(rateLow).toBeCloseTo(0.575, 3);
    });
  });

  describe('normalizeLatency and normalizeCost', () => {
    it('normalizes latency relative to expected max (capped at 1.0)', () => {
      expect(normalizeLatency(250, 1000)).toBe(0.25);
      expect(normalizeLatency(1000, 1000)).toBe(1.0);
      expect(normalizeLatency(1500, 1000)).toBe(1.0); // Capped at 1.0
    });

    it('normalizes cost relative to expected max (capped at 1.0)', () => {
      expect(normalizeCost(190, 500)).toBe(0.38);
      expect(normalizeCost(500, 500)).toBe(1.0);
      expect(normalizeCost(600, 500)).toBe(1.0);
    });
  });

  describe('calculateScore', () => {
    it('ranks higher success rate, lower latency, and lower cost higher', () => {
      // Provider A: 98% success, 150ms p95, 190 bps cost
      const scoreA = calculateScore({
        smoothedSuccessRate: 0.98,
        p95LatencyMs: 150,
        costBps: 190,
      });

      // Provider B: 90% success, 400ms p95, 290 bps cost
      const scoreB = calculateScore({
        smoothedSuccessRate: 0.90,
        p95LatencyMs: 400,
        costBps: 290,
      });

      expect(scoreA).toBeGreaterThan(scoreB);
    });
  });
});
