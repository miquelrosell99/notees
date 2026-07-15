/**
 * FloatingToolbar — Custom-editor replacement for FloatingToolbarPlugin.
 *
 * Shows a small formatting toolbar when the user makes a non-collapsed text
 * selection inside the editor root.
 */

import { useEffect, useLayoutEffect, useState, useCallback, useRef, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, computePosition, flip, offset, shift, type VirtualElement } from '@floating-ui/dom';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  astToUnits,
  getInlineChildren,
  getUnitLogicalSize,
  toggleMark,
} from '../model/inlineEditorModel';
import type { InlineEditorState, MarkType } from '../model/types';
import './FloatingToolbar.css';

interface FloatingToolbarProps {
  rootRef: React.RefObject<HTMLDivElement | null>;
  stateRef: React.MutableRefObject<InlineEditorState>;
  applyMutation: (mutator: (prev: InlineEditorState) => InlineEditorState) => void;
}

const MARKS: { mark: MarkType; label: string; icon: string }[] = [
  { mark: 'strong', label: 'Bold (Ctrl+B)', icon: 'mdi mdi-format-bold' },
  { mark: 'em', label: 'Italic (Ctrl+I)', icon: 'mdi mdi-format-italic' },
  { mark: 'underline', label: 'Underline (Ctrl+U)', icon: 'mdi mdi-format-underline' },
  { mark: 'strikethrough', label: 'Strikethrough (Ctrl+Shift+X)', icon: 'mdi mdi-format-strikethrough' },
  { mark: 'code', label: 'Inline code (Ctrl+E)', icon: 'mdi mdi-code-tags' },
];

function computeActiveMarks(state: InlineEditorState, start: number, end: number): Set<MarkType> {
  const units = astToUnits(getInlineChildren(state.ast));
  let offset = 0;
  const overlapping: Extract<typeof units[number], { type: 'text' }>[] = [];

  for (const unit of units) {
    const size = getUnitLogicalSize(unit);
    const unitStart = offset;
    const unitEnd = offset + size;

    if (unit.type !== 'atomic' && unitEnd > start && unitStart < end) {
      overlapping.push(unit);
    }
    offset += size;
  }

  const active = new Set<MarkType>();
  if (overlapping.length === 0) return active;

  const candidateMarks = new Set<MarkType>();
  for (const unit of overlapping) {
    for (const mark of unit.marks) {
      candidateMarks.add(mark);
    }
  }

  for (const mark of candidateMarks) {
    if (overlapping.every((unit) => unit.marks.includes(mark))) {
      active.add(mark);
    }
  }

  return active;
}

