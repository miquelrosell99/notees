/**
 * E2eeUnlockModal — blocking passphrase prompt shown when an E2EE-enabled
 * workspace opens without its key in memory. The workspace cannot sync
 * (and must not open) until the workspace key is unwrapped.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { unlockWorkspaceE2ee } from '@/core/e2eeSetup';

interface E2eeUnlockModalProps {
  workspaceId: string;
  onUnlocked: () => void;
}

export function E2eeUnlockModal({ workspaceId, onUnlocked }: E2eeUnlockModalProps): ReactNode {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    setPassword('');
    setError(null);
    setIsPending(false);
  }, [workspaceId]);

  const handleSubmit = async (): Promise<void> => {
    if (isPending || !password) return;
    setError(null);
    setIsPending(true);
    try {
      const ok = await unlockWorkspaceE2ee(workspaceId, password);
      if (!ok) {
        setError('Wrong passphrase, or the workspace key could not be unwrapped.');
        return;
      }
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed. Please try again.');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={() => undefined}
      title="Workspace is encrypted"
      showCloseButton={false}
      closeOnBackdrop={false}
      closeOnEscape={false}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        <p>
          This workspace is end-to-end encrypted. Enter its encryption passphrase to unlock it on
          this device. Sync is paused until the workspace is unlocked.
        </p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Encryption passphrase"
          aria-label="Encryption passphrase"
        />
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={isPending || !password}>
          {isPending ? 'Unlocking…' : 'Unlock workspace'}
        </Button>
      </form>
    </Modal>
  );
}
