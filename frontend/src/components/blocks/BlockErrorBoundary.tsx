import { Component } from 'react';
import type { ReactNode } from 'react';
import './BlockErrorBoundary.css';

interface Props {
  children: ReactNode;
  blockId: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class BlockErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`Block ${this.props.blockId} error:`, error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="block-error">
          <span className="block-error-icon">⚠️</span>
          <span className="block-error-message">Error rendering block</span>
          <button 
            className="block-error-retry" 
            onClick={() => this.setState({ hasError: false })}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
