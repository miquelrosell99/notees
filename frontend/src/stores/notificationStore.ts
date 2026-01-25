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
  
  // Convenience methods
  success: (title: string, message?: string) => string;
  error: (title: string, message?: string) => string;
  warning: (title: string, message?: string) => string;
  info: (title: string, message?: string) => string;
}

const DEFAULT_DURATION = 4000; // 4 seconds

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
    
    // Auto-remove after duration (if not persistent)
    if (duration > 0) {
      setTimeout(() => {
        get().removeNotification(id);
      }, duration);
    }
    
    return id;
  },
  
  removeNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },
  
  clearAll: () => {
    set({ notifications: [] });
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
  return useNotificationStore((state) => ({
    success: state.success,
    error: state.error,
    warning: state.warning,
    info: state.info,
    addNotification: state.addNotification,
    removeNotification: state.removeNotification,
  }));
}
