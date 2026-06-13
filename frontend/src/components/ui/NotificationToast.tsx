/**
 * NotificationToast - Presentational toast notification display component
 *
 * Receives notifications and a dismiss callback via props. The store connection
 * lives in a feature-level wrapper so UI atoms stay domain-agnostic.
 */
import { Button } from './Button';
import './NotificationToast.css';

export interface ToastNotification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string;
  dismissible?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface NotificationToastProps {
  notifications: ToastNotification[];
  onDismiss: (id: string) => void;
}

const ICONS: Record<ToastNotification['type'], string> = {
  success: '✓',
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
};

interface ToastItemProps {
  notification: ToastNotification;
  onDismiss: (id: string) => void;
}

function ToastItem({ notification, onDismiss }: ToastItemProps) {
  return (
    <div className={`notification-toast notification-toast--${notification.type}`}>
      <span className="notification-toast__icon">
        {ICONS[notification.type]}
      </span>
      <div className="notification-toast__content">
        <div className="notification-toast__title">{notification.title}</div>
        {notification.message && (
          <div className="notification-toast__message">{notification.message}</div>
        )}
        {notification.action && (
          <Button
            variant="ghost"
            size="sm"
            onClick={notification.action.onClick}
            className="notification-toast__action"
          >
            {notification.action.label}
          </Button>
        )}
      </div>
      {notification.dismissible && (
        <Button
          variant="ghost"
          size="xs"
          icon="mdi mdi-close"
          className="notification-toast__dismiss"
          onClick={() => onDismiss(notification.id)}
          aria-label="Dismiss"
        />
      )}
    </div>
  );
}

export function NotificationToast({ notifications, onDismiss }: NotificationToastProps) {
  return (
    <div role="status" aria-live="polite" aria-atomic="false">
      <div className="notification-toast-container">
        {notifications.map((notification) => (
          <ToastItem
            key={notification.id}
            notification={notification}
            onDismiss={onDismiss}
          />
        ))}
      </div>
    </div>
  );
}
