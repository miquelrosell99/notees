/**
 * NotificationToast - Presentational toast notification display component
 *
 * Receives notifications and a dismiss callback via props. The store connection
 * lives in a feature-level wrapper so UI atoms stay domain-agnostic.
 *
 * Two exceptions reach the global notification store directly:
 * - hover/focus pausing of the auto-dismiss countdown (the timers live in the
 *   store, and the wrapper cannot intercept them);
 * - toasts removed from the store are kept mounted briefly so their exit
 *   transition can play.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';
import { useNotificationStore } from '@/stores/notificationStore';
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
  success: 'mdi-check',
  error: 'mdi-close',
  warning: 'mdi-alert-outline',
  info: 'mdi-information-outline',
};

/** Keep in sync with the exit transition in NotificationToast.css. */
const EXIT_TRANSITION_MS = 200;

interface ToastItemProps {
  notification: ToastNotification;
  exiting?: boolean;
  onDismiss: (id: string) => void;
}

function ToastItem({ notification, exiting = false, onDismiss }: ToastItemProps) {
  // Pause the store's auto-dismiss countdown while the user interacts.
  const pauseAutoDismiss = () => useNotificationStore.getState().pauseAutoDismiss(notification.id);
  const resumeAutoDismiss = () => useNotificationStore.getState().resumeAutoDismiss(notification.id);

  return (
    <div
      className={`notification-toast notification-toast--${notification.type}${exiting ? ' notification-toast--exiting' : ''}`}
      role={notification.type === 'error' ? 'alert' : 'status'}
      onMouseEnter={pauseAutoDismiss}
      onMouseLeave={resumeAutoDismiss}
      onFocus={pauseAutoDismiss}
      onBlur={resumeAutoDismiss}
    >
      <span className="notification-toast__icon" aria-hidden="true">
        <Icon path={ICONS[notification.type]} size="sm" />
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

interface RenderedToast {
  notification: ToastNotification;
  exiting: boolean;
}

export function NotificationToast({ notifications, onDismiss }: NotificationToastProps) {
  const [rendered, setRendered] = useState<RenderedToast[]>([]);
  const previousIdsRef = useRef<Set<string>>(new Set());
  const removalTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());

  // Toasts removed from the store stay mounted for EXIT_TRANSITION_MS so the
  // exit transition can play instead of disappearing instantly.
  useEffect(() => {
    const incomingIds = new Set(notifications.map((n) => n.id));
    const removedIds = [...previousIdsRef.current].filter((id) => !incomingIds.has(id));
    previousIdsRef.current = incomingIds;

    setRendered((prev) => {
      const next: RenderedToast[] = notifications.map((notification) => ({
        notification,
        exiting: false,
      }));
      for (const item of prev) {
        if (item.exiting && !incomingIds.has(item.notification.id)) {
          next.push(item); // still animating out
        } else if (removedIds.includes(item.notification.id)) {
          next.push({ ...item, exiting: true });
        }
      }
      return next;
    });

    if (removedIds.length > 0) {
      const timer = setTimeout(() => {
        removalTimersRef.current.delete(timer);
        setRendered((prev) =>
          prev.filter((item) => !removedIds.includes(item.notification.id))
        );
      }, EXIT_TRANSITION_MS);
      removalTimersRef.current.add(timer);
    }
  }, [notifications]);

  // Cancel pending removals on unmount.
  useEffect(() => {
    const timers = removalTimersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  return (
    <div className="notification-toast-container">
      {rendered.map(({ notification, exiting }) => (
        <ToastItem
          key={notification.id}
          notification={notification}
          exiting={exiting}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
