/**
 * Quick add dialog for rapidly creating new pages/blocks
 * 
 * Features:
 * - Create pages directly
 * - Add multiple blocks to a destination page via pseudo-page editor
 * - Search and select destination page
 * 
 * NOTE: Moved out of core/ - has domain knowledge (Node type, uses hooks)
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { usePages, useSearch, useQuickAdd } from '@/hooks';
import { useNodesStore } from '@/stores';
import type { Node } from '@/types';
import { PageIcon, NodeIcon, AddIcon, SearchIcon } from '../icons';
import { Button } from '../core/Button';
import { TextField } from '../core/TextField';
import './QuickAddDialog.css';

interface QuickAddProps {
  isOpen: boolean;
  onClose: () => void;
}

type CreateType = 'page' | 'blocks';

export function QuickAddDialog({ isOpen, onClose }: QuickAddProps) {
  const [createType, setCreateType] = useState<CreateType>('page');
  const [pageName, setPageName] = useState('');
  const [destinationPage, setDestinationPage] = useState<Node | null>(null);
  const [destinationSearch, setDestinationSearch] = useState('');
  const [showDestinationPicker, setShowDestinationPicker] = useState(false);
  
  const inputRef = useRef<HTMLInputElement>(null);
  const destinationInputRef = useRef<HTMLInputElement>(null);
  
  const { openNode } = useNodesStore();
  const { data: allPages } = usePages();
  const { data: searchResults } = useSearch(destinationSearch);
  
  // Use shared quick add logic
  const {
    draftBlocks,
    resetBlocks,
    handleBlockChange,
    handleAddBlock,
    handleBlockKeyDown,
    createBlocks,
    createPage,
    isCreating,
    hasContent,
  } = useQuickAdd({
    navigateOnSuccess: true,
    onSuccess: onClose,
  });
  
  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setCreateType('page');
      setPageName('');
      resetBlocks();
      setDestinationPage(null);
      setDestinationSearch('');
      setShowDestinationPicker(false);
      
      // Focus appropriate input after short delay
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen, resetBlocks]);
  
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
        
        const newPage = await createPage(pageName.trim());
        if (newPage) {
          openNode(newPage.id, 'page');
          onClose();
        }
      } else {
        // Create blocks mode
        if (!destinationPage) return;
        await createBlocks(destinationPage.id);
      }
    } catch (error) {
      console.error('Failed to create:', error);
    }
  };
  
  const canSubmit = createType === 'page' 
    ? pageName.trim().length > 0
    : destinationPage !== null && hasContent;
  
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
              <TextField
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
                    <TextField
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
                      icon={<SearchIcon size="sm" />}
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
                <Button
                  variant="ghost"
                  size="xs"
                  type="button"
                  className="quick-add-add-block-btn"
                  onClick={handleAddBlock}
                >
                  <AddIcon size="xs" /> Add block
                </Button>
              </div>
            </div>
          )}
          
          <div className="quick-add-actions">
            <Button type="button" variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button 
              type="submit" 
              variant="primary"
              disabled={!canSubmit || isCreating}
            >
              {createType === 'page' ? 'Create Page' : 'Send'}
            </Button>
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
