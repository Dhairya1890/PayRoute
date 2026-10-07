import type { FC } from 'react';

interface StatusBarProps {
  sseConnected: boolean;
  engineVersion?: string;
}

export const StatusBar: FC<StatusBarProps> = ({
  sseConnected,
  engineVersion = '0.1.0',
}) => {
  return (
    <footer className="fixed bottom-0 left-0 right-0 h-[24px] bg-surface-container-lowest border-t border-outline-variant z-50 flex items-center justify-between px-3 select-none text-[11px] font-mono">
      {/* Left: Connection status & engine info */}
      <div className="flex items-center gap-2">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            sseConnected ? 'bg-success' : 'bg-error'
          }`}
        />
        <span className="text-text-secondary">
          {sseConnected ? 'Connected to Engine' : 'Disconnected'}
        </span>
        <span className="text-outline-variant">|</span>
        <span className="text-text-tertiary">
          v{engineVersion}
        </span>
      </div>
    </footer>
  );
};
