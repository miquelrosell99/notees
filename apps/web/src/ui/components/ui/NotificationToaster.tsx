/**
 * NotificationToaster — the app-level toast host.
 *
 * Connects the presentational NotificationToast to the global notification
 * store: renders the live list, wires dismiss + the hover/focus
 * pause/resume callbacks that keep auto-dismiss timers honest.
 */

import { NotificationToast, type ToastNotification } from "./NotificationToast.js";
import {
  notificationStore,
  useNotificationList,
} from "./notificationStore.js";

function toToastNotification(n: {
  id: string;
  type: "success" | "error" | "warning" | "info";
  title: string;
  message?: string | undefined;
  dismissible?: boolean | undefined;
  action?: { label: string; onClick: () => void } | undefined;
}): ToastNotification {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    message: n.message,
    dismissible: n.dismissible,
    action: n.action,
  };
}

export function NotificationToaster() {
  const notifications = useNotificationList();
  return (
    <NotificationToast
      notifications={notifications.map(toToastNotification)}
      onDismiss={notificationStore.removeNotification}
      onPauseAutoDismiss={notificationStore.pauseAutoDismiss}
      onResumeAutoDismiss={notificationStore.resumeAutoDismiss}
    />
  );
}
