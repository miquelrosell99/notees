/**
 * SyncProgressModal — locked modal that shows sync progress
 *
 * Used for explicit user actions like Force workspace re-sync. The modal cannot
 * be dismissed by backdrop click or Escape; it closes automatically when the
 * sync finishes or errors.
 */
import { Modal } from './Modal';
import { SyncProgress } from './SyncProgress';
import './SyncProgressModal.css';

export interface SyncProgressModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Modal title */
  title?: string;
  /** Text shown beneath the spinner */
  label?: string;
  /** Optional progress fraction (0–1) */
  progress?: number;
  /** Optional rotating messages */
  messages?: string[];
}

export function SyncProgressModal({
  isOpen,
  title = 'Syncing workspace',
  label = 'Syncing workspace…',
  progress,
  messages,
}: SyncProgressModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {}}
      title={title}
      size="sm"
      showCloseButton={false}
      closeOnBackdrop={false}
      closeOnEscape={false}
      contentClassName="sync-progress-modal__content"
    >
      <SyncProgress label={label} progress={progress} messages={messages} />
    </Modal>
  );
}
