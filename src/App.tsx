import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  Cpu,
  FolderGit2,
  Layers,
  Lock,
  Moon,
  Sun,
  Terminal,
  Wallet,
} from 'lucide-react';
import { apiClient, formatCurrency } from './client/api.ts';
import { AuthGate } from './client/components/AuthGate.tsx';
import { FactoryView } from './client/components/FactoryView.tsx';
import { KnowledgeView } from './client/components/KnowledgeView.tsx';
import { LowResourceBudgetView } from './client/components/LowResourceBudgetView.tsx';
import { RegistryView } from './client/components/RegistryView.tsx';
import { RepoView } from './client/components/RepoView.tsx';
import { WorkbenchView } from './client/components/WorkbenchView.tsx';

type ActiveTab = 'workbench' | 'repo' | 'factory' | 'registry' | 'knowledge' | 'budget';

const NAV_ITEMS: Array<{ id: ActiveTab; label: string; icon: React.FC<{ className?: string }> }> = [
  { id: 'workbench', label: 'Coding Workbench', icon: Terminal },
  { id: 'repo', label: 'Repo Intelligence', icon: FolderGit2 },
  { id: 'factory', label: 'Model Factory', icon: Cpu },
  { id: 'registry', label: 'Registry & Evals', icon: Layers },
  { id: 'knowledge', label: 'Knowledge RAG', icon: BookOpen },
  { id: 'budget', label: 'Self-Hosted & VS Code', icon: Wallet },
];

export default function App() {
  const [authStatus, setAuthStatus] = useState<{
    mode: 'env-token' | 'claimed' | 'unclaimed';
    requiresSetup: boolean;
  } | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('workbench');
  const [isDark, setIsDark] = useState(true);
  const [currency, setCurrency] = useState('KES');
  const [rates, setRates] = useState<Record<string, { symbol: string; name: string; perUsd: number }>>({
    USD: { symbol: '$', name: 'US Dollar', perUsd: 1 },
    KES: { symbol: 'KSh', name: 'Kenyan Shilling', perUsd: 129.5 },
  });
  const [budgetData, setBudgetData] = useState<any>(null);
  const [activeBackendLabel, setActiveBackendLabel] = useState<string>('Checking backends...');

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) root.classList.add('dark');
    else root.classList.remove('dark');
  }, [isDark]);

  useEffect(() => {
    apiClient
      .request<{ mode: 'env-token' | 'claimed' | 'unclaimed'; requiresSetup: boolean }>(
        '/api/auth/status'
      )
      .then(setAuthStatus)
      .catch(() => setAuthStatus({ mode: 'unclaimed', requiresSetup: true }));
  }, []);

  const refreshGlobalData = useCallback(async () => {
    if (!authenticated) return;
    try {
      const [usageRes, healthRes] = await Promise.all([
        apiClient.request<{
          budget: any;
          preferredCurrency: string;
          currencies: Record<string, { symbol: string; name: string; perUsd: number }>;
          storage: any;
        }>('/api/usage/budget'),
        apiClient.request<{ inference: { activeDefault: string } }>('/api/health'),
      ]);
      setBudgetData(usageRes);
      setRates(usageRes.currencies);
      setActiveBackendLabel(healthRes.inference.activeDefault);
    } catch {
      // handled per-view if token expired
    }
  }, [authenticated]);

  useEffect(() => {
    refreshGlobalData();
  }, [refreshGlobalData]);

  const handleLogout = async () => {
    await apiClient.request('/api/auth/logout', { method: 'POST' }).catch(() => null);
    apiClient.setToken(null);
    setAuthenticated(false);
    const status = await apiClient.request<{
      mode: 'env-token' | 'claimed' | 'unclaimed';
      requiresSetup: boolean;
    }>('/api/auth/status');
    setAuthStatus(status);
  };

  if (!authStatus) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-sm text-slate-500">
        Initializing Codiz...
      </div>
    );
  }

  if (!authenticated) {
    return (
      <AuthGate
        mode={authStatus.mode}
        onAuthenticated={() => {
          setAuthenticated(true);
        }}
      />
    );
  }

  const activeNav = NAV_ITEMS.find((n) => n.id === activeTab)!;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col lg:flex-row">
      {/* Workspace Sidebar */}
      <aside className="w-full lg:w-64 shrink-0 bg-white dark:bg-slate-900 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 flex flex-col">
        <div className="h-15 px-5 flex items-center border-b border-slate-200 dark:border-slate-800">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
            Codiz
          </span>
        </div>

        <nav className="p-3 flex lg:flex-col gap-1 overflow-x-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="hidden lg:block mt-auto p-4 border-t border-slate-200 dark:border-slate-800 space-y-2 text-xs">
          <div className="text-slate-500 dark:text-slate-400">Active Runtime</div>
          <div className="font-mono text-slate-800 dark:text-slate-200 truncate">
            {activeBackendLabel}
          </div>
          {budgetData?.budget && (
            <div className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
              Spend: {formatCurrency(budgetData.budget.totalSpentUsd, currency, rates)} /{' '}
              {formatCurrency(budgetData.budget.monthlyBudgetUsd, currency, rates)}
            </div>
          )}
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract: Breadcrumb on left, concise controls on right */}
        <header className="h-15 px-6 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-6">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="text-slate-500 dark:text-slate-400 whitespace-nowrap">Codiz</span>
            <span className="text-slate-400" aria-hidden="true">/</span>
            <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
              {activeNav.label}
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <select
              aria-label="Preferred display currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-slate-200"
            >
              {Object.entries(rates).map(([code, info]) => (
                <option key={code} value={code}>
                  {code} ({info.symbol})
                </option>
              ))}
            </select>

            <button
              onClick={() => setIsDark((d) => !d)}
              aria-label="Toggle color theme"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap shrink-0"
            >
              <Lock className="w-3.5 h-3.5" />
              Lock
            </button>
          </div>
        </header>

        {/* Active View Viewport */}
        <main className="flex-1 p-6 overflow-y-auto">
          {activeTab === 'workbench' && (
            <WorkbenchView
              currency={currency}
              rates={rates}
              onBudgetChanged={refreshGlobalData}
            />
          )}
          {activeTab === 'repo' && <RepoView />}
          {activeTab === 'factory' && (
            <FactoryView
              currency={currency}
              rates={rates}
              onBudgetChanged={refreshGlobalData}
            />
          )}
          {activeTab === 'registry' && <RegistryView />}
          {activeTab === 'knowledge' && <KnowledgeView />}
          {activeTab === 'budget' && (
            <LowResourceBudgetView
              currency={currency}
              rates={rates}
              budgetData={budgetData}
            />
          )}
        </main>
      </div>
    </div>
  );
}
