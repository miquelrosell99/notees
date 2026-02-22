/**
 * ImportOptionsModal Component
 *
 * Modal for selecting how to import a workspace.
 * Supports JSON dump, Logseq (EDN/SQLite), and Markdown import.
 */
import { useRef } from 'react';
import Icon from '@mdi/react';
import { mdiDatabaseImport, mdiGraphOutline, mdiLanguageMarkdownOutline } from '@mdi/js';
import { Modal } from '../core/Modal';
import { Card } from '../core/Card';
import './ImportOptionsModal.css';

export type ImportType = 'json' | 'logseq' | 'markdown';

interface ImportOptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called when an import option is selected. File is provided only for 'json'. */
  onSelectOption: (type: ImportType, file?: File) => void;
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
      <p className="import-options__description">
        Choose an import source. A new workspace will be created for the imported data.
      </p>

      <div className="import-options__grid">
        {/* JSON Dump */}
        <Card
          variant="outlined"
          elevation="none"
          interactive
          padding
          paddingSize="md"
          radius="md"
          className="import-options__card"
          onClick={handleJsonClick}
        >
          <div className="import-options__card-icon import-options__card-icon--json">
            <Icon path={mdiDatabaseImport} size={1.1} />
          </div>
          <div className="import-options__card-body">
            <span className="import-options__card-title">JSON Dump</span>
            <span className="import-options__card-desc">
              Restore from a workspace export file (.json)
            </span>
          </div>
        </Card>

        {/* Logseq */}
        <Card
          variant="outlined"
          elevation="none"
          interactive
          padding
          paddingSize="md"
          radius="md"
          className="import-options__card"
          onClick={() => onSelectOption('logseq')}
        >
          <div className="import-options__card-icon import-options__card-icon--logseq">
            <Icon path={mdiGraphOutline} size={1.1} />
          </div>
          <div className="import-options__card-body">
            <span className="import-options__card-title">Logseq Graph</span>
            <span className="import-options__card-desc">
              Import from Logseq via EDN export or SQLite database
            </span>
          </div>
        </Card>

        {/* Markdown */}
        <Card
          variant="outlined"
          elevation="none"
          interactive
          padding
          paddingSize="md"
          radius="md"
          className="import-options__card"
          onClick={() => onSelectOption('markdown')}
        >
          <div className="import-options__card-icon import-options__card-icon--markdown">
            <Icon path={mdiLanguageMarkdownOutline} size={1.1} />
          </div>
          <div className="import-options__card-body">
            <span className="import-options__card-title">Markdown Files</span>
            <span className="import-options__card-desc">
              Import .md files from Logseq or Obsidian
            </span>
          </div>
        </Card>
      </div>

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
