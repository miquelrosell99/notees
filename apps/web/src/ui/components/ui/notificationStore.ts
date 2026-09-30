/**
 * Notification Store - Global toast/notification system
 *
 * Provides a centralized way to show notifications to users.
 * Supports different types: success, error, warning, info.
 * Framework-free: a tiny external store consumed through
 * useSyncExternalStore (no extra dependency).
 */

import { useSyncExternalStore } from "react";

export type NotificationType = "success" | "error" | "warning" | "info";

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message?: string | undefined;
  duration?: number | undefined; // ms, 0 = persistent
  dismissible?: boolean | undefined;
  action?: {
    label: string;
    onClick: () => void;
  } | undefined;
}

interface NotificationState {
  notifications: Notification[];

  // Actions
  addNotification: (notification: Omit<Notification, "id">) => string;
  removeNotification: (id: string) => void;
  clearAll: () => void;
  /** Pause/resume a toast's auto-dismiss countdown (hover/focus). */
  pauseAutoDismiss: (id: string) => void;
  resumeAutoDismiss: (id: string) => void;

  // Convenience methods
  success: (title: string, message?: string) => string;
  error: (title: string, message?: string) => string;
  warning: (title: string, message?: string) => string;
  info: (title: string, message?: string) => string;
}

const DEFAULT_DURATION = 4000; // 4 seconds

/** Scheduled auto-dismiss timers, tracked so hover/focus can pause them. */
interface AutoDismissTimer {
  timeoutId: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  remainingMs: number;
}
const autoDismissTimers = new Map<string, AutoDismissTimer>();

function clearAutoDismissTimer(id: string) {
  const timer = autoDismissTimers.get(id);
  if (timer?.timeoutId != null) clearTimeout(timer.timeoutId);
  autoDismissTimers.delete(id);
}

let snapshot: Notification[] = [];
const listeners = new Set<() => void>();

function emit(next: Notification[]): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Notification[] {
  return snapshot;
}

export const notificationStore: NotificationState = {
  get notifications() {
    return snapshot;
  },

  addNotification: (notification) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const duration = notification.duration ?? DEFAULT_DURATION;

    const fullNotification: Notification = {
      ...notification,
      id,
      dismissible: notification.dismissible ?? true,
    };

    emit([...snapshot, fullNotification]);

    // Auto-remove after duration (if not persistent). Toasts carrying an
    // action never auto-dismiss — the user needs time to respond.
    if (duration > 0 && !fullNotification.action) {
      autoDismissTimers.set(id, {
        timeoutId: setTimeout(() => notificationStore.removeNotification(id), duration),
        startedAt: Date.now(),
        remainingMs: duration,
      });
    }

    return id;
  },

  removeNotification: (id) => {
    clearAutoDismissTimer(id);
    emit(snapshot.filter((n) => n.id !== id));
  },

  clearAll: () => {
    for (const id of autoDismissTimers.keys()) clearAutoDismissTimer(id);
    emit([]);
  },

  pauseAutoDismiss: (id) => {
    const timer = autoDismissTimers.get(id);
    if (!timer || timer.timeoutId === null) return;
    clearTimeout(timer.timeoutId);
    autoDismissTimers.set(id, {
      timeoutId: null,
      startedAt: timer.startedAt,
      remainingMs: Math.max(0, timer.remainingMs - (Date.now() - timer.startedAt)),
    });
  },

  resumeAutoDismiss: (id) => {
    const timer = autoDismissTimers.get(id);
    if (!timer || timer.timeoutId !== null) return;
    if (timer.remainingMs <= 0) {
      notificationStore.removeNotification(id);
      return;
    }
    autoDismissTimers.set(id, {
      timeoutId: setTimeout(() => notificationStore.removeNotification(id), timer.remainingMs),
      startedAt: Date.now(),
      remainingMs: timer.remainingMs,
    });
  },

  // Convenience methods
  success: (title, message) => {
    return notificationStore.addNotification({ type: "success", title, message });
  },

  error: (title, message) => {
    return notificationStore.addNotification({
      type: "error",
      title,
      message,
      duration: 6000, // Errors stay longer
    });
  },

  warning: (title, message) => {
    return notificationStore.addNotification({ type: "warning", title, message });
  },

  info: (title, message) => {
    return notificationStore.addNotification({ type: "info", title, message });
  },
};

/** Subscribe a component to the live notification list. */
export function useNotificationList(): Notification[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Hook for easy access to notification actions only. */
export function useNotifications() {
  const notifications = useNotificationList();
  return {
    notifications,
    success: notificationStore.success,
    error: notificationStore.error,
    warning: notificationStore.warning,
    info: notificationStore.info,
    addNotification: notificationStore.addNotification,
    removeNotification: notificationStore.removeNotification,
  };
}
