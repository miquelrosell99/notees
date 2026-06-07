/**
 * NotificationBell — Displays unread notification count and a dropdown panel.
 */
import { useState, useRef, useEffect } from 'react';
import { useNotifications, useMarkNotificationRead, useMarkAllNotificationsRead } from '@/hooks/useNotifications';
import { Icon } from '@/components/core/Icon';
import { Button } from '@/components/core/Button';
import './NotificationBell.css';

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const { data, isLoading } = useNotifications(false);
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const unreadCount = data?.unread_count ?? 0;
  const notifications = data?.notifications ?? [];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div className="notification-bell" ref={panelRef}>
      <button
        className="notification-bell__trigger"
        onClick={() => setOpen((v) => !v)}
        title="Notifications"
        aria-label="Notifications"
      >
        <Icon path="mdi mdi-bell-outline" size={0.9} />
        {unreadCount > 0 && (
          <span className="notification-bell__badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {open && (
        <div className="notification-bell__panel">
          <div className="notification-bell__header">
            <span className="notification-bell__title">Notifications</span>
            {unreadCount > 0 && (
              <Button variant="ghost" size="sm" onClick={() => markAllRead.mutate()}>
                Mark all read
              </Button>
            )}
          </div>

          <div className="notification-bell__list">
            {isLoading ? (
              <div className="notification-bell__empty">Loading…</div>
            ) : notifications.length === 0 ? (
              <div className="notification-bell__empty">No new notifications</div>
            ) : (
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={`notification-bell__item ${n.is_read ? 'notification-bell__item--read' : ''}`}
                  onClick={() => {
                    if (!n.is_read) markRead.mutate(Number(n.id));
                    if (n.node_id) {
                      window.location.href = `/node/${n.node_id}`;
                    }
                  }}
                >
                  <div className="notification-bell__item-text">
                    <strong>{n.actor_name || 'Someone'}</strong>{' '}
                    {n.message || 'notified you'}
                  </div>
                  <span className="notification-bell__item-time">
                    {new Date(n.create_date).toLocaleString()}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
