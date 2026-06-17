/**
 * TransclusionPopover — floating, read-only preview of an embedded node.
 *
 * Triggered by hover/click on an embed pill. Shows the target node's name
 * and up to one level of children. The preview is never editable inline.
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import { useNodeByUuid } from '@/features/content/hooks/useNodeQueries';
import { nodeNameToText } from '@/features/queries/hooks/useStringifyAST';
import { parseAST } from '@/lib/astBuilder';
import { Icon } from '@/components/ui/icons';
import type { Node as ApiNode } from '@/types';
import './TransclusionPopover.css';

interface TransclusionPopoverProps {
  /** Target node UUID to preview. */
  nodeUuid: string;
  /** Element the popover should be anchored to. */
  anchorEl: HTMLElement;
  /** Called when the popover should close. */
  onClose: () => void;
}

function ChildPreview({ child }: { child: ApiNode }): JSX.Element {
  const ast = parseAST(child.name);
  const text = nodeNameToText(ast) || '[Empty block]';
  return (
    <li className="transclusion-popover__child">
      <span className="transclusion-popover__bullet" aria-hidden="true" />
      <span className="transclusion-popover__child-text">{text}</span>
    </li>
  );
}

export function TransclusionPopover({ nodeUuid, anchorEl, onClose }: TransclusionPopoverProps) {
  const { data: node, isLoading, error } = useNodeByUuid(nodeUuid, { include_children: true });
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Position the popover below the anchor, flipping upward if needed.
  useEffect(() => {
    const anchorRect = anchorEl.getBoundingClientRect();
    const popoverEl = popoverRef.current;
    const width = popoverEl?.offsetWidth ?? 320;
    const height = popoverEl?.offsetHeight ?? 240;

    const padding = 8;
    let left = anchorRect.left;
    let top = anchorRect.bottom + padding;

    if (left + width > window.innerWidth - padding) {
      left = Math.max(padding, window.innerWidth - width - padding);
    }
    if (top + height > window.innerHeight - padding) {
      top = Math.max(padding, anchorRect.top - height - padding);
    }

    setPosition({ top, left });
  }, [anchorEl]);

  // Close on Escape and clicks outside the popover.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }

    function handlePointerDown(e: PointerEvent) {
      const target = e.target as EventTarget | null;
      if (!target || !(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorEl.contains(target)) return;
      onClose();
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [anchorEl, onClose]);

  const nameText = node ? nodeNameToText(node.name) || '[Untitled]' : '';
  const children = node?.children?.slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)) ?? [];

  return (
    <div
      ref={popoverRef}
      className="transclusion-popover"
      style={{ top: position.top, left: position.left }}
      role="dialog"
      aria-label={`Transclusion preview of ${nameText}`}
    >
      <div className="transclusion-popover__header">
        <Icon path="mdi-cube-outline" size="14px" />
        <span className="transclusion-popover__title">
          {isLoading ? 'Loading embed…' : error ? 'Could not load embed' : `Embed: ${nameText}`}
        </span>
      </div>

      <div className="transclusion-popover__body">
        {isLoading && <span className="transclusion-popover__empty">Loading…</span>}
        {error && <span className="transclusion-popover__empty">Failed to load preview.</span>}
        {!isLoading && !error && node && (
          <>
            {children.length > 0 ? (
              <ul className="transclusion-popover__children">
                {children.map((child) => (
                  <ChildPreview key={child.id} child={child} />
                ))}
              </ul>
            ) : (
              <span className="transclusion-popover__empty">No content to preview.</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
