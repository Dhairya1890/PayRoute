'use client';

import * as React from 'react';
import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

function cn(...classes: Array<string | boolean | undefined | null>) {
  return classes.filter(Boolean).join(' ');
}

export type LineCurve = 'monotone' | 'bump' | 'step' | 'linear';
export type StrokeVariant = 'solid' | 'dashed' | 'animated-dashed';

export function strokeDasharray(variant?: StrokeVariant): string | undefined {
  if (variant === 'dashed' || variant === 'animated-dashed') return '4 4';
  return undefined;
}

export function useChartId(prefix: string = 'chart') {
  const reactId = React.useId();
  return `${prefix}-${reactId.replace(/[:]/g, '')}`;
}

export function useChartMotion() {
  const [reduce, setReduce] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduce(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduce(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return { reduce };
}

export function useIntroStartedAt() {
  const [startedAt] = React.useState(() => Date.now());
  return startedAt;
}

export function ChartGlowFilter({ id }: { id: string }) {
  return (
    <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="2.5" result="glow" />
      <feMerge>
        <feMergeNode in="glow" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  );
}

export function AnimatedDashedStroke() {
  return (
    <style>{`
      @keyframes chartDash {
        to { stroke-dashoffset: -16; }
      }
      .animated-dashed-line path {
        animation: chartDash 1.2s linear infinite;
      }
    `}</style>
  );
}

export function RevealMask({
  id,
  reduce,
}: {
  id: string;
  introStartedAt?: number;
  reduce?: boolean;
}) {
  if (reduce) return null;
  return (
    <mask id={id}>
      <rect x="0" y="0" width="100%" height="100%" fill="white">
        <animate
          attributeName="width"
          from="0%"
          to="100%"
          dur="0.8s"
          begin="0s"
          fill="freeze"
          calcMode="spline"
          keySplines="0.25 0.1 0.25 1"
        />
      </rect>
    </mask>
  );
}

export interface ChartDotRenderProps {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: any;
  value?: number;
  [key: string]: any;
}

export function ChartActiveDot({ cx, cy, color }: { cx?: number; cy?: number; color: string }) {
  if (typeof cx !== 'number' || typeof cy !== 'number') return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={6} fill={color} fillOpacity={0.25} />
      <circle cx={cx} cy={cy} r={3.5} fill={color} stroke="#131313" strokeWidth={1.5} />
    </g>
  );
}

export function ChartRestingDot({
  cx,
  cy,
  color,
  maskId,
}: {
  cx?: number;
  cy?: number;
  color: string;
  maskId?: string;
}) {
  if (typeof cx !== 'number' || typeof cy !== 'number') return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={2}
      fill={color}
      stroke="#131313"
      strokeWidth={1}
      mask={maskId ? `url(#${maskId})` : undefined}
    />
  );
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  yUnit = '%',
}: any) {
  if (!active || !payload || !payload.length) return null;

  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-lowest/95 backdrop-blur-md px-3 py-2 shadow-xl text-[11px] font-mono select-none">
      <div className="text-[10px] text-text-tertiary mb-1.5 border-b border-outline-variant/40 pb-1 flex items-center justify-between gap-4">
        <span>TIME</span>
        <span className="text-on-surface">{label}</span>
      </div>
      <div className="flex flex-col gap-1">
        {payload.map((item: any, idx: number) => (
          <div key={idx} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-text-secondary">
              <span className="size-1.5 rounded-full" style={{ backgroundColor: item.color }} />
              {item.name}
            </span>
            <span className="font-semibold text-on-surface">
              {item.value !== undefined ? `${item.value}${yUnit}` : 'N/A'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChartLegend({
  series,
}: {
  series: Array<{ name: string; color: string }>;
}) {
  return (
    <div className="flex items-center gap-3 text-[10px] font-mono text-text-tertiary">
      {series.map((s) => (
        <span key={s.name} className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full" style={{ backgroundColor: s.color }} />
          <span>{s.name}</span>
        </span>
      ))}
    </div>
  );
}

export function ChartLoadingBars() {
  return (
    <div className="w-full h-full flex items-center justify-center gap-1.5 animate-pulse text-text-tertiary text-[11px] font-mono">
      <span>Waiting for telemetry samples...</span>
    </div>
  );
}

export function ChartFrame({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('relative w-full h-full flex flex-col', className)}>{children}</div>;
}

export function ChartPlotSurface({ children }: { children: React.ReactNode }) {
  return <div className="relative flex-1 w-full min-h-0">{children}</div>;
}

export const chartGrid = {
  strokeDasharray: '2 2',
  stroke: '#444748',
  strokeOpacity: 0.5,
  vertical: false,
};

export const chartXAxis = {
  stroke: '#707070',
  fontSize: 10,
  tickLine: false,
  axisLine: { stroke: '#444748', strokeOpacity: 0.6 },
};

export const chartYAxis = {
  stroke: '#707070',
  fontSize: 10,
  tickLine: false,
  axisLine: false,
};

export interface ChartSeriesConfig {
  dataKey: string;
  name: string;
  color: string;
  strokeVariant?: StrokeVariant;
}

export const DEFAULT_SERIES: ChartSeriesConfig[] = [
  { dataKey: 'stripeSuccess', name: 'Stripe', color: '#EDEDED' },
  { dataKey: 'razorpaySuccess', name: 'Razorpay', color: '#8A8A8A' },
  { dataKey: 'payuSuccess', name: 'PayU', color: '#525252' },
];

export interface SpectrumLineChartProps {
  className?: string;
  title?: string;
  data?: any[];
  curveType?: LineCurve;
  strokeVariant?: StrokeVariant;
  desktopStroke?: StrokeVariant;
  mobileStroke?: StrokeVariant;
  glowing?: boolean;
  gradientStroke?: boolean;
  isLoading?: boolean;
  showLegend?: boolean;
  showDots?: boolean;
  series?: ChartSeriesConfig[];
  xDataKey?: string;
  yUnit?: string;
  yDomain?: [number, number];
}

export function LineChart({
  className,
  title = 'Success Rate',
  data = [],
  curveType = 'monotone',
  strokeVariant = 'solid',
  glowing = true,
  gradientStroke = false,
  isLoading = false,
  showLegend = true,
  showDots = false,
  series = DEFAULT_SERIES,
  xDataKey = 'time',
  yUnit = '%',
  yDomain = [0, 100],
}: SpectrumLineChartProps) {
  const id = useChartId('line');
  const { reduce } = useChartMotion();
  const introStartedAt = useIntroStartedAt();
  const glowId = `${id}-glow`;
  const maskId = `${id}-reveal`;
  const maskStyle = reduce ? undefined : { mask: `url(#${maskId})` };

  return (
    <ChartFrame className={cn('flex flex-col h-full', className)}>
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-[12px] text-on-surface font-semibold tracking-tight">{title}</span>
        {showLegend && <ChartLegend series={series} />}
      </div>

      {isLoading || data.length === 0 ? (
        <ChartLoadingBars />
      ) : (
        <ChartPlotSurface>
          <ResponsiveContainer width="100%" height="100%">
            <RechartsLineChart data={data} margin={{ top: 8, right: 8, left: -25, bottom: 0 }}>
              <defs>
                {gradientStroke && series.length >= 2 ? (
                  <linearGradient id={`${id}-gradient-stroke`} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor={series[0].color} />
                    <stop offset="100%" stopColor={series[1].color} />
                  </linearGradient>
                ) : null}
                {glowing ? <ChartGlowFilter id={glowId} /> : null}
                <RevealMask id={maskId} introStartedAt={introStartedAt} reduce={reduce} />
              </defs>
              <CartesianGrid {...chartGrid} />
              <XAxis {...chartXAxis} dataKey={xDataKey} />
              <YAxis {...chartYAxis} domain={yDomain} unit={yUnit} />
              <Tooltip
                cursor={{ stroke: '#8e9192', strokeOpacity: 0.3, strokeDasharray: '4 4' }}
                content={<ChartTooltipContent yUnit={yUnit} />}
              />
              {series.map((s) => {
                const kind = s.strokeVariant ?? strokeVariant;
                const lineColor = gradientStroke ? `url(#${id}-gradient-stroke)` : s.color;

                return (
                  <Line
                    key={s.dataKey}
                    type={curveType}
                    dataKey={s.dataKey}
                    name={s.name}
                    stroke={lineColor}
                    strokeWidth={1.75}
                    strokeDasharray={strokeDasharray(kind)}
                    dot={
                      showDots
                        ? (props: ChartDotRenderProps) => (
                            <ChartRestingDot
                              key={`dot-${props.index}`}
                              cx={props.cx}
                              cy={props.cy}
                              color={s.color}
                              maskId={reduce ? undefined : maskId}
                            />
                          )
                        : false
                    }
                    activeDot={(props: ChartDotRenderProps) => (
                      <ChartActiveDot
                        key={`active-${props.index}`}
                        cx={props.cx}
                        cy={props.cy}
                        color={s.color}
                      />
                    )}
                    isAnimationActive={false}
                    filter={glowing ? `url(#${glowId})` : undefined}
                    style={maskStyle}
                    className={kind === 'animated-dashed' ? 'animated-dashed-line' : undefined}
                  >
                    {kind === 'animated-dashed' ? <AnimatedDashedStroke /> : null}
                  </Line>
                );
              })}
            </RechartsLineChart>
          </ResponsiveContainer>
        </ChartPlotSurface>
      )}
    </ChartFrame>
  );
}

export function DefaultLineChart(props: SpectrumLineChartProps) {
  return <LineChart {...props} />;
}

export function DashedLineChart(props: SpectrumLineChartProps) {
  return <LineChart strokeVariant="animated-dashed" {...props} />;
}

export function BumpLineChart(props: SpectrumLineChartProps) {
  return <LineChart curveType="bump" {...props} />;
}

export function StepLineChart(props: SpectrumLineChartProps) {
  return <LineChart curveType="step" {...props} />;
}

export function GlowingLineChart(props: SpectrumLineChartProps) {
  return <LineChart glowing {...props} />;
}

export function GradientLineChart(props: SpectrumLineChartProps) {
  return <LineChart gradientStroke {...props} />;
}

export default LineChart;
