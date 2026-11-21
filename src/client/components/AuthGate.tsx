import React, { useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { apiClient } from '../api.ts';

interface AuthGateProps {
  mode: 'env-token' | 'claimed' | 'unclaimed';
  onAuthenticated: (token: string) => void;
}

export const AuthGate: React.FC<AuthGateProps> = ({ mode, onAuthenticated }) => {
  const [passphrase, setPassphrase] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBootstrap = mode === 'unclaimed';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isBootstrap && passphrase !== confirmPass) {
      setError('Passphrases do not match.');
      return;
    }

    setLoading(true);
    try {
      const endpoint = isBootstrap ? '/api/auth/bootstrap' : '/api/auth/login';
      const res = await apiClient.request<{ token: string }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ passphrase }),
      });
      apiClient.setToken(res.token);
      onAuthenticated(res.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-emerald-600/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
            {isBootstrap ? <ShieldCheck className="w-5 h-5" /> : <KeyRound className="w-5 h-5" />}
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
              {isBootstrap ? 'Initialize Codiz Workspace' : 'Unlock Codiz Workspace'}
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Low-resource personal coding intelligence
            </p>
          </div>
        </div>

        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed mb-6">
          {isBootstrap
            ? 'Set a personal workspace passphrase. It is hashed with scrypt on the server and protects your repository index, model registry, and budget controls.'
            : mode === 'env-token'
              ? 'Enter your configured CODIZ_API_TOKEN to unlock this workspace.'
              : 'Enter your personal Codiz workspace passphrase to resume your session.'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              {mode === 'env-token' ? 'API Token' : 'Workspace Passphrase (min 6 characters)'}
            </label>
            <input
              type="password"
              required
              minLength={6}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Enter passphrase"
              className="w-full px-3.5 py-2.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          {isBootstrap && (
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Confirm Passphrase
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={confirmPass}
                onChange={(e) => setConfirmPass(e.target.value)}
                placeholder="Confirm passphrase"
                className="w-full px-3.5 py-2.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-sm font-medium transition-colors"
          >
            {loading
              ? 'Verifying...'
              : isBootstrap
                ? 'Claim Passphrase & Open Codiz'
                : 'Unlock Workbench'}
          </button>
        </form>
      </div>
    </div>
  );
};
