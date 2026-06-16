/**
 * BulletLine — Per-row indentation guide line fallback.
 *
 * Renders the vertical lines that connect a nested block to its ancestors.
 * The list-level BulletLineOverlay is the preferred renderer; this component
 * is a fallback for contexts without the overlay.
 */

import { memo, useCallback } from 'react';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import './BulletLine.css';

export interface BulletLineProps {
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

export const BulletLine = memo(function BulletLine({
  depth,
  isActivePath,
  onClick,
  interactive = true,
  useOverlayForGuides = false,
}: BulletLineProps) {
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
      className={`bullet-line-system ${showGuides ? 'bullet-line-system--editing' : ''} ${hideOwnVisual ? 'bullet-line-system--overlay-guides' : ''} ${isActivePath ? 'bullet-line-system--active-path' : ''}`}
      aria-hidden="true"
    >
      {lines.map(({ level, isOwn }) => (
        <div
          key={level}
          className={`bullet-line ${isOwn ? 'bullet-line--own' : 'bullet-line--guide'}`}
          style={{ '--bullet-line-level': level } as React.CSSProperties}
        >
          {isOwn && interactive && (
            <button
              type="button"
              className="bullet-line__hit-area"
              onClick={handleClick}
              onKeyDown={handleKeyDown}
              tabIndex={-1}
              aria-label="Collapse/expand all children"
              title="Collapse/expand all children"
            />
          )}
          <span className="bullet-line__visual" aria-hidden="true" />
          {showGuides && isActivePath && isOwn && (
            <span className="bullet-line__connector" aria-hidden="true" />
          )}
        </div>
      ))}
    </div>
  );
});
