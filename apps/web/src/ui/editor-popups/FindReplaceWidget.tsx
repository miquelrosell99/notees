/**
 * FindReplaceWidget — floating find & replace toolbar over the block tree.
 *
 * Ported from the archived editor chrome: same DOM (`.find-replace-widget`
 * with find/replace rows, count, ghost icon buttons) and the same behavior —
 * live search while typing, replace section collapsed behind the chevron
 * (or Ctrl/Cmd+H, traditional behavior), Enter jumps to the next match,
 * Escape closes. The archived widget read its state from a global store and
 * searched per-block editor handles; this port holds the state locally and
 * searches the block tree's prose documents (block-find-replace.ts), and the
 * parent PageView performs the writes through the workspace client.
 *
 * Matching blocks are highlighted in the tree: every block carrying a match
 * gets `.find-replace-hit`, the current match's block gets
 * `.find-replace-current` and is scrolled into view (block-level highlight —
 * the archived widget selected the match range inside a live editor; this
 * app's blocks are read-mode rows until clicked).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../Icon.js";
import { executeBlockSearch, type BlockMatch } from "./block-find-replace.js";
import "./FindReplaceWidget.css";

interface FindReplaceWidgetProps {
  /** Searchable block documents (id + prose projection), refreshed with the tree. */
  blocks: readonly { id: string; prose: string }[];
  /** Perform one replace write (the parent owns the workspace client). */
  onReplace: (blockId: string, start: number, end: number, text: string) => void;
  /** The page root: matching blocks are highlighted inside it. */
  highlightRootRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

