import { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { ChatBot } from './components/ChatBot';
import { LabPage } from './pages/LabPage';
import { PaymentTracePage } from './pages/PaymentTracePage';
import { ComparePage } from './pages/ComparePage';
import {
  fetchProviders,
  fetchSettings,
  updateSettings,
  subscribeToLabStream,
  fetchLatestScoreboard,
  fetchPayments,
} from './api';
import type { ProviderInfo, ScoreboardData, ScenarioResult } from './types';

export function App() {
  const [currentTab, setCurrentTab] = useState<'lab' | 'trace' | 'compare'>('lab');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const sidebarTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleOpenSidebar = () => {
    if (sidebarTimeoutRef.current) {
      clearTimeout(sidebarTimeoutRef.current);
      sidebarTimeoutRef.current = null;
    }
    setIsSidebarOpen(true);
  };

  const handleCloseSidebar = () => {
    if (sidebarTimeoutRef.current) {
      clearTimeout(sidebarTimeoutRef.current);
    }
    sidebarTimeoutRef.current = setTimeout(() => {
      setIsSidebarOpen(false);
    }, 150);
  };

  const handleToggleSidebar = () => {
    setIsSidebarOpen((prev) => !prev);
  };

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [scoreboard, setScoreboard] = useState<ScoreboardData | null>(null);
  const [scenarioResults, setScenarioResults] = useState<Map<string, ScenarioResult>>(new Map());
  const [recentPayments, setRecentPayments] = useState<Array<{ id: string; status: string; amount: string }>>([]);
  const [policy, setPolicy] = useState<string>('full');
  const [strategy, setStrategy] = useState<string>('lowest_cost');
  const [sseConnected, setSseConnected] = useState<boolean>(false);

  const loadData = async () => {
    try {
      const p = await fetchProviders();
      setProviders(p);

      const s = await fetchSettings();
      if (s.policy) setPolicy(s.policy as string);
      if (s.strategy) setStrategy(s.strategy as string);

      const sb = await fetchLatestScoreboard();
      if (sb) setScoreboard(sb);

      const payments = await fetchPayments({ limit: 8 });
      setRecentPayments(
        payments.map((pay) => ({
          id: pay.id,
          status: pay.status,
          amount: `${(Number(pay.amount_minor) / 100).toFixed(0)} ${pay.currency}`,
        }))
      );
    } catch (err) {
      console.error('Failed to load initial data:', err);
    }
  };

  useEffect(() => {
    loadData();

    // Global Working Keyboard Shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInput =
        activeEl &&
        (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT' || activeEl.tagName === 'TEXTAREA');
      if (isInput) return;

      if (e.key === '1') setCurrentTab('lab');
      else if (e.key === '2') setCurrentTab('trace');
      else if (e.key === '3') setCurrentTab('compare');
      else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        loadData();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    const unsubscribe = subscribeToLabStream((event) => {
      if (event.type === 'connected') {
        setSseConnected(true);
      } else if (event.type === 'error') {
        setSseConnected(false);
      } else if (event.type === 'payment_completed') {
        fetchProviders().then(setProviders).catch(() => {});
        // Refresh recent payments when a transaction completes
        fetchPayments({ limit: 8 })
          .then((pays) =>
            setRecentPayments(
              pays.map((pay) => ({
                id: pay.id,
                status: pay.status,
                amount: `${(Number(pay.amount_minor) / 100).toFixed(0)} ${pay.currency}`,
              }))
            )
          )
          .catch(() => {});
      } else if (event.type === 'scoreboard_update') {
        setScoreboard(event.data.scoreboard);
      } else if (event.type === 'breaker_transition') {
        fetchProviders().then(setProviders).catch(() => {});
      } else if (event.type === 'scenario_verdict') {
        setScenarioResults((prev) => {
          const next = new Map(prev);
          next.set(event.data.scenario, event.data);
          return next;
        });
      }
    });

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      unsubscribe();
    };
  }, []);

  const handlePolicyChange = async (newPolicy: string) => {
    setPolicy(newPolicy);
    try {
      await updateSettings({ policy: newPolicy });
    } catch (err) {
      console.error('Failed to update policy:', err);
    }
  };

  const handleStrategyChange = async (newStrategy: string) => {
    setStrategy(newStrategy);
    try {
      await updateSettings({ strategy: newStrategy });
    } catch (err) {
      console.error('Failed to update strategy:', err);
    }
  };

  return (
    <div className="min-h-screen bg-background text-on-surface font-sans antialiased">
      {/* Fixed Shell Components */}
      <Header
        currentTab={currentTab}
        onTabChange={setCurrentTab}
        policy={policy}
        strategy={strategy}
        onPolicyChange={handlePolicyChange}
        onStrategyChange={handleStrategyChange}
        sseConnected={sseConnected}
        onLogoMouseEnter={handleOpenSidebar}
        onLogoMouseLeave={handleCloseSidebar}
        onLogoClick={handleToggleSidebar}
      />

      <Sidebar
        currentTab={currentTab}
        onTabChange={setCurrentTab}
        recentPayments={recentPayments}
        isOpen={isSidebarOpen}
        onOpen={handleOpenSidebar}
        onClose={handleCloseSidebar}
      />

      <StatusBar sseConnected={sseConnected} />

      {/* Main Canvas - full bleed responsive width */}
      <main className="pl-4 pr-4 pb-[24px] pt-[76px] min-h-screen bg-surface-container-lowest">
        <div className="py-2 max-w-full">
          {currentTab === 'lab' && (
            <LabPage
              providers={providers}
              scoreboard={scoreboard}
              onRefresh={loadData}
              scenarioResults={scenarioResults}
            />
          )}

          {currentTab === 'trace' && <PaymentTracePage />}

          {currentTab === 'compare' && <ComparePage />}
        </div>
      </main>

      {/* PayRoute AI ChatBot Assistant (Floating bottom-right rounded popup) */}
      <ChatBot />
    </div>
  );
}

export default App;
