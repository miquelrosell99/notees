/**
 * CapturePopup — the inline picker opened by the `[[` (mention) and `#`
 * (class chip) triggers. Purely visual: the editor keeps the caret and
 * forwards keys (↑↓ Enter Esc), this renders the filtered candidates and
 * handles mouse picks. mousedown is prevented so the contentEditable never
 * blurs (a blur would unmount the editor mid-gesture). Fixed-positioned at
 * the caret anchor (jsdom rects are zero — harmless).
 */

import type { MouseEvent } from "react";

export interface CaptureCandidate {
  id: string;
  label: string;
}

interface CapturePopupProps {
  top: number;
  left: number;
  items: CaptureCandidate[];
  selectedIndex: number;
  /** Shown when the query has no candidates (the editor offers a plain-text fallback). */
  emptyHint: string;
  onPick: (id: string) => void;
}

export function CapturePopup({
  top,
  left,
  items,
  selectedIndex,
  emptyHint,
  onPick,
}: CapturePopupProps) {
  return (
    <div
      className="nt-capture-popup"
      role="listbox"
      aria-label="Capture suggestions"
      style={{ top, left }}
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => event.preventDefault()}
    >
      {items.length === 0 ? (
        <div className="nt-capture-empty">{emptyHint}</div>
      ) : (
        items.map((item, index) => (
          <div
            key={item.id}
            role="option"
            aria-selected={index === selectedIndex}
            className={
              index === selectedIndex ? "nt-capture-item nt-capture-selected" : "nt-capture-item"
            }
            onClick={() => onPick(item.id)}
          >
            {item.label}
          </div>
        ))
      )}
    </div>
  );
}
