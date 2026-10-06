/**
 * TriggerPopup — popup for the editor's `/` trigger (slash commands).
 *
 * Ported from the archived editor chrome in its "inline" mode: the editor
 * block is the filter field — the popup has NO search input, does not steal
 * focus, and is fully controlled by the parent (query + highlighted index
 * in, highlight changes and command picks out). The parent editor forwards
 * ArrowUp/ArrowDown/Enter/Escape while the trigger text is live in the block.
 *
 * DOM is the archived popup's: `.trigger-popup` portal with a header, the
 * `.trigger-popup__list` of `.trigger-popup__command` rows (label + description),
 * and the footer hint row. Positioning adapts the archived Floating UI setup
 * to the shared manual placement helper (see overlay-position.ts): anchored
 * to the caret line, flips above when there is no room below, `top`/`left`
 * written imperatively.
 *
 * The command list carries only the block-type actions this editor's content
 * grammar can execute (see BlockTextEditor.runSlashCommand): the block-type
 * converts (text/quote/checkbox), hard_break, the external-URL link editor,
 * and the breadth rows — query (insert a query token + open the
 * builder), date (typed date → daily-page link), template
 * (flat template list instantiated at the caret), table
 * (container node classed `table`, one row + three cells; the
 * typed remainder is the column count).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { clampOverlayLeft, flipOverlayTop } from "./overlay-position.js";
import "./TriggerPopup.css";

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "text", label: "Text", description: "Plain text block" },
  { id: "quote", label: "Quote", description: "Format this block as a quote" },
  { id: "checkbox", label: "Task", description: "Convert block to task (checkbox)" },
  { id: "hard_break", label: "Line break", description: "Insert a hard line break" },
  { id: "url", label: "Add URL", description: "Add a URL link to external website" },
  { id: "query", label: "Query", description: "Insert a live query block" },
  { id: "date", label: "Date", description: "Link to a daily page (e.g. /date feb 14)" },
  { id: "template", label: "Template", description: "Create from a template at the caret" },
  { id: "table", label: "Table", description: "Insert a table — cells are blocks (e.g. /table 5)" },
  // Lockstep SHIPPED (GTK/Flutter v3.0.0): the `code_block` / `hr` token
  // parsers are released — authoring is live.
  { id: "code", label: "Code", description: "Convert block to a code block (e.g. /code python)" },
  { id: "hr", label: "Divider", description: "Insert a horizontal rule" },
];

/** localStorage-backed command usage counts (frequent commands rank first). */
const USAGE_STORAGE_KEY = "notees_slash_cmd_usage";

