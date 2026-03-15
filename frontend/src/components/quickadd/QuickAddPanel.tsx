/**
 * Quick Add Panel - Capture blocks with full hierarchy support
 * 
 * Uses the real BlockEditor (Lexical) in draft mode so users can:
 * - Create multi-level block hierarchies (Tab/Shift+Tab to indent/outdent)
 * - Split blocks with Enter, merge with Backspace
 * - Full formatting support (bold, italic, links, etc.)
 * 
 * On "Send", extracts the block tree from the runtime and creates
 * all blocks on the destination page via API, preserving hierarchy.
 * 
 * NOTE: Moved out of core/ - has domain knowledge (uses hooks, stores)
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import { mdiSend } from '@mdi/js';
import { useTodayNote, usePages, useCreateNode } from '@/hooks';
import { useSettingsStore } from '@/stores';
import { Button } from '../core/Button';
import { BlockEditor } from '@/editor/BlockEditor';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { serializeContentAST } from '@/editor/editorConfig';
import type { GraphNode, ContentAST } from '@/runtime/types';
import './QuickAddPanel.css';

/** Stable virtual root ID for the quick-add draft tree */
const QUICK_ADD_ROOT_ID = '__quick-add-root__';

interface QuickAddPanelProps {
  onClose?: () => void;
}

export function QuickAddPanel({ onClose }: QuickAddPanelProps) {
  const { quickAddDestination } = useSettingsStore();
  const [isSending, setIsSending] = useState(false);
  const createNodeMutation = useCreateNode();
  
  // Track whether the editor has any content
  const [hasContent, setHasContent] = useState(false);
  
  // Get today's note for 'today' destination
  const { data: todayNote } = useTodayNote();
  
  // Get all pages to find Inbox for 'inbox' destination
  const { data: allPages } = usePages();
  const inboxPage = allPages?.find(p => p.name === 'Inbox');
  
  // Determine the destination page based on setting
  const destinationPage = quickAddDestination === 'today' ? todayNote : inboxPage;

  // Seed the runtime with an empty first block under the virtual root
  const initialBlockId = useRef(crypto.randomUUID());
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    
    const runtime = getNodeGraphRuntime();
    const emptyAST: ContentAST = [{ children: [{ text: '' }] }];
    
    // Create the initial empty block as a child of the virtual root
    const graphNode: GraphNode = {
      blockId: initialBlockId.current,
      parentId: QUICK_ADD_ROOT_ID,
      orderIndex: 0,
      nodeType: 'block',
      contentAST: emptyAST,
      collapsed: false,
      isDeleted: false,
      isPage: false,
      classIds: [],
      tagIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      hasServerChildren: false,
    };
    
    runtime.upsertNodes([graphNode]);
  }, []);
  
  // Clean up draft blocks from runtime on unmount
  useEffect(() => {
    return () => {
      const runtime = getNodeGraphRuntime();
      const children = runtime.getChildren(QUICK_ADD_ROOT_ID);
      if (children.length > 0) {
        const allIds = [
          ...children.map(b => b.blockId),
          ...children.flatMap(b => runtime.getDescendants(b.blockId).map(d => d.blockId)),
        ];
        runtime.removeNodes(allIds);
      }
    };
  }, []);

  // Track content changes to enable/disable send button
  const handleContentChange = useCallback((_blockId: string, _content: string) => {
    const runtime = getNodeGraphRuntime();
    const children = runtime.getChildren(QUICK_ADD_ROOT_ID);
    const hasAny = children.some(child => {
      const content = serializeContentAST(child.contentAST);
      return content && content !== '' && content !== '[]' && content !== '[{"children":[{"text":""}]}]';
    });
    setHasContent(hasAny);
  }, []);

  // Recursively create blocks preserving hierarchy
  const createBlockTree = useCallback(async (
    parentServerId: number,
    children: GraphNode[],
  ) => {
    for (const child of children) {
      const content = serializeContentAST(child.contentAST);
      // Skip completely empty blocks (no content at all)
      const isEmpty = !content || content === '' || content === '[]' || content === '[{"children":[{"text":""}]}]';
      
      const runtime = getNodeGraphRuntime();
      const grandchildren = runtime.getChildren(child.blockId);
      
      // Skip empty leaves, but keep empty parents that have children
      if (isEmpty && grandchildren.length === 0) continue;
      
      const created = await createNodeMutation.mutateAsync({
        name: isEmpty ? '' : content,
        parent_id: parentServerId,
        sequence: child.orderIndex,
      });
      
      // Recurse into children
      if (grandchildren.length > 0) {
        await createBlockTree(created.id, grandchildren);
      }
    }
  }, [createNodeMutation]);

  const handleSend = useCallback(async () => {
    if (!destinationPage || isSending) return;
    
    setIsSending(true);
    try {
      const runtime = getNodeGraphRuntime();
      const topBlocks = runtime.getChildren(QUICK_ADD_ROOT_ID);
      
      if (topBlocks.length === 0) return;
      
      await createBlockTree(destinationPage.id, topBlocks);
      
      // Clean up draft blocks from runtime before closing
      const allDraftIds = [
        ...topBlocks.map(b => b.blockId),
        ...topBlocks.flatMap(b => runtime.getDescendants(b.blockId).map(d => d.blockId)),
      ];
      runtime.removeNodes(allDraftIds);
      
      onClose?.();
    } finally {
      setIsSending(false);
    }
  }, [destinationPage, isSending, createBlockTree, onClose]);

  const canSend = destinationPage && hasContent && !isSending;
  
  return (
    <div className="quick-add-panel">
      <div className="qap-editor">
        <BlockEditor
          editorId="quick-add"
          rootBlockId={QUICK_ADD_ROOT_ID}
          mode="list"
          draftMode
          placeholder="What's on your mind?"
          onContentChange={handleContentChange}
          hideProperties
        />
      </div>
      
      <div className="qap-actions">
        <span className="qap-hint">
          → {quickAddDestination === 'today' ? "Today's page" : 'Inbox'}
        </span>
        <Button
          icon={mdiSend}
          variant="primary"
          size="sm"
          onClick={handleSend}
          disabled={!canSend}
        >
          Send
        </Button>
      </div>
    </div>
  );
}

export default QuickAddPanel;
