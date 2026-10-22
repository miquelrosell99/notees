/**
 * FloatingToolbar — floating formatting bar shown while a text selection is
 * active inside the editor root.
 *
 * Ported from the archived editor chrome: same behavior — a
 * `selectionchange` listener with a 150 ms show debounce, the toolbar
 * anchored to the live selection Range, and `mousedown` prevented so the
 * contentEditable never blurs (a blur would unmount the editor mid-click).
 * The chrome composes the fleet kit: the panel is the fleet
 * `FloatingToolbar` (the elevated popup register — surface-container-high,
 * level-2 shadow, 4dp menu corner) and every action is a fleet ghost
 * `Button` (icon-only, sm — the visible box rides the button size token,
 * the 48dp floor lives on the invisible hit-area overlay).
 *
 * Positioning adaptations for this app shell (no Floating UI dependency):
 * placement is computed manually — below the selection rect with an 8 px
 * offset, flipping above when there is no room, and clamped horizontally into
 * the viewport; `top`/`left` are written imperatively on show and on
 * scroll/resize so repositioning never goes through React renders. The
 * toolbar stays `visibility: hidden` until the first compute.
 *
 * Mark set: the marks this editor's token grammar supports (bold / italic /
 * strike / highlight / code — see packages/protocol content grammar). A verb
 * button opens the typed-link VerbPopover, mirroring the Cmd+K gesture.
 *
 * The @ button carries two modes (owner 2026-10-22): a plain click opens
 * the node picker searching on the selected text (the Ctrl+L / @ contract);
 * Shift- or Ctrl/Cmd-click opens it with an EMPTY search — the pick links
 * the node with the original selected text as its custom label (the same
 * "label" mode as Ctrl/Cmd+Shift+L).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import type { Mark } from "@notees/protocol";

import { Button } from "../../components/ui/fleet/Button.js";
import { FloatingToolbar as FloatingToolbarPanel } from "../../components/ui/fleet/FloatingToolbar.js";
import { clampOverlayLeft, flipOverlayTop, rangeAnchorRect } from "./overlay-position.js";

const MARKS: { mark: Mark; label: string; icon: string }[] = [
  { mark: "bold", label: "Bold (Ctrl+B)", icon: "mdi-format-bold" },
  { mark: "italic", label: "Italic (Ctrl+I)", icon: "mdi-format-italic" },
  { mark: "strike", label: "Strikethrough (Ctrl+Shift+X)", icon: "mdi-format-strikethrough" },
  { mark: "highlight", label: "Highlight", icon: "mdi-format-color-highlight" },
  { mark: "code", label: "Code", icon: "mdi-code-tags" },
];

const VERB_LABEL = "Link verb (Cmd+K)";
const MENTION_LABEL =
  "Add link from text selection (Ctrl+L / @). Shift- or Ctrl-click: search empty and keep the selected text as the link label";

/** The @ button's two modes (see openMentionFromSelection in BlockTextEditor). */
export type MentionMode = "query" | "label";

interface FloatingToolbarProps {
  /** The editor root: the toolbar only shows for selections inside it. */
  rootRef: RefObject<HTMLElement | null>;
  /** Marks every covered run carries (button active state). */
  activeMarks: ReadonlySet<Mark>;
  onToggleMark: (mark: Mark) => void;
  /** Turns the selected text into a link: opens the node picker over the
   *  selection. "query" searches on the selected text; "label" searches
   *  empty and keeps the text as the link's custom label. */
  onMention: (mode: MentionMode) => void;
  /** Opens the typed-link verb popover over the selection. */
  onVerb: () => void;
}

export function FloatingToolbar({ rootRef, activeMarks, onToggleMark, onMention, onVerb }: FloatingToolbarProps) {
  const [isVisible, setIsVisible] = useState(false);
  const showTimeoutRef = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // Live selection Range the toolbar is anchored to. The positioning pass
  // re-reads its rect on every compute, so scroll, resize, and drag-selection
  // changes all reposition against the current selection.
  const rangeRef = useRef<Range | null>(null);

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

      showTimeoutRef.current = window.setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
          setIsVisible(false);
          showTimeoutRef.current = null;
          return;
        }
        const currentRange = sel.getRangeAt(0);
        if (!root.contains(currentRange.commonAncestorContainer)) {
          setIsVisible(false);
          showTimeoutRef.current = null;
          return;
        }
        rangeRef.current = currentRange;
        setIsVisible(true);
        showTimeoutRef.current = null;
      }, 150);
    };

    document.addEventListener("selectionchange", updateToolbar);
    return () => {
      document.removeEventListener("selectionchange", updateToolbar);
      if (showTimeoutRef.current !== null) {
        window.clearTimeout(showTimeoutRef.current);
      }
    };
  }, [rootRef]);

  // Anchor the toolbar to the live selection: the compute re-reads the Range
  // rect, flips above the selection when there is no room below, and clamps
  // horizontally into the viewport. top/left are written straight to the
  // toolbar element, so repositioning never goes through React renders.
  useLayoutEffect(() => {
    if (!isVisible) return;
    const floating = toolbarRef.current;
    if (!floating) return;

    const update = () => {
      const anchor = rangeAnchorRect(rangeRef.current);
      const { top } = flipOverlayTop(anchor, floating.offsetHeight, 8, 8);
      floating.style.left = `${clampOverlayLeft(anchor.left, floating.offsetWidth, 8)}px`;
      floating.style.top = `${top}px`;
      floating.style.visibility = "visible";
    };

    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [isVisible]);

  const handleMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
  }, []);

  const handleMentionClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      onMention(e.shiftKey || e.ctrlKey || e.metaKey ? "label" : "query");
    },
    [onMention],
  );

  if (!isVisible) return null;

  const toolbar = (
    <FloatingToolbarPanel
      ref={toolbarRef}
      data-editor-companion="true"
      style={{
        position: "fixed",
        // Hidden until the first compute writes top/left and flips
        // visibility to 'visible' — all imperatively, so repositioning never
        // goes through React renders.
        visibility: "hidden",
        zIndex: "var(--z-1000)",
        pointerEvents: "auto",
      }}
      onMouseDown={handleMouseDown}
      role="toolbar"
      tabIndex={-1}
      aria-label="Text formatting"
    >
      {MARKS.map(({ mark, label, icon }) => (
        <Button
          key={mark}
          icon={icon}
          variant="ghost"
          size="sm"
          aria-label={label}
          title={label}
          aria-pressed={activeMarks.has(mark)}
          active={activeMarks.has(mark)}
          onClick={() => onToggleMark(mark)}
        />
      ))}
      <Button
        icon="mdi-at"
        variant="ghost"
        size="sm"
        aria-label={MENTION_LABEL}
        title={MENTION_LABEL}
        onClick={handleMentionClick}
      />
      <Button
        icon="mdi-link-variant"
        variant="ghost"
        size="sm"
        aria-label={VERB_LABEL}
        title={VERB_LABEL}
        onClick={onVerb}
      />
    </FloatingToolbarPanel>
  );

  return createPortal(toolbar, document.body);
}
