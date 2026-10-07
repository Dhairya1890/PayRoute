import { z } from 'zod';
import { MoneySchema } from './money.js';

export const ProviderNameSchema = z.enum(['razorpay', 'stripe', 'payu']);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const OutcomeClassSchema = z.enum([
  'success',
  'hard_decline',
  'soft_decline',
  'not_sent',
  'rate_limited',
  'config_error',
  'bad_request',
  'transient',
  'ambiguous',
  'action_required',
]);
export type OutcomeClass = z.infer<typeof OutcomeClassSchema>;

export const CircuitBreakerStateSchema = z.enum(['closed', 'open', 'half_open']);
export type CircuitBreakerState = z.infer<typeof CircuitBreakerStateSchema>;

export const RoutingStrategySchema = z.enum([
  'priority',
  'lowest_cost',
  'success_rate_weighted',
]);
export type RoutingStrategy = z.infer<typeof RoutingStrategySchema>;

/**
 * Payment creation request schema validated at Fastify API boundary.
 */
export const CreatePaymentRequestSchema = z.object({
  amountMinor: MoneySchema.shape.amountMinor,
  currency: MoneySchema.shape.currency,
  customerReference: z.string().min(1, 'Customer reference is required').max(100),
  metadata: z.record(z.unknown()).optional(),
});
export type CreatePaymentRequest = z.infer<typeof CreatePaymentRequestSchema>;
