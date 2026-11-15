import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Catches a crash in part of the page so the rest keeps working. */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: (reset: () => void, error: Error) => ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] crashed:', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  override render() {
    return this.state.error ? this.props.fallback(this.reset, this.state.error) : this.props.children;
  }
}