export function FindReplaceWidget({ blocks, onReplace, highlightRootRef, onClose }: FindReplaceWidgetProps) {
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [replaceExpanded, setReplaceExpanded] = useState(false);

  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    findInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (replaceExpanded) {
      replaceInputRef.current?.focus();
    }
  }, [replaceExpanded]);

  // A new query (or case toggle) restarts the walk at the first match —
  // the archived widget's runSearch behavior.
  useEffect(() => {
    setMatchIndex(0);
  }, [query, caseSensitive]);

  const matches = useMemo(
    () => executeBlockSearch(blocks, query, caseSensitive),
    [blocks, query, caseSensitive],
  );
  const totalMatches = matches.length;
  const effectiveIndex = Math.min(matchIndex, Math.max(0, totalMatches - 1));

  // Highlight the matching blocks + scroll the current one into view.
  useEffect(() => {
    const root = highlightRootRef.current;
    if (!root) return;
    const clear = () => {
      root
        .querySelectorAll(".find-replace-hit, .find-replace-current")
        .forEach((el) => el.classList.remove("find-replace-hit", "find-replace-current"));
    };
    clear();
    const hitBlocks = new Set(matches.map((m) => m.blockId));
    for (const blockId of hitBlocks) {
      root.querySelector(`[data-block-id="${blockId}"]`)?.classList.add("find-replace-hit");
    }
    const current = matches[effectiveIndex];
    if (current !== undefined) {
      const el = root.querySelector(`[data-block-id="${current.blockId}"]`);
      if (el !== null) {
        el.classList.add("find-replace-current");
        if (typeof (el as HTMLElement).scrollIntoView === "function") {
          (el as HTMLElement).scrollIntoView({ block: "nearest" });
        }
      }
    }
    return clear;
  }, [matches, effectiveIndex, highlightRootRef]);

  // Global hotkeys while the widget is open: Escape closes from anywhere
  // (mirrors the archived page-level plugin), Ctrl/Cmd+H toggles replace.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setReplaceExpanded((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const goNext = useCallback(() => {
    if (matches.length === 0) return;
    setMatchIndex((i) => {
      const next = (Math.min(i, matches.length - 1) + 1) % matches.length;
      return next;
    });
  }, [matches.length]);

  const goPrev = useCallback(() => {
    if (matches.length === 0) return;
    setMatchIndex((i) => (Math.min(i, matches.length - 1) - 1 + matches.length) % matches.length);
  }, [matches.length]);

  const handleReplace = useCallback(() => {
    if (matches.length === 0 || !replaceText) return;
    const match = matches[effectiveIndex];
    if (match === undefined) return;
    onReplace(match.blockId, match.offset, match.offset + match.length, replaceText);
    // The block list refreshes with the write; the remaining matches slide
    // down one slot, so the same index lands on the next match (the archived
    // widget recomputed exactly this adjustment).
  }, [matches, effectiveIndex, replaceText, onReplace]);

  const handleReplaceAll = useCallback(() => {
    if (matches.length === 0 || !replaceText) return;
    // Sort last-to-first so offsets stay valid as each write lands (the
    // archived widget grouped by editor and processed last-to-first).
    const sorted: BlockMatch[] = [...matches].sort((a, b) =>
      a.blockId !== b.blockId ? 0 : b.offset - a.offset,
    );
    for (const match of sorted) {
      onReplace(match.blockId, match.offset, match.offset + match.length, replaceText);
    }
  }, [matches, replaceText, onReplace]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      goNext();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const widget = (
    <div
      className="find-replace-widget"
      data-editor-companion
      onKeyDown={onKeyDown}
      role="toolbar"
      aria-label="Find and replace"
      tabIndex={0}
    >
      <div className="find-replace-row">
        <button
          type="button"
          className="find-replace-btn find-replace-expand"
          onClick={() => setReplaceExpanded((v) => !v)}
          title={replaceExpanded ? "Hide replace" : "Show replace"}
          aria-label={replaceExpanded ? "Hide replace" : "Show replace"}
        >
          {replaceExpanded ? (
            <Icon path="mdi-chevron-down" size="sm" />
          ) : (
            <Icon path="mdi-chevron-right" size="sm" />
          )}
        </button>
        <input
          ref={findInputRef}
          type="text"
          className="find-replace-input"
          placeholder="Find..."
          aria-label="Find"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="find-replace-count">
          {totalMatches > 0 ? `${effectiveIndex + 1}/${totalMatches}` : "0/0"}
        </span>
        <button
          type="button"
          aria-label="Previous match"
          title="Previous match"
          className="btn btn--ghost btn--xs btn--icon-only find-replace-btn"
          onClick={goPrev}
          disabled={totalMatches === 0}
        >
          <Icon path="mdi-chevron-up" size="sm" className="btn__icon btn__icon--left" />
        </button>
        <button
          type="button"
          aria-label="Next match"
          title="Next match"
          className="btn btn--ghost btn--xs btn--icon-only find-replace-btn"
          onClick={goNext}
          disabled={totalMatches === 0}
        >
          <Icon path="mdi-chevron-up" size="sm" className="btn__icon btn__icon--left" />
        </button>
        <button
          type="button"
          className={`find-replace-btn ${caseSensitive ? "active" : ""}`}
          onClick={() => setCaseSensitive((v) => !v)}
          title="Match case"
          aria-label="Match case"
          aria-pressed={caseSensitive}
        >
          Aa
        </button>
        <button
          type="button"
          aria-label="Close find and replace"
          title="Close find and replace"
          className="btn btn--ghost btn--xs btn--icon-only find-replace-btn find-replace-close"
          onClick={onClose}
        >
          <Icon path="mdi-close" size="sm" className="btn__icon btn__icon--left" />
        </button>
      </div>
      {replaceExpanded && (
        <div className="find-replace-row">
          <span className="find-replace-spacer" />
          <input
            ref={replaceInputRef}
            type="text"
            className="find-replace-input"
            placeholder="Replace..."
            aria-label="Replace"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
          />
          <button
            type="button"
            className="find-replace-btn"
            onClick={handleReplace}
            disabled={totalMatches === 0}
          >
            Replace
          </button>
          <button
            type="button"
            className="find-replace-btn"
            onClick={handleReplaceAll}
            disabled={totalMatches === 0}
          >
            Replace All
          </button>
        </div>
      )}
    </div>
  );

  return createPortal(widget, document.body);
}
