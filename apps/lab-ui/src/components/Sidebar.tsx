import { useState } from 'react';
import type { FC } from 'react';
import {
  FlaskConical,
  CreditCard,
  GitCompareArrows,
} from 'lucide-react';

interface SidebarProps {
  currentTab: 'lab' | 'trace' | 'compare';
  onTabChange: (tab: 'lab' | 'trace' | 'compare') => void;
  recentPayments?: Array<{ id: string; status: string; amount: string }>;
  isOpen?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
}

export const Sidebar: FC<SidebarProps> = ({
  currentTab,
  onTabChange,
  recentPayments = [],
  isOpen: controlledIsOpen,
  onOpen,
  onClose,
}) => {
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const isControlled = controlledIsOpen !== undefined;
  const isOpen = isControlled ? controlledIsOpen : internalIsOpen;

  const handleOpen = () => {
    if (onOpen) onOpen();
    else setInternalIsOpen(true);
  };

  const handleClose = () => {
    if (onClose) onClose();
    else setInternalIsOpen(false);
  };

  return (
    <>
      {/* 
        Single narrow strip trigger on the left side pane (only 8px wide).
        Does NOT block or intercept clicks on content at x > 8px.
      */}
      <div
        className="fixed left-0 top-[40px] bottom-[24px] w-[8px] z-40 flex items-center justify-center cursor-pointer group hover:w-[12px] transition-all select-none"
        onMouseEnter={handleOpen}
        onClick={handleOpen}
        title="Hover to open sidebar"
      >
        <div className="w-[3px] h-12 bg-outline-variant group-hover:bg-on-surface group-hover:h-16 rounded-r transition-all duration-150" />
      </div>

      {/* 
        Collapsible Sidebar Drawer:
        When closed: completely off-screen (-translate-x-full) with pointer-events-none so it NEVER blocks content.
        When open: slides in (translate-x-0) with pointer-events-auto over the canvas.
      */}
      <aside
        onMouseEnter={handleOpen}
        onMouseLeave={handleClose}
        className={`fixed left-0 top-[40px] bottom-[24px] w-[216px] z-50 bg-surface border-r border-outline-variant shadow-2xl flex flex-col transform transition-transform duration-200 ease-out backdrop-blur-md select-none ${
          isOpen ? 'translate-x-0 pointer-events-auto' : '-translate-x-full pointer-events-none'
        }`}
      >

        {/* Workspace nav */}
        <div className="p-2 space-y-0.5">
          <div className="text-[11px] font-mono text-text-tertiary uppercase tracking-wider px-2 py-1">
            Workspace
          </div>

          <NavItem
            icon={<FlaskConical className="w-3.5 h-3.5" />}
            label="Routing Lab"
            active={currentTab === 'lab'}
            onClick={() => {
              onTabChange('lab');
              handleClose();
            }}
          />
          <NavItem
            icon={<CreditCard className="w-3.5 h-3.5" />}
            label="Payment Tracer"
            active={currentTab === 'trace'}
            onClick={() => {
              onTabChange('trace');
              handleClose();
            }}
          />
          <NavItem
            icon={<GitCompareArrows className="w-3.5 h-3.5" />}
            label="Compare Policies"
            active={currentTab === 'compare'}
            onClick={() => {
              onTabChange('compare');
              handleClose();
            }}
          />
        </div>

        {/* Divider */}
        <div className="border-b border-outline-variant mx-2" />

        {/* Recent Traces */}
        <div className="p-2 flex-1 overflow-y-auto">
          <div className="text-[11px] font-mono text-text-tertiary uppercase tracking-wider px-2 py-1">
            Recent traces
          </div>
          <div className="space-y-0.5">
            {recentPayments.length > 0 ? (
              recentPayments.slice(0, 8).map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    onTabChange('trace');
                    handleClose();
                  }}
                  className="w-full px-2 h-[28px] rounded flex items-center gap-2 text-[12px] text-text-secondary hover:bg-surface-container hover:text-on-surface transition-colors cursor-pointer group/item"
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      p.status === 'succeeded'
                        ? 'bg-success'
                        : p.status === 'failed'
                        ? 'bg-error'
                        : p.status === 'unknown'
                        ? 'bg-warning'
                        : 'bg-text-secondary'
                    }`}
                  />
                  <span className="font-mono text-[11px] truncate">
                    {p.id.slice(0, 8)}
                  </span>
                  <span className="ml-auto text-[10px] text-text-tertiary font-mono group-hover/item:text-text-secondary">
                    {p.amount}
                  </span>
                </button>
              ))
            ) : (
              <div className="px-2 py-3 text-[11px] text-text-tertiary">
                No recent traces
              </div>
            )}
          </div>
        </div>

        {/* Divider */}
        <div className="border-b border-outline-variant mx-2" />

        {/* Working Active Hotkeys */}
        <div className="p-2 space-y-1">
          <div className="text-[11px] font-mono text-text-tertiary uppercase tracking-wider px-2 py-1">
            Shortcuts
          </div>
          <HotkeyRow keys="1" action="Routing Lab" />
          <HotkeyRow keys="2" action="Payment Tracer" />
          <HotkeyRow keys="3" action="Compare Policies" />
          <HotkeyRow keys="R" action="Refresh data" />
        </div>
      </aside>
    </>
  );
};

/* ── Nav Item ── */
const NavItem: FC<{
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}> = ({ icon, label, active, onClick }) => (
  <button
    onClick={onClick}
    className={`w-full px-2 h-[28px] rounded flex items-center gap-2 text-[12px] transition-colors cursor-pointer ${
      active
        ? 'bg-surface-container-high text-on-surface font-medium'
        : 'text-text-secondary hover:bg-surface-container hover:text-on-surface'
    }`}
  >
    {icon}
    {label}
  </button>
);

/* ── Hotkey Row ── */
const HotkeyRow: FC<{ keys: string; action: string }> = ({ keys, action }) => (
  <div className="flex items-center justify-between px-2 py-0.5">
    <span className="text-[11px] text-text-secondary">{action}</span>
    <kbd className="font-mono text-[10px] text-text-tertiary border border-outline-variant bg-surface-container-lowest px-1.5 py-0.5 rounded">
      {keys}
    </kbd>
  </div>
);
