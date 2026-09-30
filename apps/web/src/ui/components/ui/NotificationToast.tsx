/**
 * NotificationToast - Presentational toast notification display component
 *
 * Receives notifications and a dismiss callback via props; the component
 * stays domain-agnostic. Two optional callbacks expose the hover/focus
 * pause/resume hooks for an app-level auto-dismiss countdown — wire them to
 * a store to pause timers while the user interacts with a toast.
 *
 * Toasts removed from the `notifications` prop are kept mounted briefly so
 * their exit transition can play.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from './Button.js';
import { Icon } from '../../Icon.js';
import './NotificationToast.css';

export interface ToastNotification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message?: string | undefined;
  dismissible?: boolean | undefined;
  action?: {
    label: string;
    onClick: () => void;
  } | undefined;
}

interface NotificationToastProps {
  notifications: ToastNotification[];
  onDismiss: (id: string) => void;
  /** Called while a toast is hovered/focused — pause its auto-dismiss countdown. */
  onPauseAutoDismiss?: ((id: string) => void) | undefined;
  /** Called when the toast is left/blurred — resume the countdown. */
  onResumeAutoDismiss?: ((id: string) => void) | undefined;
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
  onPauseAutoDismiss?: ((id: string) => void) | undefined;
  onResumeAutoDismiss?: ((id: string) => void) | undefined;
}

function ToastItem({ notification, exiting = false, onDismiss, onPauseAutoDismiss, onResumeAutoDismiss }: ToastItemProps) {
  // Pause the auto-dismiss countdown while the user interacts.
  const pauseAutoDismiss = () => onPauseAutoDismiss?.(notification.id);
  const resumeAutoDismiss = () => onResumeAutoDismiss?.(notification.id);

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

export function NotificationToast({ notifications, onDismiss, onPauseAutoDismiss, onResumeAutoDismiss }: NotificationToastProps) {
  const [rendered, setRendered] = useState<RenderedToast[]>([]);
  const previousIdsRef = useRef<Set<string>>(new Set());
  const removalTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());

  // Toasts removed from the props stay mounted for EXIT_TRANSITION_MS so the
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
          onPauseAutoDismiss={onPauseAutoDismiss}
          onResumeAutoDismiss={onResumeAutoDismiss}
        />
      ))}
    </div>
  );
}
