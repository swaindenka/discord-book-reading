import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SessionProvider } from './session';
import { ToastProvider } from './components/Toasts';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <SessionProvider>
        <ErrorBoundary
          fallback={() => (
            <div className="center-screen">
              <div className="card narrow">
                <h1>Something went wrong</h1>
                <p className="muted">The page hit an unexpected error. Reloading usually fixes it.</p>
                <button className="btn primary" onClick={() => window.location.reload()}>
                  Reload
                </button>
              </div>
            </div>
          )}
        >
          <App />
        </ErrorBoundary>
      </SessionProvider>
    </ToastProvider>
  </StrictMode>,
);
