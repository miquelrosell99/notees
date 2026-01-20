/**
 * ImportOptionsModal Component
 * 
 * Modal that displays import options for databases:
 * - Import db.sqlite file
 * - Import zip file with db.sqlite and assets folder
 */
import { useRef } from 'react';
import './ImportOptionsModal.css';
import Icon from '@mdi/react';
import { mdiDatabaseImport, mdiFolderZipOutline } from '@mdi/js';
import { ButtonClose } from './core/ButtonClose';

type ImportType = 'sqlite' | 'zip';

interface ImportOptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectOption: (type: ImportType, file: File) => void;
}

export function ImportOptionsModal({ isOpen, onClose, onSelectOption }: ImportOptionsModalProps) {
  const sqliteInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleSqliteClick = () => {
    sqliteInputRef.current?.click();
  };

  const handleZipClick = () => {
    zipInputRef.current?.click();
  };

  const handleSqliteChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onSelectOption('sqlite', file);
      // Reset input so same file can be selected again
      e.target.value = '';
    }
  };

  const handleZipChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onSelectOption('zip', file);
      // Reset input so same file can be selected again
      e.target.value = '';
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div className="import-options-modal">
        <div className="import-options-modal__header">
          <h2 className="import-options-modal__title">Import Database</h2>
          <ButtonClose className="import-options-modal__close" onClick={onClose} size="sm" />
        </div>

        <div className="import-options-modal__content">
          <p className="import-options-modal__description">
            Choose how you want to import your database:
          </p>

          <div className="import-options-modal__options">
            <button 
              className="import-options-modal__option"
              onClick={handleSqliteClick}
            >
              <div className="import-options-modal__option-icon">
                <Icon path={mdiDatabaseImport} size={1.5} />
              </div>
              <div className="import-options-modal__option-content">
                <span className="import-options-modal__option-title">Import db.sqlite</span>
                <span className="import-options-modal__option-desc">
                  Import a SQLite database file only
                </span>
              </div>
            </button>

            <button 
              className="import-options-modal__option"
              onClick={handleZipClick}
            >
              <div className="import-options-modal__option-icon">
                <Icon path={mdiFolderZipOutline} size={1.5} />
              </div>
              <div className="import-options-modal__option-content">
                <span className="import-options-modal__option-title">Import ZIP archive</span>
                <span className="import-options-modal__option-desc">
                  Import a ZIP file containing db.sqlite and assets folder
                </span>
              </div>
            </button>
          </div>

          {/* Hidden file inputs */}
          <input
            ref={sqliteInputRef}
            type="file"
            accept=".sqlite,.db"
            style={{ display: 'none' }}
            onChange={handleSqliteChange}
          />
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            onChange={handleZipChange}
          />
        </div>
      </div>
    </div>
  );
}

export default ImportOptionsModal;
