'use client';

import { useState, type FC } from 'react';
import type { ProviderInfo } from '../types';

function cn(...classes: Array<string | boolean | undefined | null>) {
  return classes.filter(Boolean).join(' ');
}

export const KEYFRAMES = `
@keyframes su-status-pulse { 0%, 100% { opacity: 1; transform: scale(1) } 50% { opacity: 0.35; transform: scale(0.82) } }
@keyframes su-status-bar { from { transform: scaleY(0.15) } to { transform: none } }
@keyframes su-ticker-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
`;

export type ServiceHealth = 'operational' | 'degraded' | 'outage' | 'maintenance';

export const HEALTH_TONE: Record<ServiceHealth, { dot: string; bar: string; label: string; badge: string }> = {
  operational: {
    dot: 'bg-emerald-500',
    bar: 'bg-emerald-500/85 hover:bg-emerald-400',
    label: 'Closed',
    badge: 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10',
  },
  degraded: {
    dot: 'bg-amber-400',
    bar: 'bg-amber-400 hover:bg-amber-300',
    label: 'Half-Open',
    badge: 'border-amber-400/30 text-amber-300 bg-amber-400/10',
  },
  outage: {
    dot: 'bg-red-500',
    bar: 'bg-red-500 hover:bg-red-400',
    label: 'Open',
    badge: 'border-red-500/30 text-red-400 bg-red-500/10',
  },
  maintenance: {
    dot: 'bg-neutral-500',
    bar: 'bg-neutral-600/60 hover:bg-neutral-500',
    label: 'Disabled',
    badge: 'border-neutral-500/30 text-neutral-400 bg-neutral-500/10',
  },
};

export interface TelemetryPoint {
  time: string;
  stripeSuccess?: number;
  razorpaySuccess?: number;
  payuSuccess?: number;
  stripeTraffic?: number;
  razorpayTraffic?: number;
  payuTraffic?: number;
  stripeBreaker?: number;
  razorpayBreaker?: number;
  payuBreaker?: number;
  [key: string]: any;
}

export interface CircuitBreakerTimelineProps {
  providers?: ProviderInfo[];
  telemetryHistory: TelemetryPoint[];
  className?: string;
}

export interface BarSlot {
  time: string;
  state: number;
  health: ServiceHealth;
  isPadded?: boolean;
}

export function getProviderSlots(
  provName: string,
  history: TelemetryPoint[],
  currentBreakerState?: 'closed' | 'open' | 'half_open',
  enabled: boolean = true,
  targetCount: number = 30,
): BarSlot[] {
  const key = `${provName}Breaker`;
  const currentNum = currentBreakerState === 'open' ? 2 : currentBreakerState === 'half_open' ? 1 : 0;

  const points: BarSlot[] = history.map((pt) => {
    const rawVal = pt[key];
    const state = typeof rawVal === 'number' ? rawVal : currentNum;
    let health: ServiceHealth = 'operational';
    if (!enabled) health = 'maintenance';
    else if (state === 2) health = 'outage';
    else if (state === 1) health = 'degraded';
    else health = 'operational';

    return {
      time: pt.time,
      state,
      health,
      isPadded: false,
    };
  });

  const padNeeded = Math.max(0, targetCount - points.length);
  const padding: BarSlot[] = [];
  const defaultHealth: ServiceHealth = enabled
    ? currentNum === 2
      ? 'outage'
      : currentNum === 1
        ? 'degraded'
        : 'operational'
    : 'maintenance';

  for (let i = 0; i < padNeeded; i++) {
    padding.push({
      time: 'Ready',
      state: currentNum,
      health: defaultHealth,
      isPadded: true,
    });
  }

  const combined = [...padding, ...points];
  return combined.slice(combined.length - targetCount);
}

export function calculateUptimePercent(slots: BarSlot[], smoothedRate?: number): string {
  if (slots.length === 0) {
    if (typeof smoothedRate === 'number') return `${Math.round(smoothedRate * 100)}%`;
    return '100.0%';
  }
  const nonOutageSlots = slots.filter((s) => s.state !== 2);
  const ratio = (nonOutageSlots.length / slots.length) * 100;
  return ratio === 100 ? '100%' : `${ratio.toFixed(1)}%`;
}

