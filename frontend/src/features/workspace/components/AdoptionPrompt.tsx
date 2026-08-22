/**
 * AdoptionPrompt — post-login offer to adopt local notes into the server
 * (local-first split, Task 6).
 *
 * Shown once per session after a server login when this browser profile has a
 * local workspace with content that has not been adopted yet. Confirming runs
 * `adoptServer` (create server workspace → replay the full local op log →
 * upload asset blobs) and reloads straight into the new workspace. Declining
 * dismisses the prompt for the session; adoption can be re-run any time by
 * signing out and back in (replay is idempotent by op id).
 */
import { useEffect, useState } from 'react';
import { ConfirmationModal } from '@/components/ui/ConfirmationModal';
import {
  adoptServer,
  getLocalAdoptionCandidate,
  loadAdoptionSource,
  markLocalWorkspaceAdopted,
  type AdoptionCandidate,
} from '@/core/adoption';
import { getServerUrl } from '@/config/serverUrl';
import { getExistingLocalWorkspaceUuid, useAuthStore } from '@/features/auth/stores/authStore';
import { useConnectionMode } from '@/stores/connectionStore';
import { getLogger } from '@/utils/logger';

const log = getLogger('adoption');

const DISMISS_KEY = 'notees.adoptionPromptDismissed';

export function AdoptionPrompt() {
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const authVerified = useAuthStore((s) => s.authVerified);
  const connectionMode = useConnectionMode();
  const [candidate, setCandidate] = useState<AdoptionCandidate | null>(null);

  useEffect(() => {
    // Only server-logged-in sessions in connected mode can adopt; local
    // sessions have no server identity to stamp on the replayed envelopes.
    if (connectionMode !== 'connected' || !isAuthenticated || !authVerified) return;
    if (!user || user.isLocal) return;
    try {
      if (sessionStorage.getItem(DISMISS_KEY)) return;
    } catch {
      // Storage unavailable — fall through and offer anyway.
    }
    const localWorkspaceId = getExistingLocalWorkspaceUuid();
    if (!localWorkspaceId) return;

    let cancelled = false;
    getLocalAdoptionCandidate(localWorkspaceId)
      .then((found) => {
        if (!cancelled && found) setCandidate(found);
      })
      .catch((err) => {
        log.warn('Adoption candidate check failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionMode, isAuthenticated, authVerified, user]);

  const handleCancel = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Storage unavailable — dismissal simply won't persist.
    }
    setCandidate(null);
  };

  const handleConfirm = async () => {
    if (!candidate || !user) return;
    const source = await loadAdoptionSource(candidate.workspaceId);
    if (!source) {
      // Local data vanished between the check and the confirm; nothing to do.
      setCandidate(null);
      return;
    }
    const result = await adoptServer({ source, actorId: user.uuid });
    markLocalWorkspaceAdopted(candidate.workspaceId);
    log.info(
      `Adoption complete: ${result.operationsReplayed} operations replayed, ` +
        `${result.assetsUploaded} assets uploaded into workspace ${result.workspaceId}` +
        (result.assetsFailed.length > 0 ? ` (${result.assetsFailed.length} assets failed)` : '')
    );
    // Full reload into the adopted workspace: a fresh boot opens it with a
    // seq cursor at 0 and catches up everything (server seed + replayed ops).
    window.location.assign(`/${result.workspaceId}`);
  };

  return (
    <ConfirmationModal
      isOpen={candidate !== null}
      title="Sync local notes to this server?"
      message={`This device has notes stored locally (${candidate?.operationCount ?? 0} changes${
        candidate && candidate.assetCount > 0 ? `, ${candidate.assetCount} attachments` : ''
      }) that are not on ${getServerUrl() ?? 'the server'} yet.`}
      secondaryMessage="They will be copied into a new server workspace. The local copy stays on this device."
      confirmLabel="Sync local notes"
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    />
  );
}
