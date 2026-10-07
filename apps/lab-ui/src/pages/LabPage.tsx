import { useState, useEffect, useRef } from 'react';
import type { FC } from 'react';
import {
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import type { ProviderInfo, ScoreboardData, ScenarioResult, FailureMode } from '../types';
import { setProviderMode, updateProvider, startLabRun, runScenario, subscribeToLabStream, fetchScenarioResult } from '../api';
import { CircuitBreakerTimeline } from '../components/Uptime';
import { LineChart } from '../components/LineChart';

interface LabPageProps {
  providers: ProviderInfo[];
  scoreboard: ScoreboardData | null;
  onRefresh: () => void;
  scenarioResults: Map<string, ScenarioResult>;
}

export const LabPage: FC<LabPageProps> = ({
  providers,
  scoreboard,
  onRefresh,
  scenarioResults,
}) => {
  // Traffic Generator State
  const [trafficCount, setTrafficCount] = useState(30);
  const [trafficRate, setTrafficRate] = useState(15);
  const [trafficMethod, setTrafficMethod] = useState<'card' | 'upi' | 'netbanking'>('card');
  const [hardDeclineShare, setHardDeclineShare] = useState(0);
  const [softDeclineShare, setSoftDeclineShare] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [runningScenario, setRunningScenario] = useState<string | null>(null);
  const [localScenarioResults, setLocalScenarioResults] = useState<Map<string, ScenarioResult>>(scenarioResults);

  // Sync with prop updates from SSE
  useEffect(() => {
    setLocalScenarioResults((prev) => {
      const merged = new Map(prev);
      scenarioResults.forEach((val, key) => merged.set(key, val));
      return merged;
    });
  }, [scenarioResults]);
  const [telemetryHistory, setTelemetryHistory] = useState<
    Array<{
      time: string;
      stripeSuccess: number;
      razorpaySuccess: number;
      payuSuccess: number;
      stripeTraffic: number;
      razorpayTraffic: number;
      payuTraffic: number;
      stripeBreaker: number;
      razorpayBreaker: number;
      payuBreaker: number;
    }>
  >([]);

  // Live traffic count accumulator
  const trafficCountsRef = useRef<{ stripe: number; razorpay: number; payu: number }>({
    stripe: 0,
    razorpay: 0,
    payu: 0,
  });

  // Listen to live stream for real-time traffic distributions
  useEffect(() => {
    const unsubscribe = subscribeToLabStream((event) => {
      if (event.type === 'payment_completed' && event.data?.finalProvider) {
        const prov = String(event.data.finalProvider).toLowerCase();
        if (prov === 'stripe') trafficCountsRef.current.stripe++;
        else if (prov === 'razorpay') trafficCountsRef.current.razorpay++;
        else if (prov === 'payu') trafficCountsRef.current.payu++;
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Sync telemetry history on provider updates or scoreboard updates
  useEffect(() => {
    if (!providers || providers.length === 0) return;

    const now = new Date().toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' });
    const stripe = providers.find((p) => p.name === 'stripe');
    const razorpay = providers.find((p) => p.name === 'razorpay');
    const payu = providers.find((p) => p.name === 'payu');

    const breakerNum = (state?: string) => {
      if (state === 'open') return 2;
      if (state === 'half_open') return 1;
      return 0;
    };

    setTelemetryHistory((prev) => {
      const nextPoint = {
        time: now,
        stripeSuccess: Math.round((stripe?.smoothed_success_rate ?? 1) * 100),
        razorpaySuccess: Math.round((razorpay?.smoothed_success_rate ?? 1) * 100),
        payuSuccess: Math.round((payu?.smoothed_success_rate ?? 1) * 100),
        stripeTraffic: trafficCountsRef.current.stripe,
        razorpayTraffic: trafficCountsRef.current.razorpay,
        payuTraffic: trafficCountsRef.current.payu,
        stripeBreaker: breakerNum(stripe?.breaker_state),
        razorpayBreaker: breakerNum(razorpay?.breaker_state),
        payuBreaker: breakerNum(payu?.breaker_state),
      };

      const updated = [...prev, nextPoint];
      return updated.length > 30 ? updated.slice(updated.length - 30) : updated;
    });
  }, [providers, scoreboard]);

  // Provider Mode Handlers
  const handleModeChange = async (provider: string, mode: FailureMode) => {
    try {
      await setProviderMode(provider, mode);
      onRefresh();
    } catch (err: any) {
      alert(`Failed to set mode: ${err.message}`);
    }
  };

  const handleToggleEnabled = async (provider: string, current: boolean) => {
    try {
      await updateProvider(provider, { enabled: !current });
      onRefresh();
    } catch (err: any) {
      alert(`Failed to toggle provider: ${err.message}`);
    }
  };

  // Provider eligibility checks
  const enabledProviders = providers.filter((p) => p.enabled);
  const allProvidersDisabled = providers.length > 0 && enabledProviders.length === 0;
  const eligibleProviders = enabledProviders.filter(
    (p) => (p.supported_methods || ['card']).includes(trafficMethod)
  );
  const canStartTraffic = eligibleProviders.length > 0;

  const handleStartTraffic = async () => {
    if (!canStartTraffic) {
      if (allProvidersDisabled) {
        alert('Cannot start traffic: All payment providers are currently disabled. Please enable at least one provider.');
      } else {
        alert(`Cannot start traffic: No enabled providers support "${trafficMethod.toUpperCase()}". Please enable a compatible provider or choose another payment method.`);
      }
      return;
    }
    setIsGenerating(true);
    try {
      const normHard = hardDeclineShare > 1 ? hardDeclineShare / 100 : hardDeclineShare;
      const normSoft = softDeclineShare > 1 ? softDeclineShare / 100 : softDeclineShare;
      await startLabRun({
        count: trafficCount,
        rate: trafficRate,
        method: trafficMethod,
        hard_decline_share: normHard,
        soft_decline_share: normSoft,
      });
    } catch (err: any) {
      alert(`Failed to start traffic: ${err.message}`);
    } finally {
      setTimeout(() => setIsGenerating(false), 1000);
    }
  };

  const handleExecuteScenario = async (name: string) => {
    if (allProvidersDisabled) {
      alert('Cannot start scenario: All payment providers are currently disabled. Please enable providers first.');
      return;
    }
    setRunningScenario(name);
    try {
      await runScenario(name);
      // Actively poll for the completed verdict every 1s for up to 35s
      for (let i = 0; i < 35; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const res = await fetchScenarioResult(name);
        if (res) {
          setLocalScenarioResults((prev) => {
            const next = new Map(prev);
            next.set(name, res);
            return next;
          });
          break;
        }
      }
      onRefresh();
    } catch (err: any) {
      alert(`Failed to start scenario: ${err.message}`);
    } finally {
      setRunningScenario(null);
    }
  };

  const scenariosList = [
    {
      id: 'provider_outage',
      title: 'Provider Outage',
      desc: 'Simulates complete 503 outage on one provider. Verifies breaker trips, zero double charges, and seamless failover.',
    },
    {
      id: 'slow_provider',
      title: 'Slow Provider',
      desc: 'Simulates 2500ms latency spike. Verifies adaptive scoring shifts traffic away before deadlines expire.',
    },
    {
      id: 'flaky_provider',
      title: 'Flaky Gateway',
      desc: 'Simulates 50% intermittent 500 errors. Verifies bounded exponential retries with jitter maintain success.',
    },
    {
      id: 'response_lost',
      title: 'Response Lost (Timeout After Debit)',
      desc: 'Simulates dropped response after charge. Verifies status query prevents double-charging.',
    },
    {
      id: 'decline_storm',
      title: 'Decline Storm',
      desc: 'Simulates wave of hard card declines. Verifies declines never trip the breaker or cause duplicate retries.',
    },
    {
      id: 'rate_limited',
      title: 'Rate Limited (HTTP 429)',
      desc: 'Simulates rate limit with Retry-After. Verifies retry budget and backoff windows are honored.',
    },
    {
      id: 'recovery',
      title: 'Circuit Breaker Recovery',
      desc: 'Simulates outage followed by restoration. Verifies breaker transitions via half-open probe slots to closed.',
    },
  ];

  // Fetch previously executed scenario results on mount
  useEffect(() => {
    scenariosList.forEach(async (scen) => {
      try {
        const res = await fetchScenarioResult(scen.id);
        if (res) {
          setLocalScenarioResults((prev) => {
            const next = new Map(prev);
            next.set(scen.id, res);
            return next;
          });
        }
      } catch {
        // Not run yet
      }
    });
  }, []);

  // Helper for telemetry provider names to keys
  const providerKey = (name: string) => name.toLowerCase() as 'stripe' | 'razorpay' | 'payu';

  return (
    <div className="flex flex-col w-full text-on-surface">
      {/* ------------------------------------------------------------- */}
      {/* A. Run Toolbar (Traffic Generator) */}
      {/* ------------------------------------------------------------- */}
      <section className="w-full h-[40px] border-b border-outline-variant flex items-center justify-between px-3 select-none bg-surface-container-lowest">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <label className="text-[12px] text-text-secondary whitespace-nowrap">Payments</label>
            <input
              type="number"
              value={trafficCount}
              onChange={(e) => setTrafficCount(Number(e.target.value))}
              className="w-[72px] h-[28px] bg-surface-container-lowest border border-outline-variant rounded px-2 font-mono text-[12px] text-on-surface outline-none"
            />
          </div>

          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <label className="text-[12px] text-text-secondary whitespace-nowrap">Rate</label>
            <div className="relative flex items-center w-[84px]">
              <input
                type="number"
                value={trafficRate}
                onChange={(e) => setTrafficRate(Number(e.target.value))}
                className="w-full h-[28px] bg-surface-container-lowest border border-outline-variant rounded pl-2 pr-9 font-mono text-[12px] text-on-surface outline-none"
              />
              <span className="absolute right-1.5 text-text-tertiary font-mono text-[10px] pointer-events-none select-none">req/s</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <label className="text-[12px] text-text-secondary whitespace-nowrap">Method</label>
            <select
              value={trafficMethod}
              onChange={(e) => setTrafficMethod(e.target.value as any)}
              className="h-[28px] bg-surface-container-lowest border border-outline-variant rounded px-2 text-[12px] text-on-surface outline-none appearance-none pr-6 custom-select-trigger"
            >
              <option value="card">Card</option>
              <option value="upi">UPI</option>
              <option value="netbanking">Net Banking</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <label className="text-[12px] text-text-secondary whitespace-nowrap">Hard declines</label>
            <div className="relative flex items-center w-[68px]">
              <input
                type="number"
                step="1"
                min="0"
                max="100"
                value={hardDeclineShare}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setHardDeclineShare(isNaN(val) ? 0 : Math.min(Math.max(val, 0), 100));
                }}
                className="w-full h-[28px] bg-surface-container-lowest border border-outline-variant rounded pl-2 pr-5 font-mono text-[12px] text-on-surface outline-none"
              />
              <span className="absolute right-1.5 text-text-tertiary font-mono text-[10px] pointer-events-none select-none">%</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <label className="text-[12px] text-text-secondary whitespace-nowrap">Soft declines</label>
            <div className="relative flex items-center w-[68px]">
              <input
                type="number"
                step="1"
                min="0"
                max="100"
                value={softDeclineShare}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setSoftDeclineShare(isNaN(val) ? 0 : Math.min(Math.max(val, 0), 100));
                }}
                className="w-full h-[28px] bg-surface-container-lowest border border-outline-variant rounded pl-2 pr-5 font-mono text-[12px] text-on-surface outline-none"
              />
              <span className="absolute right-1.5 text-text-tertiary font-mono text-[10px] pointer-events-none select-none">%</span>
            </div>
          </div>

          <div className="h-4 w-px bg-outline-variant"></div>

          <button
            onClick={handleStartTraffic}
            disabled={isGenerating || !canStartTraffic}
            className={`h-[28px] px-3 rounded text-[12px] font-medium transition-colors flex items-center gap-1.5 ${
              isGenerating || !canStartTraffic
                ? 'bg-transparent border border-outline-variant text-text-tertiary cursor-not-allowed opacity-50'
                : 'bg-primary text-on-primary hover:bg-[#c8c6c5]'
            }`}
          >
            {isGenerating ? (
              <><RefreshCw className="w-3 h-3 animate-spin" /> Starting...</>
            ) : (
              'Start run'
            )}
          </button>
        </div>
      </section>

      {!canStartTraffic && (
        <div className="w-full bg-[rgba(251,191,36,0.15)] border-b border-[rgba(251,191,36,0.4)] px-3 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-warning" />
          <span className="text-[12px] text-warning">
            {allProvidersDisabled
              ? 'Cannot start traffic: All payment providers are currently disabled. Please enable at least one provider.'
              : `Cannot start traffic: No enabled providers support "${trafficMethod.toUpperCase()}". Please enable a compatible provider.`}
          </span>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* B. Correctness Scoreboard */}
      {/* ------------------------------------------------------------- */}
      <section className="w-full border-b border-outline-variant bg-surface">
        <div className="h-[32px] px-3 border-b border-outline-variant flex items-center justify-between bg-surface-container-lowest">
          <span className="text-[13px] text-on-surface font-semibold">Correctness</span>
          {scoreboard?.status === 'running' && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-surface-container-high border border-outline-variant text-on-surface">
              <RefreshCw className="w-3 h-3 animate-spin" /> batch running
            </span>
          )}
        </div>
        <div className="flex flex-row overflow-x-auto divide-x divide-outline-variant">
          {[
            { label: 'Sent', val: scoreboard?.sent ?? 0, ctx: 'total' },
            { label: 'Succeeded', val: scoreboard?.succeeded ?? 0, ctx: scoreboard?.sent ? `${((scoreboard.succeeded / scoreboard.sent) * 100).toFixed(1)}%` : '0%' },
            { label: 'Failed', val: scoreboard?.failed ?? 0, ctx: 'all declined' },
            { label: 'Unknown', val: scoreboard?.unknown ?? 0, ctx: 'in flight' },
            { label: 'Retries', val: scoreboard?.retries ?? 0, ctx: 'same provider' },
            { label: 'Failovers', val: scoreboard?.failovers ?? 0, ctx: 'cross provider' },
            { label: 'Duplicate charges', val: scoreboard?.duplicate_charges ?? 0, ctx: 'lab ledger', highlight: true },
            { label: 'Unrecorded charges', val: scoreboard?.unrecorded_charges ?? 0, ctx: 'lab ledger' },
            { label: 'Needs review', val: scoreboard?.needs_review ?? 0, ctx: 'past deadline' }
          ].map((stat, i) => (
            <div key={i} className="p-2.5 flex flex-col justify-between min-w-[115px] flex-1">
              <span className="text-[11px] text-text-secondary">{stat.label}</span>
              <div className={`font-mono text-[18px] mt-1 ${stat.highlight && stat.val > 0 ? 'text-error animate-pulse' : 'text-on-surface'}`}>
                {stat.val}
              </div>
              <span className="font-mono text-[11px] text-text-tertiary mt-0.5">{stat.ctx}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------- */}
      {/* C. Providers Panel */}
      {/* ------------------------------------------------------------- */}
      <section className="w-full border-b border-outline-variant bg-surface">
        <div className="h-[32px] px-3 border-b border-outline-variant flex items-center justify-between bg-surface-container-lowest">
          <span className="text-[13px] text-on-surface font-semibold">Providers</span>
          <span className="text-[11px] text-text-secondary">Gateway status and fault injection</span>
        </div>
        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse text-left whitespace-nowrap text-[12px]">
            <thead>
              <tr className="h-[28px] border-b border-outline-variant bg-surface-container-low text-text-secondary text-[11px]">
                <th className="px-3 font-normal" style={{ width: '120px' }}>Provider</th>
                <th className="px-3 font-normal" style={{ width: '96px' }}>Breaker</th>
                <th className="px-3 font-normal text-center" style={{ width: '64px' }}>Enabled</th>
                <th className="px-3 font-normal" style={{ width: '160px' }}>Failure mode</th>
                <th className="px-3 font-normal text-right" style={{ width: '88px' }}>Success</th>
                <th className="px-3 font-normal text-right" style={{ width: '88px' }}>P95</th>
                <th className="px-3 font-normal" style={{ width: '140px' }}>Traffic share</th>
                <th className="px-3 font-normal text-right" style={{ width: '88px' }}>Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {providers.map((p) => {
                const totalTraffic = Object.values(trafficCountsRef.current).reduce((a, b) => a + b, 0);
                const myTraffic = trafficCountsRef.current[providerKey(p.name)] || 0;
                const share = totalTraffic > 0 ? (myTraffic / totalTraffic) * 100 : 0;
                
                const breakerColor =
                  p.breaker_state === 'closed'
                    ? 'bg-[rgba(74,222,128,0.08)] border-[rgba(74,222,128,0.3)] text-success'
                    : p.breaker_state === 'half_open'
                    ? 'bg-[rgba(251,191,36,0.15)] border-[rgba(251,191,36,0.4)] text-warning'
                    : 'bg-[rgba(248,113,113,0.12)] border-[rgba(248,113,113,0.3)] text-error';

                return (
                  <tr key={p.name} className={`h-[44px] transition-colors ${!p.enabled ? 'opacity-50 bg-surface-container-lowest' : 'hover:bg-surface-container-low'}`}>
                    <td className="px-3 text-on-surface font-medium capitalize">{p.name}</td>
                    <td className="px-3">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border ${breakerColor}`}>
                        {p.breaker_state}
                      </span>
                    </td>
                    <td className="px-3 text-center">
                      <button 
                        onClick={() => handleToggleEnabled(p.name, p.enabled)}
                        className={`w-7 h-4 rounded-full p-0.5 inline-flex items-center cursor-pointer transition-colors ${p.enabled ? 'bg-primary justify-end' : 'bg-surface-container-highest justify-start'}`}
                      >
                        <span className={`w-3 h-3 rounded-full ${p.enabled ? 'bg-surface' : 'bg-text-secondary'}`}></span>
                      </button>
                    </td>
                    <td className="px-3">
                      <select
                        value={p.current_mode || 'healthy'}
                        onChange={(e) => handleModeChange(p.name, e.target.value as FailureMode)}
                        className="w-[140px] h-[24px] bg-surface-container-lowest border border-outline-variant rounded px-2 text-[11px] text-on-surface outline-none appearance-none"
                      >
                        <option value="healthy">Healthy</option>
                        <option value="slow">Slow Latency</option>
                        <option value="flaky">Flaky Gateway</option>
                        <option value="unavailable">Unavailable</option>
                        <option value="response_lost">Response Lost</option>
                        <option value="hard_decline">Hard Decline</option>
                        <option value="soft_decline">Soft Decline</option>
                        <option value="rate_limited">Rate Limited</option>
                        <option value="config_error">Config Error</option>
                      </select>
                    </td>
                    <td className="px-3 text-right font-mono text-on-surface">{(p.smoothed_success_rate * 100).toFixed(1)}%</td>
                    <td className="px-3 text-right font-mono text-on-surface">{p.p95_latency_ms} ms</td>
                    <td className="px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-[72px] h-[5px] bg-surface-container-highest rounded-full overflow-hidden">
                          <div className="h-full bg-primary" style={{ width: `${share}%` }}></div>
                        </div>
                        <span className="font-mono text-[11px] text-on-surface">{share.toFixed(0)}%</span>
                      </div>
                    </td>
                    <td className="px-3 text-right font-mono text-on-surface">{p.cost_bps} bps</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------------------- */}
      {/* D. Telemetry Charts */}
      {/* ------------------------------------------------------------- */}
      <section className="w-full border-b border-outline-variant bg-surface">
        <div className="h-[32px] px-3 border-b border-outline-variant flex items-center justify-between bg-surface-container-lowest">
          <span className="text-[13px] text-on-surface font-semibold">Telemetry</span>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-outline-variant">
          {/* Chart 1: Success Rate */}
          <div className="min-h-[290px] p-3 flex flex-col relative bg-surface">
            <LineChart
              data={telemetryHistory}
              title="Success Rate"
              glowing
              curveType="monotone"
              xDataKey="time"
              yDomain={[0, 100]}
              yUnit="%"
              series={[
                { dataKey: 'stripeSuccess', name: 'Stripe', color: '#EDEDED' },
                { dataKey: 'razorpaySuccess', name: 'Razorpay', color: '#8A8A8A' },
                { dataKey: 'payuSuccess', name: 'PayU', color: '#525252' },
              ]}
            />
          </div>

          {/* Chart 2: Circuit Breaker Timeline */}
          <CircuitBreakerTimeline
            providers={providers}
            telemetryHistory={telemetryHistory}
          />
        </div>
      </section>

      {/* ------------------------------------------------------------- */}
      {/* E. Scenarios */}
      {/* ------------------------------------------------------------- */}
      <section className="w-full border-b border-outline-variant bg-surface">
        <div className="h-[32px] px-3 border-b border-outline-variant flex items-center justify-between bg-surface-container-lowest">
          <span className="text-[13px] text-on-surface font-semibold">Scenarios</span>
          <span className="text-[11px] text-text-secondary">Automated correctness tests</span>
        </div>
        <div className="flex flex-col divide-y divide-outline-variant">
          {scenariosList.map((scen) => {
            const result = localScenarioResults.get(scen.id);
            const isRunning = runningScenario === scen.id;

            return (
              <div key={scen.id} className="h-[32px] px-3 flex items-center justify-between hover:bg-surface-container-low group">
                <div className="flex items-center gap-3 overflow-hidden">
                  <span className="text-[12px] text-on-surface font-medium whitespace-nowrap">{scen.title}</span>
                  <span className="text-[11px] text-text-tertiary truncate hidden md:block">{scen.desc}</span>
                </div>
                
                <div className="flex items-center gap-3 shrink-0 pl-3">
                  {result ? (
                    <span className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded border ${
                      result.verdict === 'PASS'
                        ? 'bg-[rgba(74,222,128,0.08)] border-[rgba(74,222,128,0.3)] text-success'
                        : 'bg-[rgba(248,113,113,0.12)] border-[rgba(248,113,113,0.3)] text-error'
                    }`}>
                      {result.verdict}
                    </span>
                  ) : (
                    <span className="text-[10px] text-text-tertiary font-mono border border-transparent px-1.5 py-0.5">Not run</span>
                  )}
                  
                  <button
                    onClick={() => handleExecuteScenario(scen.id)}
                    disabled={isRunning || allProvidersDisabled}
                    className="min-w-[70px] h-[24px] px-2 flex items-center justify-center gap-1.5 text-[11px] font-medium bg-surface-container-high hover:bg-surface-container-highest border border-outline-variant rounded text-on-surface transition-colors disabled:opacity-50"
                  >
                    {isRunning ? (
                      <>
                        <RefreshCw className="w-3 h-3 animate-spin" />
                        <span>Running</span>
                      </>
                    ) : (
                      'Run'
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
