/**
 * Capability gating (local-first split, Task 4).
 *
 * Server-only features are gated behind capabilities derived from the
 * connection mode (`useConnectionMode`). In `local` mode (no server
 * configured) every capability is false and the corresponding UI entry points
 * are hidden — not merely broken. In `connected` and `unreachable` modes all
 * capabilities are true: an unreachable server keeps today's behavior, where
 * features remain visible and their requests error/retry as before.
 *
 * Entry points should read `useCapabilities()` rather than checking the
 * connection mode directly, so the gating policy lives in exactly one place.
 */
import { useConnectionMode } from '@/stores/connectionStore';

export interface Capabilities {
  /** Public share links, share modals, and the Shares view (server-hosted URLs). */
  shares: boolean;
  /** Notification/mention polling, bell, and panel (server-side notification log). */
  notifications: boolean;
  /** Import/export modals, commands, and export jobs (server-side converters). */
  importExport: boolean;
  /** Admin/system settings (user management, system metrics). */
  admin: boolean;
  /** Account + security settings (password, API keys, 2FA, server-side encryption config). */
  accountSecurity: boolean;
  /** Workspace switching/creation/management (local mode has exactly one workspace). */
  workspaceManagement: boolean;
  /** Server-side activity log (viewing + deleting entries). */
  activity: boolean;
  /** Live-sync WebSocket connect and collaboration presence. */
  collabPresence: boolean;
  /** Plugin manager and backend-provided plugin manifests. */
  plugins: boolean;
}

const LOCAL_CAPABILITIES: Capabilities = {
  shares: false,
  notifications: false,
  importExport: false,
  admin: false,
  accountSecurity: false,
  workspaceManagement: false,
  activity: false,
  collabPresence: false,
  plugins: false,
};

const SERVER_CAPABILITIES: Capabilities = {
  shares: true,
  notifications: true,
  importExport: true,
  admin: true,
  accountSecurity: true,
  workspaceManagement: true,
  activity: true,
  collabPresence: true,
  plugins: true,
};

/**
 * Capabilities for the current connection mode. All false in `local` mode;
 * all true otherwise (`unreachable` included — features stay visible and
 * fail/retry as they do today).
 */
export function useCapabilities(): Capabilities {
  const mode = useConnectionMode();
  return mode === 'local' ? LOCAL_CAPABILITIES : SERVER_CAPABILITIES;
}