export function UptimeCard({
  name,
  slots,
  breakerState,
  enabled,
  uptime,
}: {
  name: string;
  slots: BarSlot[];
  breakerState: 'closed' | 'open' | 'half_open';
  enabled: boolean;
  uptime: string;
}) {
  const [hoveredSlot, setHoveredSlot] = useState<BarSlot | null>(null);

  let health: ServiceHealth = 'operational';
  if (!enabled) health = 'maintenance';
  else if (breakerState === 'open') health = 'outage';
  else if (breakerState === 'half_open') health = 'degraded';
  else health = 'operational';

  const tone = HEALTH_TONE[health];
  const isTripped = breakerState === 'open';

  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-lowest/70 p-2.5 px-3 transition-colors hover:border-outline/50 flex flex-col justify-between">
      {/* Top Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="relative grid size-2.5 shrink-0 place-items-center">
            {isTripped && (
              <span
                aria-hidden
                className="absolute inset-0 rounded-full animate-[su-status-pulse_2.4s_ease-in-out_infinite] bg-red-500"
              />
            )}
            <span aria-hidden className={cn('size-1.5 rounded-full', tone.dot)} />
          </span>
          <span className="text-[12px] font-semibold text-on-surface capitalize tracking-wide">{name}</span>
          <span className={cn('text-[9.5px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-wider', tone.badge)}>
            {tone.label}
          </span>
        </div>

        <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-text-secondary">
          <span className="text-on-surface font-medium">{uptime}</span>
          <span className="text-text-tertiary text-[10px]">uptime</span>
        </div>
      </div>

      {/* Segmented Timeline Bars */}
      <div className="my-2">
        <div
          className="flex h-5 w-full items-stretch gap-[2px]"
          onMouseLeave={() => setHoveredSlot(null)}
        >
          {slots.map((slot, index) => {
            const slotTone = HEALTH_TONE[slot.health];
            return (
              <span
                key={index}
                onMouseEnter={() => setHoveredSlot(slot)}
                title={`${name.toUpperCase()} — ${slotTone.label} (${slot.time})`}
                className={cn(
                  'min-w-[2px] flex-1 origin-bottom rounded-[1.5px] transition-transform duration-100 cursor-pointer',
                  'hover:scale-y-125 hover:brightness-125',
                  'animate-[su-status-bar_420ms_cubic-bezier(0.23,1,0.32,1)_backwards] motion-reduce:animate-none',
                  slotTone.bar,
                )}
                style={{ animationDelay: `${index * 12}ms` }}
              />
            );
          })}
        </div>
      </div>

      {/* Footer Subtext */}
      <div className="flex items-center justify-between font-mono text-[9.5px] uppercase tracking-[0.06em] text-text-tertiary">
        <span>{slots.length} samples ago</span>
        <span className="text-text-secondary font-medium">
          {hoveredSlot
            ? `${hoveredSlot.time}: ${HEALTH_TONE[hoveredSlot.health].label}`
            : isTripped
              ? 'Circuit Tripped'
              : breakerState === 'half_open'
                ? 'Probing Recovery'
                : 'Operational'}
        </span>
        <span>Latest</span>
      </div>
    </div>
  );
}

export const CircuitBreakerTimeline: FC<CircuitBreakerTimelineProps> = ({
  providers = [],
  telemetryHistory = [],
  className,
}) => {
  const providerList = ['stripe', 'razorpay', 'payu'];

  // Overall system health
  const openCount = providers.filter((p) => p.breaker_state === 'open').length;
  const halfOpenCount = providers.filter((p) => p.breaker_state === 'half_open').length;

  let overallHealth: ServiceHealth = 'operational';
  let overallLabel = 'All circuit breakers closed';
  if (openCount > 0) {
    overallHealth = 'outage';
    overallLabel = `${openCount} breaker${openCount > 1 ? 's' : ''} tripped (open)`;
  } else if (halfOpenCount > 0) {
    overallHealth = 'degraded';
    overallLabel = `${halfOpenCount} breaker${halfOpenCount > 1 ? 's' : ''} probing (half-open)`;
  }

  const overallTone = HEALTH_TONE[overallHealth];

  return (
    <div className={cn('p-3 flex flex-col justify-between bg-surface min-h-[290px]', className)}>
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />

      {/* Header bar */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-on-surface font-semibold tracking-tight">Circuit Breaker Timeline</span>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/60 bg-surface-container-low px-2 py-0.5">
            <span className="relative grid size-2 shrink-0 place-items-center">
              {overallHealth !== 'operational' && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute inset-0 rounded-full animate-[su-status-pulse_2.4s_ease-in-out_infinite] motion-reduce:animate-none',
                    overallTone.dot,
                  )}
                />
              )}
              <span aria-hidden className={cn('size-1.5 rounded-full', overallTone.dot)} />
            </span>
            <span className="text-[10px] font-mono text-text-secondary">
              {overallLabel}
            </span>
          </div>
        </div>

        {/* Legend */}
        <div className="hidden sm:flex items-center gap-3 text-[10px] font-mono text-text-tertiary">
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-emerald-500" /> Closed
          </span>
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-amber-400" /> Half-Open
          </span>
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-red-500" /> Open
          </span>
        </div>
      </div>

      {/* Provider Timeline Cards */}
      <div className="flex flex-col gap-2 flex-1 justify-between">
        {providerList.map((provName) => {
          const prov = providers.find((p) => p.name.toLowerCase() === provName);
          const breakerState = prov?.breaker_state ?? 'closed';
          const enabled = prov?.enabled ?? true;
          const slots = getProviderSlots(provName, telemetryHistory, breakerState, enabled, 30);
          const uptime = calculateUptimePercent(slots, prov?.smoothed_success_rate);

          return (
            <UptimeCard
              key={provName}
              name={provName}
              slots={slots}
              breakerState={breakerState}
              enabled={enabled}
              uptime={uptime}
            />
          );
        })}
      </div>
    </div>
  );
};

export default CircuitBreakerTimeline;