export function FloatingToolbar({ rootRef, stateRef, applyMutation }: FloatingToolbarProps): JSX.Element | null {
  const [isVisible, setIsVisible] = useState(false);
  const [activeMarks, setActiveMarks] = useState<Set<MarkType>>(new Set());
  const showTimeoutRef = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // Live selection Range the toolbar is anchored to. The virtual element below
  // re-reads its rect on every compute, so scroll, resize, and drag-selection
  // changes all reposition against the current selection.
  const rangeRef = useRef<Range | null>(null);
  // Latest Floating UI recompute, so the debounced selectionchange handler can
  // reposition the toolbar when the selection moves while it stays visible.
  const updatePositionRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const updateToolbar = () => {
      if (showTimeoutRef.current !== null) {
        window.clearTimeout(showTimeoutRef.current);
        showTimeoutRef.current = null;
      }

      const root = rootRef.current;
      if (!root || !root.contains(document.activeElement)) {
        setIsVisible(false);
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setIsVisible(false);
        return;
      }

      const range = selection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        setIsVisible(false);
        return;
      }

      const currentState = stateRef.current;
      const sel = currentState.selection;
      let start: number;
      let end: number;
      if (sel.type === 'collapsed') {
        setIsVisible(false);
        return;
      } else if (sel.type === 'range') {
        start = Math.min(sel.anchor, sel.focus);
        end = Math.max(sel.anchor, sel.focus);
      } else {
        start = sel.nodeIndex;
        end = sel.nodeIndex + 1;
      }

      if (start === end) {
        setIsVisible(false);
        return;
      }

      const rect = range.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        setIsVisible(false);
        return;
      }

      showTimeoutRef.current = window.setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
          setIsVisible(false);
          showTimeoutRef.current = null;
          return;
        }

        // Re-read the mutable model state so active marks match the latest
        // selection after any pending renders.
        const latestState = stateRef.current;
        const latestSel = latestState.selection;
        let latestStart = start;
        let latestEnd = end;
        if (latestSel.type === 'range') {
          latestStart = Math.min(latestSel.anchor, latestSel.focus);
          latestEnd = Math.max(latestSel.anchor, latestSel.focus);
        }
        setActiveMarks(computeActiveMarks(latestState, latestStart, latestEnd));

        const currentRange = sel.getRangeAt(0);
        const currentRect = currentRange.getBoundingClientRect();
        if (currentRect.width === 0 || currentRect.height === 0) {
          setIsVisible(false);
          showTimeoutRef.current = null;
          return;
        }

        rangeRef.current = currentRange;
        setIsVisible(true);
        // The selection may have moved while the toolbar was already visible
        // (drag selection) — recompute against the new range rect.
        updatePositionRef.current?.();
        showTimeoutRef.current = null;
      }, 150);
    };

    document.addEventListener('selectionchange', updateToolbar);
    return () => {
      document.removeEventListener('selectionchange', updateToolbar);
      if (showTimeoutRef.current !== null) {
        window.clearTimeout(showTimeoutRef.current);
      }
    };
  }, [rootRef, stateRef]);

  // Anchor the toolbar to the live selection with Floating UI: the virtual
  // element re-reads the Range rect on every compute, and autoUpdate re-runs
  // the compute on scroll (any ancestor), resize, element resize, and layout
  // shifts. flip() moves the toolbar above the selection when there is no room
  // below — the old hand-rolled positioning could not do that. top/left and
  // visibility are written straight to the toolbar element, so repositioning
  // never goes through React renders.
  useLayoutEffect(() => {
    if (!isVisible) {
      updatePositionRef.current = null;
      return;
    }
    const floating = toolbarRef.current;
    if (!floating) return;

    const reference: VirtualElement = {
      getBoundingClientRect: () =>
        rangeRef.current?.getBoundingClientRect() ?? new DOMRect(),
    };

    const update = () => {
      computePosition(reference, floating, {
        placement: 'bottom-start',
        strategy: 'fixed',
        middleware: [
          offset(8),
          flip({ padding: 8, fallbackPlacements: ['top-start'] }),
          shift({ padding: 8, crossAxis: true }),
        ],
      }).then(({ x, y }) => {
        floating.style.left = `${x}px`;
        floating.style.top = `${y}px`;
        floating.style.visibility = 'visible';
      });
    };

    updatePositionRef.current = update;
    update();
    return autoUpdate(reference, floating, update);
  }, [isVisible]);

  const handleFormat = useCallback(
    (mark: MarkType) => {
      applyMutation((prev) => toggleMark(prev, mark));
    },
    [applyMutation],
  );

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  if (!isVisible) return null;

  const toolbar = (
    <div
      ref={toolbarRef}
      className="floating-toolbar"
      data-editor-companion="true"
      style={{
        position: 'fixed',
        // Hidden until Floating UI's first compute writes top/left and flips
        // visibility to 'visible' — all imperatively, so repositioning never
        // goes through React renders.
        visibility: 'hidden',
        zIndex: 'var(--z-1000)',
        pointerEvents: 'auto',
      }}
      onMouseDown={handleMouseDown}
      role="toolbar"
      tabIndex={-1}
      aria-label="Text formatting"
    >
      <Card
        elevation="high"
        variant="default"
        padding={true}
        paddingSize="sm"
        radius="md"
        className="floating-toolbar__card"
      >
        <div className="floating-toolbar__actions">
          {MARKS.map(({ mark, label, icon }) => (
            <Button
              key={mark}
              aria-label={label}
              icon={icon}
              variant="ghost"
              size="sm"
              title={label}
              active={activeMarks.has(mark)}
              onClick={() => handleFormat(mark)}
              className="floating-toolbar__button"
            />
          ))}
        </div>
      </Card>
    </div>
  );

  return createPortal(toolbar, document.body);
}
