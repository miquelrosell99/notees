/**
 * MarkToolbar — the floating mark-formatting bar shown while a block editor
 * selection is active. Buttons mirror the Ctrl/Cmd shortcuts
 * (B/I/Shift+X) and add highlight + code, plus the typed-link verb gesture
 * (verb button / Cmd+K) which opens the VerbPopover in the editor.
 * mousedown is prevented so the contentEditable keeps focus — a blur would
 * unmount the editor (and the toolbar) mid-click. Positioned above the
 * selection rect (fixed; jsdom rects are zero, which is harmless).
 */

import type { MouseEvent } from "react";

import type { Mark } from "@notees/protocol";

const BUTTONS: { mark: Mark; label: string; title: string }[] = [
  { mark: "bold", label: "B", title: "Bold" },
  { mark: "italic", label: "I", title: "Italic" },
  { mark: "strike", label: "S", title: "Strikethrough" },
  { mark: "highlight", label: "H", title: "Highlight" },
  { mark: "code", label: "<>", title: "Code" },
];

interface MarkToolbarProps {
  /** Viewport coordinates of the selection start (toolbar anchors above). */
  top: number;
  left: number;
  /** Marks every covered run carries (button active state). */
  activeMarks: readonly Mark[];
  onToggle: (mark: Mark) => void;
  /** Opens the typed-link verb popover over the selection. */
  onVerb: () => void;
}

export function MarkToolbar({ top, left, activeMarks, onToggle, onVerb }: MarkToolbarProps) {
  return (
    <div
      className="nt-mark-toolbar"
      role="toolbar"
      aria-label="Text marks"
      style={{ top, left }}
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => event.preventDefault()}
    >
      {BUTTONS.map(({ mark, label, title }) => (
        <button
          key={mark}
          type="button"
          title={title}
          aria-pressed={activeMarks.includes(mark)}
          className={
            activeMarks.includes(mark) ? "nt-mark-button nt-mark-active" : "nt-mark-button"
          }
          onClick={() => onToggle(mark)}
        >
          {label}
        </button>
      ))}
      <span className="nt-mark-sep" aria-hidden="true" />
      <button type="button" title="Link verb (Cmd+K)" className="nt-mark-button" onClick={onVerb}>
        →
      </button>
    </div>
  );
}
