/**
 * ErrorRenderer Component
 * 
 * Renders error states for broken assets:
 * - Missing file → red "Asset missing" block
 * - Broken MIME → generic renderer with warning
 * - Permission error → locked state
 * - Invariant violation → technical error
 */
import { Card } from '../../core/Card';
import './ErrorRenderer.css';

interface ErrorRendererProps {
  /** Error status */
  status: 'missing' | 'broken_mime' | 'permission_error' | 'invariant_violation';
  /** Error message */
  error: string;
  /** Optional warning message */
  warning?: string;
  /** Asset UUID */
  uuid: string;
  /** Block title */
  title: string;
}

export function ErrorRenderer({
  status,
  error,
  warning,
  uuid,
  title,
}: ErrorRendererProps) {
  // Determine visual styling based on error type
  const getStatusConfig = () => {
    switch (status) {
      case 'missing':
        return {
          icon: '❌',
          title: 'Asset Missing',
          color: 'error',
          message: 'The file for this asset could not be found.',
        };
      case 'broken_mime':
        return {
          icon: '⚠️',
          title: 'Unknown File Type',
          color: 'warning',
          message: 'Cannot determine how to display this file.',
        };
      case 'permission_error':
        return {
          icon: '🔒',
          title: 'Access Denied',
          color: 'error',
          message: 'You do not have permission to access this file.',
        };
      case 'invariant_violation':
        return {
          icon: '⛔',
          title: 'Asset Corrupted',
          color: 'error',
          message: 'This asset is in an invalid state.',
        };
      default:
        return {
          icon: '❓',
          title: 'Unknown Error',
          color: 'error',
          message: 'An unknown error occurred.',
        };
    }
  };
  
  const config = getStatusConfig();
  
  return (
    <div className="error-renderer">
      <Card
        className={`error-renderer__card error-renderer__card--${config.color}`}
        padding={true}
        radius="md"
        elevation="low"
      >
        <div className="error-renderer__content">
          {/* Icon */}
          <div className="error-renderer__icon">
            {config.icon}
          </div>
          
          {/* Info */}
          <div className="error-renderer__info">
            <div className="error-renderer__status-title">
              {config.title}
            </div>
            <div className="error-renderer__message">
              {config.message}
            </div>
            {warning && (
              <div className="error-renderer__warning">
                {warning}
              </div>
            )}
            <div className="error-renderer__details">
              <code>{error}</code>
            </div>
          </div>
        </div>
        
        {/* Asset info */}
        <div className="error-renderer__meta">
          <div className="error-renderer__title">
            {title || 'Untitled'}
          </div>
          <div className="error-renderer__uuid">
            UUID: <code>{uuid}</code>
          </div>
        </div>
      </Card>
    </div>
  );
}
