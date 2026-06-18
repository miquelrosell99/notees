import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { QuerySQLPreview } from '@/features/queries';
import { getQueryIntent } from '@/lib/astProseRenderer';
import { copyToClipboard } from '@/utils/clipboardManager';
import { renderProseWithLinks } from './helpers';
import type { QueryAST } from '@/types/queryAST';
import type { Node } from '@/types';
import './QueryPreviewModal.css';

export interface QueryPreviewModalProps {
  isOpen: boolean;
  editAST: QueryAST | null;
  nodesMap: Map<string, Node>;
  onClose: () => void;
  onNodeLinkClick: (uuid: string) => void;
}

export function QueryPreviewModal({ isOpen, editAST, nodesMap, onClose, onNodeLinkClick }: QueryPreviewModalProps) {
  const [showSQL, setShowSQL] = useState(false);

  const handleCopyAST = () => {
    if (editAST) {
      copyToClipboard(JSON.stringify(editAST, null, 2));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        onClose();
        setShowSQL(false);
      }}
      title="Query Preview"
      size="xl"
      className="query-preview-modal"
    >
      {editAST && (
        <div className="query-preview-modal__content">
          {/* Prose description */}
          <div className="query-preview-modal__section">
            <h4 className="query-preview-modal__section-title">
              Natural Language
            </h4>
            <div className="query-preview-modal__prose">
              {renderProseWithLinks(getQueryIntent(editAST, nodesMap), onNodeLinkClick)}
            </div>
          </div>

          {/* AST Section */}
          <div className="query-preview-modal__section">
            <div className="query-preview-modal__section-header">
              <h4 className="query-preview-modal__section-title">
                Query Structure
              </h4>
              <Button
                icon="mdi mdi-content-copy"
                onClick={handleCopyAST}
                variant="ghost"
                size="xs"
              >
                Copy
              </Button>
            </div>
            <pre className="query-preview-modal__code">
              {JSON.stringify(editAST, null, 2)}
            </pre>
          </div>

          {/* SQL Section */}
          <div className="query-preview-modal__section">
            {!showSQL ? (
              <button
                type="button"
                onClick={() => setShowSQL(true)}
                className="query-preview-modal__toggle"
              >
                Show SQL preview
              </button>
            ) : (
              <>
                <div className="query-preview-modal__sql-header">
                  <h4 className="query-preview-modal__section-title">
                    Execution Preview
                  </h4>
                  <span className="query-preview-modal__metric">
                    (informational only)
                  </span>
                </div>
                <QuerySQLPreview ast={editAST} />
                <button
                  type="button"
                  onClick={() => setShowSQL(false)}
                  className="query-preview-modal__toggle"
                >
                  Hide
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
