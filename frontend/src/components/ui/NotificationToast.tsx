/**
 * NotificationToast - Toast notification display component
 * 
 * Renders notifications from the notification store as toasts.
 * Positioned fixed at bottom-right of viewport.
 */
import { useNotificationStore, type Notification } from '@/stores/notificationStore';
import { Button } from './Button';
import './NotificationToast.css';

const ICONS: Record<Notification['type'], string> = {
  success: '✓',
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
};

interface ToastItemProps {
  notification: Notification;
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

export function NotificationToast() {
  const notifications = useNotificationStore((state) => state.notifications);
  const removeNotification = useNotificationStore((state) => state.removeNotification);
  
  if (notifications.length === 0) {
    return null;
  }
  
  return (
    <div className="notification-toast-container">
      {notifications.map((notification) => (
        <ToastItem
          key={notification.id}
          notification={notification}
          onDismiss={removeNotification}
        />
      ))}
    </div>
  );
}

