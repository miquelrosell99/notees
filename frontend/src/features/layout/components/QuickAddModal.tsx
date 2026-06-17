/**
 * QuickAddModal Component
 *
 * A modal dialog for quickly adding draft blocks to a destination page.
 */
import { useEffect, useRef, useCallback } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useQuickAdd } from '@/features/layout/hooks/useQuickAdd';
import { useTodayNote, usePages } from '@/hooks';
import { useSettingsStore } from '@/stores';
import './QuickAddModal.css';

interface QuickAddModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function QuickAddModal({ isOpen, onClose }: QuickAddModalProps) {
  const { quickAddDestination, setQuickAddDestination } = useSettingsStore();
  const { data: todayNote } = useTodayNote();
  const { data: allPages } = usePages();
  const inboxPage = allPages?.find((p) => p.name === 'Inbox');

  const {
    draftBlocks,
    handleBlockChange,
    handleBlockKeyDown,
    createBlocks,
    isCreating,
    hasContent,
  } = useQuickAdd({
    onSuccess: onClose,
    navigateOnSuccess: false,
  });

  const textareaMapRef = useRef<Map<number, HTMLTextAreaElement>>(new Map());
  const prevBlocksRef = useRef(draftBlocks);
  const hasFocusedOnOpenRef = useRef(false);

  // Focus first textarea when modal opens
  useEffect(() => {
    if (!isOpen) {
      hasFocusedOnOpenRef.current = false;
      return;
    }
    if (hasFocusedOnOpenRef.current) return;
    hasFocusedOnOpenRef.current = true;
    requestAnimationFrame(() => {
      const firstBlock = draftBlocks[0];
      if (firstBlock) {
        textareaMapRef.current.get(firstBlock.id)?.focus();
      }
    });
  }, [isOpen, draftBlocks]);

  // Auto-focus newly added or refocus after removal
  useEffect(() => {
    const prevBlocks = prevBlocksRef.current;
    const newBlocks = draftBlocks;

    if (newBlocks.length > prevBlocks.length) {
      const lastBlock = newBlocks[newBlocks.length - 1];
      requestAnimationFrame(() => {
        textareaMapRef.current.get(lastBlock.id)?.focus();
      });
    } else if (newBlocks.length < prevBlocks.length) {
      const removedIndex = prevBlocks.findIndex(
        (pb) => !newBlocks.some((nb) => nb.id === pb.id)
      );
      const focusBlock = prevBlocks[Math.max(0, removedIndex - 1)];
      if (focusBlock) {
        requestAnimationFrame(() => {
          textareaMapRef.current.get(focusBlock.id)?.focus();
        });
      }
    }

    prevBlocksRef.current = newBlocks;
  }, [draftBlocks]);

  const destinationPage = quickAddDestination === 'today' ? todayNote : inboxPage;
  const destinationPageId = destinationPage?.id;

  const handleSend = useCallback(async () => {
    if (!destinationPageId || !hasContent || isCreating) return;
    await createBlocks(destinationPageId);
  }, [destinationPageId, hasContent, isCreating, createBlocks]);

  const handleTextareaKeyDown = useCallback(
    (blockId: number, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSend();
        return;
      }
      handleBlockKeyDown(blockId, e);
    },
    [handleBlockKeyDown, handleSend]
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Quick Add"
      size="md"
      footer={
        <div className="quick-add-footer">
          <div className="quick-add-destination">
            <button
              type="button"
              className={`quick-add-destination-btn ${quickAddDestination === 'today' ? 'active' : ''}`}
              onClick={() => setQuickAddDestination('today')}
              title="Send to today's page"
            >
              Today
            </button>
            <button
              type="button"
              className={`quick-add-destination-btn ${quickAddDestination === 'inbox' ? 'active' : ''}`}
              onClick={() => setQuickAddDestination('inbox')}
              title="Send to Inbox"
            >
              Inbox
            </button>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSend}
            disabled={!hasContent || !destinationPageId || isCreating}
            icon="mdi mdi-send"
          >
            Send
          </Button>
        </div>
      }
    >
      <div className="quick-add-content">
        {draftBlocks.map((block) => (
          <textarea
            key={block.id}
            ref={(el) => {
              if (el) {
                textareaMapRef.current.set(block.id, el);
              } else {
                textareaMapRef.current.delete(block.id);
              }
            }}
            className="quick-add-textarea"
            rows={2}
            placeholder="Type something..."
            value={block.content}
            onChange={(e) => handleBlockChange(block.id, e.target.value)}
            onKeyDown={(e) => handleTextareaKeyDown(block.id, e)}
          />
        ))}
      </div>
    </Modal>
  );
}
