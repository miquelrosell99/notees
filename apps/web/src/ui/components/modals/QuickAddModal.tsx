/**
 * QuickAddModal Component
 *
 * A modal dialog for quickly adding draft blocks to a destination page
 * (Ctrl/Cmd+Shift+N). The destination toggles between today's journal page
 * and the Inbox page.
 */
import { useEffect, useRef, useCallback, useState } from "react";
import { Modal } from "../ui/Modal.js";
import { Button } from "../ui/Button.js";
import { useQuickAdd } from "./useQuickAdd";
import type { WorkspaceClient } from "@/core/workspace-client.js";
import type { WorkerClient } from "@/core/worker-client.js";
import "./QuickAddModal.css";

export type QuickAddDestination = "today" | "inbox";

const DESTINATION_STORAGE_KEY = "notees.quickAddDestination";

const readStoredDestination = (): QuickAddDestination => {
  try {
    return localStorage.getItem(DESTINATION_STORAGE_KEY) === "inbox" ? "inbox" : "today";
  } catch {
    return "today";
  }
};

/** Today's date as a strict local YYYY-MM-DD (the date-chain id input). */
function todayIsoDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

interface QuickAddModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The workspace data surface the quick capture writes through. */
  client: Pick<WorkspaceClient | WorkerClient, "createObject" | "listPages" | "ensureDateChain">;
}

export function QuickAddModal({ isOpen, onClose, client }: QuickAddModalProps) {
  const [quickAddDestination, setQuickAddDestinationState] = useState<QuickAddDestination>(
    readStoredDestination,
  );
  const setQuickAddDestination = useCallback((destination: QuickAddDestination) => {
    setQuickAddDestinationState(destination);
    try {
      localStorage.setItem(DESTINATION_STORAGE_KEY, destination);
    } catch {
      // Storage unavailable; the choice just won't persist.
    }
  }, []);

  const { draftBlocks, handleBlockChange, handleBlockKeyDown, createBlocks, isCreating, hasContent } =
    useQuickAdd(
      { createObject: (partial) => client.createObject(partial) },
      { onSuccess: onClose },
    );

  const textareaMapRef = useRef<Map<string, HTMLTextAreaElement>>(new Map());
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
        textareaMapRef.current.get(firstBlock.nodeUuid)?.focus();
      }
    });
  }, [isOpen, draftBlocks]);

  // Auto-focus newly added or refocus after removal
  useEffect(() => {
    const prevBlocks = prevBlocksRef.current;
    const newBlocks = draftBlocks;

    if (newBlocks.length > prevBlocks.length) {
      const lastBlock = newBlocks[newBlocks.length - 1];
      if (lastBlock) {
        requestAnimationFrame(() => {
          textareaMapRef.current.get(lastBlock.nodeUuid)?.focus();
        });
      }
    } else if (newBlocks.length < prevBlocks.length) {
      const removedIndex = prevBlocks.findIndex(
        (pb) => !newBlocks.some((nb) => nb.nodeUuid === pb.nodeUuid),
      );
      const focusBlock = prevBlocks[Math.max(0, removedIndex - 1)];
      if (focusBlock) {
        requestAnimationFrame(() => {
          textareaMapRef.current.get(focusBlock.nodeUuid)?.focus();
        });
      }
    }

    prevBlocksRef.current = newBlocks;
  }, [draftBlocks]);

  // Resolve the destination page id. Today's journal page is ensured on the
  // date chain (content-addressed ids make re-resolution free); the Inbox is
  // the page literally named "Inbox".
  const [destinationPageUuid, setDestinationPageUuid] = useState<string | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    if (quickAddDestination === "inbox") {
      const inbox = client.listPages().find((p) => p.name === "Inbox");
      if (!cancelled) setDestinationPageUuid(inbox?.id ?? null);
    } else {
      void client
        .ensureDateChain(todayIsoDate())
        .then((ids) => {
          if (!cancelled) setDestinationPageUuid(ids.day);
        })
        .catch(() => {
          if (!cancelled) setDestinationPageUuid(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [isOpen, quickAddDestination, client]);

  const handleSend = useCallback(async () => {
    if (!destinationPageUuid || !hasContent || isCreating) return;
    await createBlocks(destinationPageUuid);
  }, [destinationPageUuid, hasContent, isCreating, createBlocks]);

  const handleTextareaKeyDown = useCallback(
    (blockId: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void handleSend();
        return;
      }
      handleBlockKeyDown(blockId, e);
    },
    [handleBlockKeyDown, handleSend],
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
              className={`quick-add-destination-btn ${quickAddDestination === "today" ? "active" : ""}`}
              onClick={() => setQuickAddDestination("today")}
              title="Send to today's page"
            >
              Today
            </button>
            <button
              type="button"
              className={`quick-add-destination-btn ${quickAddDestination === "inbox" ? "active" : ""}`}
              onClick={() => setQuickAddDestination("inbox")}
              title="Send to Inbox"
            >
              Inbox
            </button>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSend()}
            disabled={!hasContent || !destinationPageUuid || isCreating}
            loading={isCreating}
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
            key={block.nodeUuid}
            ref={(el) => {
              if (el) {
                textareaMapRef.current.set(block.nodeUuid, el);
              } else {
                textareaMapRef.current.delete(block.nodeUuid);
              }
            }}
            className="quick-add-textarea"
            rows={2}
            placeholder="Type something..."
            value={block.content}
            onChange={(e) => handleBlockChange(block.nodeUuid, e.target.value)}
            onKeyDown={(e) => handleTextareaKeyDown(block.nodeUuid, e)}
          />
        ))}
      </div>
    </Modal>
  );
}