export function readSlashCommandUsage(): Record<string, number> {
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function bumpSlashCommandUsage(commandId: string): void {
  try {
    const usage = readSlashCommandUsage();
    const next = { ...usage, [commandId]: (usage[commandId] || 0) + 1 };
    localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota errors
  }
}

export interface TriggerPopupProps {
  /** Caret anchor in VIEWPORT coordinates: `top` = caret bottom, `caretTop` = caret top (the popup is position: fixed). */
  position: { top: number; left: number; caretTop: number };
  /** Text after the trigger in the block (the filter query). */
  query: string;
  /** Parent-owned keyboard highlight index. */
  selectedIndex: number;
  onHighlightChange: (index: number) => void;
  onSelectCommand: (commandId: string) => void;
  onClose: () => void;
}

export function TriggerPopup({
  position,
  query,
  selectedIndex,
  onHighlightChange,
  onSelectCommand,
  onClose,
}: TriggerPopupProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<"below" | "above">("below");
  const [isPositioned, setIsPositioned] = useState(false);

  // Filter + rank the commands exactly like the archived popup: the COMMAND
  // WORD (the first whitespace-separated token) matches label outranking
  // description; usage frequency breaks ties. Anything after the first word
  // is the picked command's argument (e.g. "/date feb 14", "/template meet")
  // and does not filter the command list — the slash boundary rule.
  const commandUsage = useMemo(readSlashCommandUsage, []);
  const commands = useMemo(() => {
    const lower = (query.trim().split(/\s+/)[0] ?? "").toLowerCase();
    const scored = SLASH_COMMANDS.map((c) => {
      const labelMatch = c.label.toLowerCase().includes(lower);
      const descMatch = c.description.toLowerCase().includes(lower);
      const textScore = (labelMatch ? 2 : 0) + (descMatch ? 1 : 0);
      return { cmd: c, textScore, freq: commandUsage[c.id] || 0 };
    }).filter((s) => s.textScore > 0 || !query);
    scored.sort((a, b) => {
      if (b.textScore !== a.textScore) return b.textScore - a.textScore;
      return b.freq - a.freq;
    });
    return scored.map((s) => s.cmd);
  }, [query, commandUsage]);

  const itemCount = commands.length;
  const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(0, itemCount - 1));

  // Keep the keyboard-highlighted list item visible as the selection moves.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector(".trigger-popup__item--selected") as HTMLElement | null;
    if (selected && typeof selected.scrollIntoView === "function") {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [effectiveSelectedIndex]);

  // Close on click outside (focus never leaves the editor in inline mode).
  useEffect(() => {
    const handler = (e: globalThis.MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Position the popup against a virtual element that spans the caret line
  // (caretTop → top). top/left are written imperatively so repositioning
  // (scroll, resize, flip) never goes through React renders; maxHeight when
  // flipped above keeps the popup clear of the caret.
  useLayoutEffect(() => {
    const floating = containerRef.current;
    if (!floating) return;

    const update = () => {
      const { top, placement: resolved } = flipOverlayTop(
        { top: position.caretTop, bottom: position.top, left: position.left },
        floating.offsetHeight,
        4,
        8,
      );
      floating.style.left = `${clampOverlayLeft(position.left, floating.offsetWidth, 8)}px`;
      floating.style.top = `${top}px`;
      setPlacement(resolved);
      setIsPositioned(true);
    };

    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
    };
  }, [position]);

  const header = (
    <div key="header" className="trigger-popup__header">
      / Commands
    </div>
  );

  const mainList = (
    <div key="main-list" ref={listRef} className="trigger-popup__list">
      {commands.length === 0 ? (
        <div className="trigger-popup__empty">
          {query ? "No matches" : "Type to filter commands"}
        </div>
      ) : (
        commands.map((cmd, index) => {
          const isSelected = index === effectiveSelectedIndex;
          return (
            <button
              key={cmd.id}
              className={`trigger-popup__command ${
                isSelected ? "trigger-popup__command--selected trigger-popup__item--selected" : ""
              }`}
              role="option"
              aria-selected={isSelected}
              onClick={() => onSelectCommand(cmd.id)}
              onMouseEnter={() => onHighlightChange(index)}
            >
              <span className="trigger-popup__command-label">{cmd.label}</span>
              <span className="trigger-popup__command-desc">{cmd.description}</span>
            </button>
          );
        })
      )}
    </div>
  );

  const footer = (
    <div key="footer" className="trigger-popup__footer">
      <span className="trigger-popup__hint">↵ Execute</span>
    </div>
  );

  const popup = (
    <div
      ref={containerRef}
      data-editor-companion
      className={`trigger-popup trigger-popup--slash trigger-popup--inline ${
        placement === "above" ? "trigger-popup--above" : ""
      }`}
      style={{
        position: "fixed",
        // top/left are written imperatively by the placement pass so
        // repositioning (scroll, resize, flip) never goes through React renders.
        zIndex: "var(--z-1000)",
        visibility: isPositioned ? "visible" : "hidden",
        maxHeight: placement === "above" ? position.caretTop - 4 : undefined,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      role="listbox"
      aria-label="/ Commands"
      tabIndex={-1}
    >
      {placement === "below" ? (
        <>
          {header}
          {mainList}
          {footer}
        </>
      ) : (
        <>
          {mainList}
          {footer}
          {header}
        </>
      )}
    </div>
  );

  return createPortal(popup, document.body);
}
