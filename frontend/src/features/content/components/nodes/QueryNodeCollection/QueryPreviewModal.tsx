import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { QuerySQLPreview } from '@/features/queries/components/QuerySQLPreview';
import { getQueryIntent } from '@/lib/astProseRenderer';
import { copyToClipboard } from '@/utils/clipboardManager';
import { renderProseWithLinks } from './helpers';
import type { QueryAST } from '@/types/queryAST';
import type { Node } from '@/types';

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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Prose description */}
          <div>
            <h4 style={{
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--text-secondary)',
              marginBottom: '12px',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}>
              Natural Language
            </h4>
            <div style={{
              padding: '16px',
              fontSize: '15px',
              lineHeight: '1.6',
              color: 'var(--text-primary)',
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: '4px',
            }}>
              {renderProseWithLinks(getQueryIntent(editAST, nodesMap), onNodeLinkClick)}
            </div>
          </div>

          {/* AST Section */}
          <div>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '12px',
            }}>
              <h4 style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--text-secondary)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}>
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
            <pre style={{
              padding: '16px',
              fontSize: '13px',
              lineHeight: '1.5',
              backgroundColor: 'var(--bg-tertiary)',
              borderRadius: '4px',
              overflow: 'auto',
              maxHeight: '300px',
              color: 'var(--text-primary)',
            }}>
              {JSON.stringify(editAST, null, 2)}
            </pre>
          </div>

          {/* SQL Section */}
          <div>
            {!showSQL ? (
              <button
                type="button"
                onClick={() => setShowSQL(true)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '8px 0',
                  fontSize: '13px',
                  color: 'var(--text-tertiary)',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                Show SQL preview
              </button>
            ) : (
              <>
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  marginBottom: '12px',
                }}>
                  <h4 style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                  }}>
                    Execution Preview
                  </h4>
                  <span style={{
                    fontSize: '12px',
                    color: 'var(--text-tertiary)',
                    fontStyle: 'italic',
                  }}>
                    (informational only)
                  </span>
                </div>
                <QuerySQLPreview ast={editAST} />
                <button
                  type="button"
                  onClick={() => setShowSQL(false)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: '8px 0',
                    marginTop: '8px',
                    fontSize: '13px',
                    color: 'var(--text-tertiary)',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
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
