/**
 * BlockCodePlugin — Renders a code-editor-style card with line numbers
 * for blocks that have nodeType === 'code'.
 *
 * Architecture (mirrors BlockClassPillsPlugin / AssetBlockPlugin):
 * - Scan the Lexical tree for BlockNodes with nodeType==='code'
 * - For each, find the '.node-block-code-gutter' DOM container
 * - Render a React portal there with line number spans
 * - Keep line counts in sync via MutationObserver (real-time typing)
 */

import {
  useEffect,
  useState,
  useCallback,
  useRef,
  type JSX,
} from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';
import { $isBlockNode } from '../nodes/BlockNode';
import { useVirtualization } from './VirtualizationPlugin';

// ─── Types ────────────────────────────────────────────────────────

interface CodeBlockInfo {
  blockId: string;
  gutterContainer: HTMLElement;
  contentEl: HTMLElement;
  lineCount: number;
}

// ─── Line Numbers Portal ──────────────────────────────────────────

function LineNumbers({ count }: { count: number }): JSX.Element {
  return (
    <div className="code-block-line-numbers">
      {Array.from({ length: count }, (_, i) => (
        <span key={i + 1} className="code-block-line-number">
          {i + 1}
        </span>
      ))}
    </div>
  );
}

// ─── Plugin ──────────────────────────────────────────────────────

export function BlockCodePlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [codeBlocks, setCodeBlocks] = useState<CodeBlockInfo[]>([]);
  const { visibleBlockIds, enabled: virtualizationEnabled } = useVirtualization();

  // Track MutationObservers per blockId so we can clean them up
  const observersRef = useRef<Map<string, MutationObserver>>(new Map());

  // Count lines in a contenteditable element:
  // Each <br> represents a line break → lineCount = brCount + 1
  const countLines = useCallback((contentEl: HTMLElement): number => {
    const brs = contentEl.querySelectorAll('br');
    return brs.length + 1;
  }, []);

  // Scan the Lexical tree for code blocks and build the info list
  const scanBlocks = useCallback(() => {
    const rootEl = editor.getRootElement();
    if (!rootEl) return;

    editor.getEditorState().read(() => {
      const root = $getRoot();
      const infos: CodeBlockInfo[] = [];
      const activeBlockIds = new Set<string>();

      for (const child of root.getChildren()) {
        if (!$isBlockNode(child)) continue;
        if (child.getNodeType() !== 'code') continue;

        const blockId = child.getBlockId();
        activeBlockIds.add(blockId);

        // Skip off-screen blocks when virtualization is active
        if (virtualizationEnabled && !visibleBlockIds.has(blockId)) continue;

        const blockEl = rootEl.querySelector(`[data-block-id="${blockId}"]`);
        if (!blockEl) continue;

        const gutterContainer = blockEl.querySelector('.node-block-code-gutter') as HTMLElement;
        const contentEl = blockEl.querySelector('.node-block-content') as HTMLElement;
        if (!gutterContainer || !contentEl) continue;

        const lineCount = countLines(contentEl);
        infos.push({ blockId, gutterContainer, contentEl, lineCount });
      }

      setCodeBlocks(infos);

      // Set up or clean up MutationObservers for real-time line tracking
      const obs = observersRef.current;

      // Remove observers for blocks no longer code-type or off-screen
      for (const [id, observer] of obs.entries()) {
        if (!activeBlockIds.has(id)) {
          observer.disconnect();
          obs.delete(id);
        }
      }

      // Add observers for new code blocks
      for (const info of infos) {
        if (obs.has(info.blockId)) continue; // already watching

        const observer = new MutationObserver(() => {
          const lines = countLines(info.contentEl);
          setCodeBlocks(prev =>
            prev.map(b =>
              b.blockId === info.blockId ? { ...b, lineCount: lines } : b,
            ),
          );
        });

        observer.observe(info.contentEl, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        obs.set(info.blockId, observer);
      }
    });
  }, [editor, countLines, virtualizationEnabled, visibleBlockIds]);

  // Re-scan when editor state changes
  useEffect(() => {
    scanBlocks();

    return editor.registerUpdateListener(({ dirtyElements, tags }) => {
      if (dirtyElements.size === 0 && !tags.has('runtime-sync')) return;
      Promise.resolve().then(scanBlocks);
    });
  }, [editor, scanBlocks, visibleBlockIds]);

  // Clean up all observers on unmount
  useEffect(() => {
    return () => {
      for (const observer of observersRef.current.values()) {
        observer.disconnect();
      }
      observersRef.current.clear();
    };
  }, []);

  if (codeBlocks.length === 0) return null;

  return (
    <>
      {codeBlocks.map(({ blockId, gutterContainer, lineCount }) =>
        createPortal(
          <LineNumbers count={lineCount} />,
          gutterContainer,
          blockId,
        ),
      )}
    </>
  );
}
