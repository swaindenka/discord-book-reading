import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AppConfig, PublicUser } from '../../shared/types';
import { api } from './api';
import { disconnectSocket } from './socket';

interface Session {
  config: AppConfig;
  user: PublicUser | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [user, setUser] = useState<PublicUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setUser((await api.me()).user);
  }, []);

  useEffect(() => {
    Promise.all([api.config(), refresh()])
      .then(([cfg]) => setConfig(cfg))
      .catch(() => setError('Could not reach the server. It may be waking up — try again in a minute.'));
  }, [refresh]);

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    disconnectSocket();
    setUser(null);
  }, []);

  if (error) {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <h1>Connection problem</h1>
          <p className="muted">{error}</p>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!config) {
    return (
      <div className="center-screen">
        <span className="spinner" aria-label="Loading" />
      </div>
    );
  }
  return <SessionContext.Provider value={{ config, user, refresh, logout }}>{children}</SessionContext.Provider>;
}
