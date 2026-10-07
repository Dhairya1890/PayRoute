export type FailureMode =
  | 'healthy'
  | 'slow'
  | 'flaky'
  | 'unavailable'
  | 'response_lost'
  | 'hard_decline'
  | 'soft_decline'
  | 'rate_limited'
  | 'config_error';

export interface ProviderModeConfig {
  mode: FailureMode;
  latencyMs?: number;
  retryAfterSec?: number;
}

class FailureModeManager {
  private modes: Map<string, ProviderModeConfig> = new Map([
    ['razorpay', { mode: 'healthy' }],
    ['stripe', { mode: 'healthy' }],
    ['payu', { mode: 'healthy' }],
  ]);

  setMode(provider: string, config: ProviderModeConfig): void {
    this.modes.set(provider, config);
  }

  getMode(provider: string): ProviderModeConfig {
    return this.modes.get(provider) ?? { mode: 'healthy' };
  }

  reset(): void {
    this.modes.set('razorpay', { mode: 'healthy' });
    this.modes.set('stripe', { mode: 'healthy' });
    this.modes.set('payu', { mode: 'healthy' });
  }
}

export const failureModes = new FailureModeManager();
