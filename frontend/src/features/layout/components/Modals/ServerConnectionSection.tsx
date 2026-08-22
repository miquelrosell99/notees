/**
 * ServerConnectionSection — runtime server URL setting (local-first split,
 * Tasks 1+6).
 *
 * General-tab section of the user settings modal:
 * - local mode: a server URL field. Connecting verifies the server answers
 *   `/api/health`, asks for confirmation, persists the URL, signs out the
 *   local session, and reloads — the app boots against the server and lands
 *   on the normal login screen. After login, `AdoptionPrompt` offers to sync
 *   the local notes into a new server workspace.
 * - connected/unreachable: shows the current server and offers Disconnect,
 *   which returns the client to local mode. The outbox and all workspace data
 *   persist locally (rollout.md); re-adding the same URL resumes sync.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import { checkServerReachable } from '@/core/adoption';
import { getServerUrl, setServerUrl } from '@/config/serverUrl';
import { useAuthStore } from '@/features/auth/stores/authStore';
import { useConnectionMode } from '@/stores/connectionStore';

/** Lightweight pre-validation mirroring `setServerUrl`'s normalize step. */
function validateServerUrlInput(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return 'Enter a valid URL, e.g. https://notes.example.com';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'The server URL must use http(s)';
  }
  return null;
}

export function ServerConnectionSection() {
  const connectionMode = useConnectionMode();
  const logout = useAuthStore((s) => s.logout);
  const [urlInput, setUrlInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  /** A reachable URL awaiting the user's confirmation to connect. */
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const handleConnect = async () => {
    setError(null);
    const url = urlInput.trim();
    if (!url) {
      setError('Enter a server URL');
      return;
    }
    const validationError = validateServerUrlInput(url);
    if (validationError) {
      setError(validationError);
      return;
    }
    setIsChecking(true);
    try {
      const reachable = await checkServerReachable(url);
      if (!reachable) {
        setError(`Could not reach ${url}. Check the URL and that the server is running.`);
        return;
      }
      setPendingUrl(url);
    } finally {
      setIsChecking(false);
    }
  };

  const handleConfirmConnect = () => {
    if (!pendingUrl) return;
    // Persist first; then drop the local session so the reload lands on the
    // server's normal login screen. Adoption is offered after login.
    setServerUrl(pendingUrl);
    logout();
    window.location.reload();
  };

  const handleConfirmDisconnect = async () => {
    try {
      // Best-effort server-side logout; the session is cleared locally either
      // way (authApi.logout clears user data in a finally block).
      await logout();
    } catch {
      // Server unreachable mid-logout — disconnecting locally still applies.
    }
    setServerUrl(null);
    window.location.reload();
  };

  if (connectionMode === 'local') {
    return (
      <div className="settings-section">
        <h3 className="settings-section__title">Server</h3>
        <Card>
          <div className="settings-item">
            <div className="settings-item__info">
              <label htmlFor="server-url" className="settings-item__label">Server URL</label>
              <p className="settings-item__description">
                Connect to a notees server to sync your notes across devices. You will be asked to
                sign in; your local notes can be synced to the server afterwards.
              </p>
            </div>
          </div>
          <div className="settings-form-row">
            <input
              id="server-url"
              type="url"
              className="settings-form-input"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://notes.example.com"
              autoComplete="url"
            />
          </div>
          {error && <div className="settings-error">{error}</div>}
          <Button
            variant="primary"
            size="sm"
            onClick={handleConnect}
            disabled={isChecking || !urlInput.trim()}
          >
            {isChecking ? 'Checking…' : 'Connect'}
          </Button>
          <ConfirmationModal
            isOpen={pendingUrl !== null}
            title="Connect to this server?"
            message={`You will be signed out of the local profile and asked to sign in to ${pendingUrl ?? ''}.`}
            secondaryMessage="Your local notes stay on this device; after signing in you can sync them to the server."
            confirmLabel="Connect"
            onConfirm={handleConfirmConnect}
            onCancel={() => setPendingUrl(null)}
          />
        </Card>
      </div>
    );
  }

  const currentServer = getServerUrl() ?? window.location.origin;

  return (
    <div className="settings-section">
      <h3 className="settings-section__title">Server</h3>
      <Card>
        <div className="settings-item">
          <div className="settings-item__info">
            <span className="settings-item__label">Connected server</span>
            <p className="settings-item__description">{currentServer}</p>
          </div>
          <Button variant="default" size="sm" onClick={() => setShowDisconnectConfirm(true)}>
            Disconnect
          </Button>
        </div>
        <ConfirmationModal
          isOpen={showDisconnectConfirm}
          title="Disconnect from this server?"
          message="You will be signed out and the app will switch to local mode. Your notes are kept on this device."
          secondaryMessage="Reconnecting to the same server later resumes sync."
          confirmLabel="Disconnect"
          onConfirm={handleConfirmDisconnect}
          onCancel={() => setShowDisconnectConfirm(false)}
        />
      </Card>
    </div>
  );
}
