/**
 * ThreadLine — Modular, adaptive indentation guides and thread lines.
 *
 * Renders the vertical lines that connect a nested block to its ancestors.
 * The component is purely presentational: it knows its depth, whether this
 * row sits on the active editing path, and what to do when the clickable
 * thread line is activated. All positioning is derived from design tokens so
 * the lines stay aligned with bullets when spacing or bullet sizes change.
 *
 * Modes:
 *  - Idle (no block editing): only the single thread line aligned with the
 *    parent bullet is visible, and it is clickable to collapse/expand siblings.
 *  - Editing: every ancestor level renders a faint guide line so the tree
 *    structure is visible while focus is inside a block.
 *  - Active path: when this block is the edited block or one of its ancestors,
 *    all of this row's lines are highlighted with the primary color.
 */

import { memo, useCallback } from 'react';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import './ThreadLine.css';

export interface ThreadLineProps {
  /** Nesting depth of the current block (0 = top-level). */
  depth: number;
  /** True when this block is the active edited block or an ancestor of it. */
  isActivePath: boolean;
  /** Called when the clickable idle thread line is activated. */
  onClick?: () => void;
  /** Whether the clickable thread line accepts pointer events. */
  interactive?: boolean;
  /** If true, guide lines are rendered by a list-level overlay; this component only shows its own line. */
  useOverlayForGuides?: boolean;
}

interface LineDescriptor {
  level: number;
  isOwn: boolean;
}

function buildLines(depth: number): LineDescriptor[] {
  const lines: LineDescriptor[] = [];
  for (let level = 0; level < depth; level++) {
    lines.push({ level, isOwn: level === depth - 1 });
  }
  return lines;
}

export const ThreadLine = memo(function ThreadLine({
  depth,
  isActivePath,
  onClick,
  interactive = true,
  useOverlayForGuides = false,
}: ThreadLineProps) {
  const hasActiveEditor = useEditorFocusStore((s) => s.activeBlockId != null);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClick?.();
    },
    [onClick],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        onClick?.();
      }
    },
    [onClick],
  );

  if (depth <= 0) return null;

  const lines = buildLines(depth);
  const showGuides = hasActiveEditor && !useOverlayForGuides;
  const hideOwnVisual = useOverlayForGuides;

  return (
    <div
      className={`thread-line-system ${showGuides ? 'thread-line-system--editing' : ''} ${hideOwnVisual ? 'thread-line-system--overlay-guides' : ''} ${isActivePath ? 'thread-line-system--active-path' : ''}`}
      aria-hidden="true"
    >
      {lines.map(({ level, isOwn }) => (
        <div
          key={level}
          className={`thread-line ${isOwn ? 'thread-line--own' : 'thread-line--guide'}`}
          style={{ '--thread-line-level': level } as React.CSSProperties}
        >
          {isOwn && interactive && (
            <button
              type="button"
              className="thread-line__hit-area"
              onClick={handleClick}
              onKeyDown={handleKeyDown}
              tabIndex={-1}
              aria-label="Collapse/expand all children"
              title="Collapse/expand all children"
            />
          )}
          <span className="thread-line__visual" aria-hidden="true" />
          {showGuides && isActivePath && isOwn && (
            <span className="thread-line__connector" aria-hidden="true" />
          )}
        </div>
      ))}
    </div>
  );
});
