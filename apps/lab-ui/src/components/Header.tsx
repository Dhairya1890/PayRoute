import type { FC } from 'react';
import { ChevronDown } from 'lucide-react';

interface HeaderProps {
  currentTab: 'lab' | 'trace' | 'compare';
  onTabChange: (tab: 'lab' | 'trace' | 'compare') => void;
  policy: string;
  strategy: string;
  onPolicyChange: (policy: string) => void;
  onStrategyChange: (strategy: string) => void;
  sseConnected: boolean;
  onLogoMouseEnter?: () => void;
  onLogoMouseLeave?: () => void;
  onLogoClick?: () => void;
}

export const Header: FC<HeaderProps> = ({
  currentTab,
  onTabChange,
  policy,
  strategy,
  onPolicyChange,
  onStrategyChange,
  sseConnected,
  onLogoMouseEnter,
  onLogoMouseLeave,
  onLogoClick,
}) => {
  return (
    <>
      {/* ── Top Header Bar (40px) ── */}
      <header className="fixed top-0 left-0 right-0 h-[40px] z-50 bg-surface border-b border-outline-variant flex items-center justify-between px-3 select-none">
        {/* Left: Logo + Environment Badge */}
        <div className="flex items-center gap-3">
          {/* Logo */}
          <div
            className="flex items-center gap-2 cursor-pointer py-1 px-1 -ml-1 rounded hover:bg-surface-container-high transition-colors"
            onMouseEnter={onLogoMouseEnter}
            onMouseLeave={onLogoMouseLeave}
            onClick={onLogoClick}
            title="Sidebar navigation"
          >
            <div className="w-4 h-4 bg-primary rounded flex items-center justify-center">
              <div className="w-2 h-2 bg-surface rounded-[1px]" />
            </div>
            <span className="text-[14px] font-semibold text-on-surface">PayRoute</span>
          </div>

          {/* Environment Badge */}
          <div className="group relative">
            <div className="flex items-center gap-1.5 px-2 py-0.5 bg-surface-container border border-outline-variant rounded cursor-default">
              <span className="w-1.5 h-1.5 rounded-full bg-warning" />
              <span className="text-[11px] font-mono text-text-secondary">lab</span>
              <ChevronDown className="w-3 h-3 text-text-secondary" />
            </div>
            {/* Tooltip */}
            <div className="hidden group-hover:flex absolute top-full left-0 mt-1 w-64 p-2 bg-surface-container-high border border-outline-variant shadow-lg rounded text-[11px] leading-tight text-text-secondary z-50">
              <div>
                <span className="text-warning font-medium">PROVIDER_TARGET=lab</span>
                <p className="mt-1 text-text-tertiary">
                  Controlled-failure simulation environment. Provider calls go to local Provider Lab servers, not real payment gateways.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Policy & Strategy Configuration Selects */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono text-text-tertiary">Policy:</span>
            <select
              value={policy}
              onChange={(e) => onPolicyChange(e.target.value)}
              className="h-[24px] text-[11px] font-mono"
            >
              <option value="full">full</option>
              <option value="baseline">baseline</option>
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono text-text-tertiary">Strategy:</span>
            <select
              value={strategy}
              onChange={(e) => onStrategyChange(e.target.value)}
              className="h-[24px] text-[11px] font-mono"
            >
              <option value="weighted">weighted</option>
              <option value="lowest_cost">lowest_cost</option>
              <option value="priority">priority</option>
            </select>
          </div>
        </div>
      </header>

      {/* ── Tab Strip (36px) ── */}
      <div className="fixed top-[40px] left-0 right-0 h-[36px] z-30 bg-surface-container-lowest border-b border-outline-variant flex items-end px-3 select-none pl-6">
        <TabButton
          active={currentTab === 'lab'}
          onClick={() => onTabChange('lab')}
          label="Routing Lab"
          dotColor={sseConnected ? 'bg-success' : undefined}
        />
        <TabButton
          active={currentTab === 'trace'}
          onClick={() => onTabChange('trace')}
          label="Payment Tracer"
        />
        <TabButton
          active={currentTab === 'compare'}
          onClick={() => onTabChange('compare')}
          label="Compare Policies"
        />
      </div>
    </>
  );
};

/* ── Tab Button ── */
const TabButton: FC<{
  active: boolean;
  onClick: () => void;
  label: string;
  dotColor?: string;
}> = ({ active, onClick, label, dotColor }) => (
  <button
    onClick={onClick}
    className={`h-[28px] px-3 rounded-t text-[12px] font-mono flex items-center gap-1.5 transition-colors cursor-pointer ${
      active
        ? 'border-t border-x border-b-transparent border-outline-variant bg-surface text-on-surface'
        : 'border border-transparent text-text-secondary hover:text-on-surface'
    }`}
  >
    {dotColor && <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />}
    {label}
  </button>
);
