import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface SubsystemErrorBoundaryProps {
  /** Human-readable name shown in the error UI, e.g. "Office View" */
  name: string;
  /** When this value changes, the error state is automatically cleared */
  resetKey?: string;
  /** Optional custom fallback; receives error and reset callback */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  children: ReactNode;
}

interface SubsystemErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Lightweight error boundary for individual subsystems (Pixi.js canvas,
 * React Flow graph, live task view, etc.). Catches render errors without
 * taking down the entire application.
 */
export class SubsystemErrorBoundary extends Component<SubsystemErrorBoundaryProps, SubsystemErrorBoundaryState> {
  constructor(props: SubsystemErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): SubsystemErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidUpdate(prevProps: SubsystemErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[SubsystemErrorBoundary:${this.props.name}] Uncaught error:`, error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleReset);
      }

      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            minHeight: 120,
            background: "var(--bg-base, #0a0a14)",
            color: "var(--text-muted, #94a3b8)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "0.75rem",
            padding: "1rem",
            textAlign: "center",
            gap: "0.5rem",
          }}
        >
          <span style={{ color: "var(--text-primary, #e2e8f0)", fontWeight: 600, fontSize: "0.8125rem" }}>
            {this.props.name} crashed
          </span>
          <span style={{ maxWidth: 400, lineHeight: 1.4 }}>{this.state.error.message}</span>
          <button
            onClick={this.handleReset}
            style={{
              marginTop: "0.25rem",
              padding: "0.3rem 1rem",
              background: "var(--accent, #6366f1)",
              color: "#fff",
              border: "none",
              borderRadius: "0.25rem",
              cursor: "pointer",
              fontSize: "0.75rem",
              fontFamily: "'Press Start 2P', monospace",
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
