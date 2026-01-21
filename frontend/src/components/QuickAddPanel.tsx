/**
 * Quick Add Panel - Minified quick capture for ButtonWithPanel
 * 
 * Shows a compact block capture interface:
 * - Block editor with auto-growing textarea
 * - Send button to create blocks
 * - Destination configured in settings (inbox or today)
 * 
 * NOTE: Moved out of core/ - has domain knowledge (uses hooks, stores)
 */
import { useRef, useEffect } from 'react';
import { mdiSend } from '@mdi/js';
import { useTodayNote, usePages, useQuickAdd } from '@/hooks';
import { useSettingsStore } from '@/stores';
import { Button } from './core/Button';
import './QuickAddPanel.css';

interface QuickAddPanelProps {
  onClose?: () => void;
}

export function QuickAddPanel({ onClose }: QuickAddPanelProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  
  const { quickAddDestination } = useSettingsStore();
  
  // Get today's note for 'today' destination
  const { data: todayNote } = useTodayNote();
  
  // Get all pages to find Inbox for 'inbox' destination
  const { data: allPages } = usePages();
  const inboxPage = allPages?.find(p => p.name === 'Inbox');
  
  // Determine the destination page based on setting
  const destinationPage = quickAddDestination === 'today' ? todayNote : inboxPage;
  
  // Use shared quick add logic
  const {
    draftBlocks,
    handleBlockChange,
    handleBlockKeyDown,
    createBlocks,
    isCreating,
    hasContent,
  } = useQuickAdd({
    onSuccess: onClose,
  });
  
  // Focus input on mount
  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  }, []);
  
  const handleSend = async () => {
    if (!destinationPage) return;
    await createBlocks(destinationPage.id);
  };
  
  const canSend = destinationPage && hasContent;
  
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
          disabled={!canSend || isCreating}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

export default QuickAddPanel;
