/**
 * ImportOptionsModal Component
 * 
 * Modal for importing workspaces from JSON dump files.
 * The dump file is produced by the workspace export feature.
 */
import { useRef } from 'react';
import Icon from '@mdi/react';
import { mdiDatabaseImport } from '@mdi/js';
import { Modal } from '../core/Modal';
import { Button } from '../core/Button';

type ImportType = 'json';

interface ImportOptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectOption: (type: ImportType, file: File) => void;
}

export function ImportOptionsModal({ isOpen, onClose, onSelectOption }: ImportOptionsModalProps) {
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const handleJsonClick = () => {
    jsonInputRef.current?.click();
  };

  const handleJsonChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onSelectOption('json', file);
      e.target.value = '';
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Import Workspace"
      size="sm"
    >
      <p style={{ margin: '0 0 var(--spacing-4) 0', color: 'var(--color-on-surface-variant)', fontSize: '0.875rem' }}>
        Import a workspace from a JSON dump file. All data will be assigned
        new identifiers so the imported workspace is independent from the original.
      </p>

      <Button
        variant="default"
        onClick={handleJsonClick}
        style={{ width: '100%', justifyContent: 'flex-start', gap: 'var(--spacing-3)' }}
      >
        <Icon path={mdiDatabaseImport} size={0.9} />
        Select JSON Dump File
      </Button>

      <input
        ref={jsonInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={handleJsonChange}
      />
    </Modal>
  );
}

export default ImportOptionsModal;
export type { ImportType };
