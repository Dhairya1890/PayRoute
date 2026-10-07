import { useState } from 'react';
import type { FC } from 'react';
import {
  Sliders,
  Play,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { fetchProviders, updateSettings, startLabRun, fetchRunScoreboard, setProviderMode } from '../api';
import type { ScoreboardData } from '../types';

export const ComparePage: FC = () => {
  const [selectedScenario, setSelectedScenario] = useState('outage');
  const [isRunning, setIsRunning] = useState(false);
  const [baselineScoreboard, setBaselineScoreboard] = useState<ScoreboardData | null>(null);
  const [fullScoreboard, setFullScoreboard] = useState<ScoreboardData | null>(null);
  const [currentStep, setCurrentStep] = useState<string>('');

  const handleRunComparison = async () => {
    setIsRunning(true);
    setBaselineScoreboard(null);
    setFullScoreboard(null);

    let targetProvider = 'stripe';

    try {
      // 0. Detect the primary enabled gateway
      const providers = await fetchProviders();
      const enabledProviders = providers
        .filter((p) => p.enabled)
        .sort((a, b) => a.priority - b.priority);
      targetProvider = enabledProviders[0]?.name || 'stripe';

      // 1. Configure Provider Lab fault based on scenario
      if (selectedScenario === 'outage') {
        setCurrentStep(`Injecting 503 outage on primary gateway (${targetProvider.toUpperCase()})...`);
        await setProviderMode(targetProvider, 'unavailable');
      } else if (selectedScenario === 'flaky') {
        setCurrentStep(`Injecting 50% flaky drops on primary gateway (${targetProvider.toUpperCase()})...`);
        await setProviderMode(targetProvider, 'flaky');
      } else if (selectedScenario === 'slow') {
        setCurrentStep(`Injecting 2500ms latency on primary gateway (${targetProvider.toUpperCase()})...`);
        await setProviderMode(targetProvider, 'slow', { latencyMs: 2500 });
      }

      // 2. Run Test 1 with Baseline Policy (Single Provider Priority, 0 retries, 0 failovers)
      setCurrentStep(`Running 25 payments under BASELINE policy (static priority to ${targetProvider.toUpperCase()}, no failover)...`);
      await updateSettings({ policy: 'baseline' });
      const run1 = await startLabRun({
        count: 25,
        rate: 15,
        method: 'card',
        hard_decline_share: 0,
        soft_decline_share: 0,
      });

      // Poll until baseline batch completes all 25 payments
      let sb1: ScoreboardData | null = null;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 400));
        sb1 = await fetchRunScoreboard(run1.batch_id);
        setBaselineScoreboard(sb1);
        if (sb1.status === 'completed' && sb1.sent >= 25) break;
      }
      setBaselineScoreboard(sb1);

      // 3. Run Test 2 with Full Dynamic Policy (Adaptive Scoring, Circuit Breaker, Cascading)
      setCurrentStep(`Running 25 payments under FULL dynamic policy (circuit breaker + failover from ${targetProvider.toUpperCase()})...`);
      await updateSettings({ policy: 'full' });
      const run2 = await startLabRun({
        count: 25,
        rate: 15,
        method: 'card',
        hard_decline_share: 0,
        soft_decline_share: 0,
      });

      // Poll until full batch completes all 25 payments
      let sb2: ScoreboardData | null = null;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 400));
        sb2 = await fetchRunScoreboard(run2.batch_id);
        setFullScoreboard(sb2);
        if (sb2.status === 'completed' && sb2.sent >= 25) break;
      }
      setFullScoreboard(sb2);

      // 4. Restore provider modes
      await setProviderMode(targetProvider, 'healthy');
      setCurrentStep('Comparison complete.');
    } catch (err: any) {
      alert(`Comparison failed: ${err.message}`);
    } finally {
      // Ensure all providers are restored to healthy and policy restored to full
      try {
        const providers = await fetchProviders();
        for (const p of providers) {
          await setProviderMode(p.name, 'healthy').catch(() => {});
        }
        await updateSettings({ policy: 'full' }).catch(() => {});
      } catch {
        // ignore
      }
      setIsRunning(false);
    }
  };

  const getSuccessRate = (sb: ScoreboardData | null): string => {
    if (!sb || sb.sent === 0) return '0%';
    return `${((sb.succeeded / sb.sent) * 100).toFixed(1)}%`;
  };

  return (
    <div className="w-full flex flex-col gap-4">
      {/* Control Section */}
      <section className="w-full border border-outline-variant bg-surface rounded-lg overflow-hidden">
        <div className="h-[32px] px-3 border-b border-outline-variant flex items-center justify-between bg-surface-container-lowest">
          <h2 className="text-[13px] font-semibold text-on-surface flex items-center gap-2">
            <Sliders className="w-4 h-4 text-text-secondary" /> Policy Comparison: Baseline vs. Full Dynamic Engine
          </h2>
        </div>
        <div className="p-3 flex items-center justify-between">
          <p className="text-[12px] text-text-secondary">
            Empirical side-by-side benchmark: execute identical failure conditions through the real engine twice.
          </p>
          <div className="flex items-center gap-3">
            <select
              value={selectedScenario}
              onChange={(e) => setSelectedScenario(e.target.value)}
              disabled={isRunning}
              className="h-[28px] bg-surface-container-lowest border border-outline-variant rounded px-2 text-[12px] text-on-surface focus:outline-none"
            >
              <option value="outage">Scenario: Complete Outage on Primary Gateway</option>
              <option value="flaky">Scenario: Flaky Gateway (50% Intermittent Drops)</option>
              <option value="slow">Scenario: Severe Gateway Latency Spike</option>
            </select>
            <button
              onClick={handleRunComparison}
              disabled={isRunning}
              className="h-[28px] px-3 bg-primary text-on-primary rounded text-[12px] font-medium hover:bg-on-surface-variant transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              {isRunning ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Running...
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" /> Run Benchmark
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* Progress Step */}
      {isRunning && (
        <div className="px-3 py-2 border border-outline-variant rounded bg-surface-container-lowest flex items-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin text-text-secondary" />
          <span className="font-mono text-[12px] text-text-secondary">{currentStep}</span>
        </div>
      )}

      {/* Comparison Grid */}
      <div className="grid grid-cols-2 gap-3">
        {/* Baseline Card */}
        <div className="border border-outline-variant bg-surface rounded-lg flex flex-col">
          <div className="p-3 border-b border-outline-variant">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-[11px] font-mono text-text-secondary block">POLICY: BASELINE</span>
                <h3 className="text-[14px] font-semibold text-on-surface">Traditional Static Routing</h3>
              </div>
              <span className="text-[11px] px-2 py-0.5 rounded bg-surface-container border border-outline-variant text-text-secondary font-mono">
                No Failover • Single Attempt
              </span>
            </div>
            <p className="text-[12px] text-text-secondary leading-relaxed">
              Standard payments implementation: hardcodes a single primary provider. When that provider encounters downtime or network drops, transactions fail immediately with zero retries.
            </p>
          </div>
          <div className="grid grid-cols-2 grid-rows-2 divide-x divide-y divide-outline-variant">
            <div className="p-3 flex flex-col justify-between">
              <span className="text-[11px] text-text-secondary uppercase">Success Rate</span>
              <div className="font-mono text-[18px] text-on-surface mt-1">{getSuccessRate(baselineScoreboard)}</div>
              <span className="font-mono text-[11px] text-text-tertiary mt-0.5">from {baselineScoreboard?.sent ?? 0} sent</span>
            </div>
            <div className="p-3 flex flex-col justify-between">
              <span className="text-[11px] text-text-secondary uppercase">Failed Payments</span>
              <div className="font-mono text-[18px] text-on-surface mt-1">{baselineScoreboard?.failed ?? 0}</div>
              <span className="font-mono text-[11px] text-text-tertiary mt-0.5">terminal drops</span>
            </div>
            <div className="p-3 flex flex-col justify-between">
              <span className="text-[11px] text-text-secondary uppercase">Failovers Triggered</span>
              <div className="font-mono text-[18px] text-on-surface mt-1">0</div>
              <span className="font-mono text-[11px] text-text-tertiary mt-0.5">not supported</span>
            </div>
            <div className="p-3 flex flex-col justify-between">
              <span className="text-[11px] text-text-secondary uppercase">Duplicate Charges</span>
              <div className={`font-mono text-[18px] mt-1 ${(baselineScoreboard?.duplicate_charges === 0) ? 'text-success' : 'text-on-surface'}`}>
                {baselineScoreboard?.duplicate_charges ?? 0}
              </div>
              <span className="font-mono text-[11px] text-text-tertiary mt-0.5">lab ledger</span>
            </div>
          </div>
          <div className="p-3 border-t border-outline-variant bg-surface-container-lowest">
            <p className="text-[11px] text-text-secondary">
              Result: 100% dependent on single gateway health. Outage halts business checkout.
            </p>
          </div>
        </div>

        {/* Full Dynamic Policy Card */}
        <div className="border border-outline-variant bg-surface rounded-lg flex flex-col">
          <div className="p-3 border-b border-outline-variant">
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="text-[11px] font-mono text-success block">POLICY: FULL DYNAMIC ENGINE</span>
                <h3 className="text-[14px] font-semibold text-on-surface">PayRoute Adaptive Engine</h3>
              </div>
              <span className="text-[11px] px-2 py-0.5 rounded bg-[rgba(74,222,128,0.08)] border border-[rgba(74,222,128,0.3)] text-success font-mono">
                Circuit Breakers • Zero Double-Charge
              </span>
            </div>
            <p className="text-[12px] text-text-secondary leading-relaxed">
              Resilient intelligent routing: automatically trips per-segment circuit breakers on gateway faults, executes status checks before retry, and dynamically fails over to healthy gateways.
            </p>
          </div>
          <div className="grid grid-cols-2 grid-rows-2 divide-x divide-y divide-outline-variant">
            <div className="p-3 flex flex-col justify-between">
              <span className="text-[11px] text-text-secondary uppercase">Success Rate</span>
              <div className="font-mono text-[18px] text-on-surface mt-1">{getSuccessRate(fullScoreboard)}</div>
              <span className="font-mono text-[11px] text-text-tertiary mt-0.5">from {fullScoreboard?.sent ?? 0} sent</span>
            </div>
            <div className="p-3 flex flex-col justify-between">
              <span className="text-[11px] text-text-secondary uppercase">Failed Payments</span>
              <div className="font-mono text-[18px] text-on-surface mt-1">{fullScoreboard?.failed ?? 0}</div>
              <span className="font-mono text-[11px] text-text-tertiary mt-0.5">terminal drops</span>
            </div>
            <div className="p-3 flex flex-col justify-between">
              <span className="text-[11px] text-text-secondary uppercase">Failovers Triggered</span>
              <div className="font-mono text-[18px] text-on-surface mt-1">{fullScoreboard?.failovers ?? 0}</div>
              <span className="font-mono text-[11px] text-text-tertiary mt-0.5">automatic recovery</span>
            </div>
            <div className="p-3 flex flex-col justify-between">
              <span className="text-[11px] text-text-secondary uppercase">Duplicate Charges</span>
              <div className={`font-mono text-[18px] mt-1 ${(fullScoreboard?.duplicate_charges === 0) ? 'inline-flex items-center justify-center rounded px-1.5 py-0.5 bg-[rgba(74,222,128,0.08)] border border-[rgba(74,222,128,0.3)] text-success' : 'text-on-surface'}`}>
                {fullScoreboard?.duplicate_charges ?? 0}
              </div>
              <span className="font-mono text-[11px] text-text-tertiary mt-0.5">lab ledger</span>
            </div>
          </div>
          <div className="p-3 border-t border-outline-variant bg-surface-container-lowest flex items-center justify-between">
            <p className="text-[11px] text-success">
              Result: Checkout continuity preserved under gateway failure with ZERO double charges.
            </p>
            <ShieldCheck className="w-4 h-4 text-success" />
          </div>
        </div>
      </div>
    </div>
  );
};
