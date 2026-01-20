/**
 * Quick Add Panel - Minified quick capture for ButtonWithPanel
 * 
 * Shows a compact block capture interface:
 * - Block editor with auto-growing textarea
 * - Send button to create blocks
 * - Destination configured in settings (inbox or today)
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { mdiSend } from '@mdi/js';
import { useCreateNode, useTodayNote, usePages } from '@/hooks';
import { useSettingsStore } from '@/stores';
import { Button } from './Button';
import './QuickAddPanel.css';

interface QuickAddPanelProps {
  onClose?: () => void;
}

interface DraftBlock {
  id: number;
  content: string;
}

export function QuickAddPanel({ onClose }: QuickAddPanelProps) {
  const [draftBlocks, setDraftBlocks] = useState<DraftBlock[]>([{ id: 1, content: '' }]);
  const [nextBlockId, setNextBlockId] = useState(2);
  
  const inputRef = useRef<HTMLTextAreaElement>(null);
  
  const { quickAddDestination } = useSettingsStore();
  const createNode = useCreateNode();
  
  // Get today's note for 'today' destination
  const { data: todayNote } = useTodayNote();
  
  // Get all pages to find Inbox for 'inbox' destination
  const { data: allPages } = usePages();
  const inboxPage = allPages?.find(p => p.name === 'Inbox');
  
  // Determine the destination page based on setting
  const destinationPage = quickAddDestination === 'today' ? todayNote : inboxPage;
  
  // Focus input on mount
  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  }, []);
  
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
  
  const handleSend = async () => {
    if (!destinationPage) return;
    
    const nonEmptyBlocks = draftBlocks.filter(b => b.content.trim());
    if (nonEmptyBlocks.length === 0) return;
    
    console.log('[QuickAddPanel] Creating blocks:', {
      destination: quickAddDestination,
      destinationPage: { id: destinationPage.id, name: destinationPage.name },
      blocks: nonEmptyBlocks.map(b => b.content.trim()),
    });
    
    try {
      // Create blocks sequentially under the destination page
      for (const block of nonEmptyBlocks) {
        const nodeData = {
          name: block.content.trim(),
          parent_id: destinationPage.id,
        };
        console.log('[QuickAddPanel] Creating block:', nodeData);
        const newNode = await createNode.mutateAsync(nodeData);
        console.log('[QuickAddPanel] Block created:', newNode);
      }
      
      // Reset blocks
      setDraftBlocks([{ id: nextBlockId, content: '' }]);
      setNextBlockId(id => id + 1);
      
      // Close panel
      onClose?.();
    } catch (error) {
      console.error('Failed to create blocks:', error);
    }
  };
  
  const canSend = destinationPage && draftBlocks.some(b => b.content.trim());
  
  return (
    <div className="quick-add-panel">
      {/* Block editor area */}
      <div className="qap-blocks">
        {draftBlocks.map((block, index) => (
          <div key={block.id} className="qap-block">
            <span className="qap-block-bullet">•</span>
            <textarea
              ref={index === 0 ? inputRef : undefined}
              className="qap-block-input"
              value={block.content}
              onChange={(e) => handleBlockChange(block.id, e.target.value)}
              onKeyDown={(e) => handleBlockKeyDown(block.id, e)}
              placeholder={index === 0 ? "What's on your mind?" : ""}
              rows={1}
            />
          </div>
        ))}
      </div>
      
      {/* Send button */}
      <div className="qap-actions">
        <span className="qap-hint">
          → {quickAddDestination === 'today' ? "Today's page" : 'Inbox'}
        </span>
        <Button
          icon={mdiSend}
          variant="primary"
          size="sm"
          onClick={handleSend}
          disabled={!canSend || createNode.isPending}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

export default QuickAddPanel;
