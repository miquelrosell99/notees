/**
 * Quick add dialog for rapidly creating new pages/blocks
 * 
 * Features:
 * - Create pages directly
 * - Add multiple blocks to a destination page via pseudo-page editor
 * - Search and select destination page
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { useCreatePage, useCreateNode, usePages, useSearch } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import { PageIcon, NodeIcon, AddIcon } from '../icons';
import './QuickAddDialog.css';

interface QuickAddProps {
  isOpen: boolean;
  onClose: () => void;
}

type CreateType = 'page' | 'blocks';

interface DraftBlock {
  id: number;
  content: string;
}

export function QuickAddDialog({ isOpen, onClose }: QuickAddProps) {
  const [createType, setCreateType] = useState<CreateType>('page');
  const [pageName, setPageName] = useState('');
  const [draftBlocks, setDraftBlocks] = useState<DraftBlock[]>([{ id: 1, content: '' }]);
  const [destinationPage, setDestinationPage] = useState<Node | null>(null);
  const [destinationSearch, setDestinationSearch] = useState('');
  const [showDestinationPicker, setShowDestinationPicker] = useState(false);
  const [nextBlockId, setNextBlockId] = useState(2);
  
  const inputRef = useRef<HTMLInputElement>(null);
  const destinationInputRef = useRef<HTMLInputElement>(null);
  
  const { openNode } = useNodesStore();
  const createPage = useCreatePage();
  const createNode = useCreateNode();
  const { data: allPages } = usePages();
  const { data: searchResults } = useSearch(destinationSearch);
  
  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setCreateType('page');
      setPageName('');
      setDraftBlocks([{ id: 1, content: '' }]);
      setDestinationPage(null);
      setDestinationSearch('');
      setShowDestinationPicker(false);
      setNextBlockId(2);
      
      // Focus appropriate input after short delay
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);
  
  // Handle keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;
    
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (showDestinationPicker) {
          setShowDestinationPicker(false);
        } else {
          onClose();
        }
      }
    }
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, showDestinationPicker]);
  
  // Filter pages for destination picker
  const destinationOptions = destinationSearch
    ? (searchResults?.filter(n => n.parent_id === null) || [])
    : (allPages?.slice(0, 10) || []);
  
  const handleBlockChange = useCallback((blockId: number, content: string) => {
    setDraftBlocks(blocks => 
      blocks.map(b => b.id === blockId ? { ...b, content } : b)
    );
  }, []);
  
  const handleAddBlock = useCallback(() => {
    setDraftBlocks(blocks => [...blocks, { id: nextBlockId, content: '' }]);
    setNextBlockId(id => id + 1);
  }, [nextBlockId]);
  
  const handleRemoveBlock = useCallback((blockId: number) => {
    setDraftBlocks(blocks => {
      if (blocks.length <= 1) return blocks;
      return blocks.filter(b => b.id !== blockId);
    });
  }, []);
  
  const handleBlockKeyDown = useCallback((blockId: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAddBlock();
    } else if (e.key === 'Backspace') {
      const block = draftBlocks.find(b => b.id === blockId);
      if (block?.content === '' && draftBlocks.length > 1) {
        e.preventDefault();
        handleRemoveBlock(blockId);
      }
    }
  }, [draftBlocks, handleAddBlock, handleRemoveBlock]);
  
  const handleSelectDestination = useCallback((page: Node) => {
    setDestinationPage(page);
    setDestinationSearch('');
    setShowDestinationPicker(false);
  }, []);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      if (createType === 'page') {
        if (!pageName.trim()) return;
        
        const newPage = await createPage.mutateAsync({ name: pageName.trim() });
        openNode(newPage.id, 'page');
      } else {
        // Create blocks mode
        if (!destinationPage) return;
        
        const nonEmptyBlocks = draftBlocks.filter(b => b.content.trim());
        if (nonEmptyBlocks.length === 0) return;
        
        // Create blocks sequentially
        for (const block of nonEmptyBlocks) {
          await createNode.mutateAsync({
            name: block.content.trim(),
            parent_id: destinationPage.id,
          });
        }
        
        // Navigate to destination page
        openNode(destinationPage.id, 'page');
      }
      
      onClose();
    } catch (error) {
      console.error('Failed to create:', error);
    }
  };
  
  const canSubmit = createType === 'page' 
    ? pageName.trim().length > 0
    : destinationPage !== null && draftBlocks.some(b => b.content.trim());
  
  if (!isOpen) return null;
  
  return (
    <div className="quick-add-overlay" onClick={onClose}>
      <div className="quick-add-dialog quick-add-dialog--large" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit} className="quick-add-form">
          {/* Mode selector */}
          <div className="quick-add-type-selector">
            <button
              type="button"
              className={`quick-add-type-btn ${createType === 'page' ? 'active' : ''}`}
              onClick={() => setCreateType('page')}
            >
              <PageIcon size="xs" /> New Page
            </button>
            <button
              type="button"
              className={`quick-add-type-btn ${createType === 'blocks' ? 'active' : ''}`}
              onClick={() => setCreateType('blocks')}
            >
              • Quick Capture
            </button>
          </div>
          
          {createType === 'page' ? (
            /* Page creation mode */
            <div className="quick-add-page-mode">
              <input
                ref={inputRef}
                type="text"
                className="quick-add-input"
                value={pageName}
                onChange={(e) => setPageName(e.target.value)}
                placeholder="New page name..."
              />
            </div>
          ) : (
            /* Quick capture mode - pseudo-page editor */
            <div className="quick-add-blocks-mode">
              {/* Destination picker */}
              <div className="quick-add-destination">
                <label className="quick-add-destination-label">Add to:</label>
                <div className="quick-add-destination-picker">
                  {destinationPage ? (
                    <button
                      type="button"
                      className="quick-add-destination-selected"
                      onClick={() => setShowDestinationPicker(true)}
                    >
                      <NodeIcon icon={destinationPage.icon} isPage={true} size="sm" />
                      <span>{destinationPage.name || 'Untitled'}</span>
                    </button>
                  ) : (
                    <input
                      ref={destinationInputRef}
                      type="text"
                      className="quick-add-destination-input"
                      value={destinationSearch}
                      onChange={(e) => {
                        setDestinationSearch(e.target.value);
                        setShowDestinationPicker(true);
                      }}
                      onFocus={() => setShowDestinationPicker(true)}
                      placeholder="Search for destination page..."
                    />
                  )}
                  
                  {showDestinationPicker && (
                    <div className="quick-add-destination-dropdown">
                      {destinationOptions.length > 0 ? (
                        destinationOptions.map(page => (
                          <button
                            key={page.id}
                            type="button"
                            className="quick-add-destination-option"
                            onClick={() => handleSelectDestination(page)}
                          >
                            <NodeIcon icon={page.icon} isPage={true} size="sm" />
                            <span>{page.name || 'Untitled'}</span>
                          </button>
                        ))
                      ) : (
                        <div className="quick-add-destination-empty">
                          No pages found
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {destinationPage && (
                  <button
                    type="button"
                    className="quick-add-destination-clear"
                    onClick={() => setDestinationPage(null)}
                    title="Change destination"
                  >
                    x
                  </button>
                )}
              </div>
              
              {/* Block editor area */}
              <div className="quick-add-blocks-editor">
                {draftBlocks.map((block, index) => (
                  <div key={block.id} className="quick-add-block-item">
                    <span className="quick-add-block-bullet">•</span>
                    <textarea
                      className="quick-add-block-input"
                      value={block.content}
                      onChange={(e) => handleBlockChange(block.id, e.target.value)}
                      onKeyDown={(e) => handleBlockKeyDown(block.id, e)}
                      placeholder={index === 0 ? "What's on your mind?" : "Add another block..."}
                      rows={1}
                      autoFocus={index === draftBlocks.length - 1}
                    />
                  </div>
                ))}
                <button
                  type="button"
                  className="quick-add-add-block-btn"
                  onClick={handleAddBlock}
                >
                  <AddIcon size="xs" /> Add block
                </button>
              </div>
            </div>
          )}
          
          <div className="quick-add-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button 
              type="submit" 
              className="btn btn-primary"
              disabled={!canSubmit || createPage.isPending || createNode.isPending}
            >
              {createType === 'page' ? 'Create Page' : 'Send'}
            </button>
          </div>
        </form>
        
        <div className="quick-add-hint">
          Press <kbd>Esc</kbd> to cancel • <kbd>Enter</kbd> to add block • <kbd>Shift+Enter</kbd> for new line
        </div>
      </div>
    </div>
  );
}

export default QuickAddDialog;
