/**
 * ImportDataModal - Modal for importing internal block format
 * 
 * Allows users to paste JSON data in the internal block format
 * and import it as blocks in the current context.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { mdiImport, mdiCodeJson, mdiAlertCircle } from '@mdi/js';
import { Modal } from './core/Modal';
import { Button } from './core/Button';
import { isValidBlockCopyData, type BlockCopyData, type BlockData } from '@/utils/clipboardManager';
import './ImportDataModal.css';

interface ImportDataModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal is closed */
  onClose: () => void;
  /** Callback when data is imported successfully */
  onImport: (blocks: BlockData[]) => void;
  /** Optional title for the modal */
  title?: string;
}

export function ImportDataModal({
  isOpen,
  onClose,
  onImport,
  title = 'Import Data',
}: ImportDataModalProps) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [parsedData, setParsedData] = useState<BlockCopyData | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea when modal opens
  useEffect(() => {
    if (isOpen) {
      setContent('');
      setError(null);
      setParsedData(null);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Validate content as user types
  useEffect(() => {
    if (!content.trim()) {
      setError(null);
      setParsedData(null);
      return;
    }

    try {
      const data = JSON.parse(content);
      if (isValidBlockCopyData(data)) {
        setParsedData(data);
        setError(null);
      } else {
        setParsedData(null);
        setError('Invalid format. Expected Notees block data format.');
      }
    } catch (e) {
      setParsedData(null);
      if (content.trim().length > 10) {
        setError('Invalid JSON format');
      } else {
        setError(null);
      }
    }
  }, [content]);

  const handleImport = useCallback(() => {
    if (!parsedData) return;
    
    onImport(parsedData.blocks);
    onClose();
  }, [parsedData, onImport, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (parsedData) {
        handleImport();
      }
    }
  }, [parsedData, handleImport]);

  if (!isOpen) return null;

  const blockCount = parsedData?.blocks?.length ?? 0;
  const totalBlocks = parsedData ? countAllBlocks(parsedData.blocks) : 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="md"
      closeOnBackdrop={true}
      closeOnEscape={true}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={!parsedData}
            icon={mdiImport}
          >
            Import {totalBlocks > 0 ? `${totalBlocks} block${totalBlocks !== 1 ? 's' : ''}` : ''}
          </Button>
        </>
      }
    >
      <div className="import-data-modal__instructions">
            <div className="import-data-modal__icon">
              <svg viewBox="0 0 24 24" width={24} height={24}>
                <path fill="currentColor" d={mdiCodeJson} />
              </svg>
            </div>
            <p>
              Paste JSON data in Notees internal format. This can be data copied from
              another Notees instance or exported block data.
            </p>
          </div>

          <div className="import-data-modal__input-container">
            <textarea
              ref={textareaRef}
              className={`import-data-modal__textarea ${error ? 'import-data-modal__textarea--error' : ''} ${parsedData ? 'import-data-modal__textarea--valid' : ''}`}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder='{"version": 1, "format": "notees-blocks", ...}'
              spellCheck={false}
            />
          </div>

          {error && (
            <div className="import-data-modal__error">
              <svg viewBox="0 0 24 24" width={16} height={16}>
                <path fill="currentColor" d={mdiAlertCircle} />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {parsedData && (
            <div className="import-data-modal__preview">
              <div className="import-data-modal__preview-header">
                <span className="import-data-modal__preview-title">Preview</span>
                <span className="import-data-modal__preview-count">
                  {blockCount} top-level block{blockCount !== 1 ? 's' : ''}
                  {totalBlocks > blockCount && ` (${totalBlocks} total)`}
                </span>
              </div>
              <div className="import-data-modal__preview-blocks">
                {parsedData.blocks.slice(0, 5).map((block, index) => (
                  <div key={index} className="import-data-modal__preview-block">
                    <span className="import-data-modal__preview-bullet">•</span>
                    <span className="import-data-modal__preview-content">
                      {block.name || '(empty)'}
                    </span>
                    {block.children && block.children.length > 0 && (
                      <span className="import-data-modal__preview-children">
                        +{countAllBlocks(block.children)} nested
                      </span>
                    )}
                  </div>
                ))}
                {parsedData.blocks.length > 5 && (
                  <div className="import-data-modal__preview-more">
                    ...and {parsedData.blocks.length - 5} more
                  </div>
                )}
              </div>
            </div>
          )}
    </Modal>
  );
}

/**
 * Count total blocks including nested children
 */
function countAllBlocks(blocks: BlockData[]): number {
  let count = blocks.length;
  for (const block of blocks) {
    if (block.children) {
      count += countAllBlocks(block.children);
    }
  }
  return count;
}

export default ImportDataModal;
