/**
 * ErrorBoundary - React error boundary for graceful error handling
 * 
 * Catches JavaScript errors anywhere in child component tree and displays
 * a fallback UI instead of crashing the whole app.
 * 
 * Usage:
 * ```tsx
 * <ErrorBoundary fallback={<ErrorFallback />}>
 *   <ComponentThatMightError />
 * </ErrorBoundary>
 * ```
 * 
 * Or with the HOC:
 * ```tsx
 * const SafeComponent = withErrorBoundary(MyComponent, { fallback: <ErrorFallback /> });
 * ```
 */
import { Component, type ReactNode, type ErrorInfo } from 'react';
import { Button } from './Button';
import { Card } from './Card';
import './ErrorBoundary.css';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Custom fallback UI to show when an error occurs */
  fallback?: ReactNode;
  /** Called when an error is caught */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** If true, shows a retry button that resets the error state */
  showRetry?: boolean;
  /** Context name for error reporting (e.g., "NodeView", "BlockEditor") */
  context?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Default error fallback component
 */
function DefaultErrorFallback({ 
  error, 
  context,
  onRetry 
}: { 
  error: Error | null; 
  context?: string;
  onRetry?: () => void;
}) {
  return (
    <Card className="error-boundary-fallback" elevation="low">
      <div className="error-boundary-fallback__icon">⚠️</div>
      <div className="error-boundary-fallback__content">
        <h3 className="error-boundary-fallback__title">
          Something went wrong{context ? ` in ${context}` : ''}
        </h3>
        <p className="error-boundary-fallback__message">
          {error?.message || 'An unexpected error occurred'}
        </p>
        {onRetry && (
          <Button 
            variant="default" 
            size="sm" 
            onClick={onRetry}
            className="error-boundary-fallback__retry"
          >
            Try again
          </Button>
        )}
      </div>
    </Card>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    
    // Call optional error handler
    this.props.onError?.(error, errorInfo);
    
    // Log error for debugging
    console.error('[ErrorBoundary] Caught error:', {
      context: this.props.context,
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      // Custom fallback takes precedence
      if (this.props.fallback) {
        return this.props.fallback;
      }
      
      // Default fallback
      return (
        <DefaultErrorFallback
          error={this.state.error}
          context={this.props.context}
          onRetry={this.props.showRetry !== false ? this.handleRetry : undefined}
        />
      );
    }

    return this.props.children;
  }
}

