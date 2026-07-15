/**
 * Notification Store - Global toast/notification system
 * 
 * Provides a centralized way to show notifications to users.
 * Supports different types: success, error, warning, info
 */
import { create } from 'zustand';

export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message?: string;
  duration?: number; // ms, 0 = persistent
  dismissible?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface NotificationState {
  notifications: Notification[];
  
  // Actions
  addNotification: (notification: Omit<Notification, 'id'>) => string;
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

export const useNotificationStore = create<NotificationState>()((set, get) => ({
  notifications: [],
  
  addNotification: (notification) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const duration = notification.duration ?? DEFAULT_DURATION;
    
    const fullNotification: Notification = {
      ...notification,
      id,
      dismissible: notification.dismissible ?? true,
    };
    
    set((state) => ({
      notifications: [...state.notifications, fullNotification],
    }));
    
    // Auto-remove after duration (if not persistent). Toasts carrying an
    // action never auto-dismiss — the user needs time to respond.
    if (duration > 0 && !fullNotification.action) {
      autoDismissTimers.set(id, {
        timeoutId: setTimeout(() => get().removeNotification(id), duration),
        startedAt: Date.now(),
        remainingMs: duration,
      });
    }
    
    return id;
  },
  
  removeNotification: (id) => {
    clearAutoDismissTimer(id);
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },
  
  clearAll: () => {
    for (const id of autoDismissTimers.keys()) clearAutoDismissTimer(id);
    set({ notifications: [] });
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
      get().removeNotification(id);
      return;
    }
    autoDismissTimers.set(id, {
      timeoutId: setTimeout(() => get().removeNotification(id), timer.remainingMs),
      startedAt: Date.now(),
      remainingMs: timer.remainingMs,
    });
  },
  
  // Convenience methods
  success: (title, message) => {
    return get().addNotification({ type: 'success', title, message });
  },
  
  error: (title, message) => {
    return get().addNotification({ 
      type: 'error', 
      title, 
      message,
      duration: 6000, // Errors stay longer
    });
  },
  
  warning: (title, message) => {
    return get().addNotification({ type: 'warning', title, message });
  },
  
  info: (title, message) => {
    return get().addNotification({ type: 'info', title, message });
  },
}));

// Hook for easy access to notification actions only
export function useNotifications() {
  const success = useNotificationStore((state) => state.success);
  const error = useNotificationStore((state) => state.error);
  const warning = useNotificationStore((state) => state.warning);
  const info = useNotificationStore((state) => state.info);
  const addNotification = useNotificationStore((state) => state.addNotification);
  const removeNotification = useNotificationStore((state) => state.removeNotification);
  return { success, error, warning, info, addNotification, removeNotification };
}
