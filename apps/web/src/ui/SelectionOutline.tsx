/**
 * SelectionOutline — the card-style outline around the block multi-selection.
 *
 * The selection set is always whole-subtree (outliner-context closes every
 * write over descendants), so the selected rows form contiguous vertical
 * runs — and each run renders as ONE card: an absolutely-positioned box
 * spanning the selection surface's full width, from the first run row's top
 * to the last run row's bottom (children of a selected block sit inside that
 * span by construction). Disjoint selections (Ctrl/Cmd-click toggles) get one
 * card per run.
 *
 * Measurement: the run rects are read from the DOM (row wrappers carry
 * `data-block-id`) relative to the selection surface, so the cards scroll
 * with the content by construction (absolute inside the surface). A recompute
 * rides every render of this component (cheap: one querySelectorAll pass,
 * state updates only when a rect actually moved) plus window resize — layout
 * shifts while the selection is live (an expand, an edit) re-wrap the card on
 * the next parent render. jsdom rects are zero: the cards collapse to
 * zero-size boxes, harmless for tests.
 */

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

interface SelectionOutlineProps {
  /** The selection surface root (`.nt-select-surface`) — the positioning context. */
  surfaceRef: RefObject<HTMLElement | null>;
  /** The live selection (whole-subtree closed). */
  selection: ReadonlySet<string>;
}

interface OutlineRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Rects equal within half a pixel — the compare that guards setState. */
function sameRects(a: readonly OutlineRect[], b: readonly OutlineRect[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i]!;
    const rb = b[i]!;
    if (
      Math.abs(ra.top - rb.top) > 0.5 ||
      Math.abs(ra.left - rb.left) > 0.5 ||
      Math.abs(ra.width - rb.width) > 0.5 ||
      Math.abs(ra.height - rb.height) > 0.5
    ) {
      return false;
    }
  }
  return true;
}

export function SelectionOutline({ surfaceRef, selection }: SelectionOutlineProps) {
  const [rects, setRects] = useState<OutlineRect[]>([]);
  const rectsRef = useRef<OutlineRect[]>([]);

  useLayoutEffect(() => {
    const compute = () => {
      const surface = surfaceRef.current;
      if (surface === null || selection.size === 0) {
        if (rectsRef.current.length !== 0) {
          rectsRef.current = [];
          setRects([]);
        }
        return;
      }
      const surfaceRect = surface.getBoundingClientRect();
      const rows = Array.from(surface.querySelectorAll<HTMLElement>("[data-block-id]"));
      const runs: OutlineRect[] = [];
      let runStart: HTMLElement | null = null;
      let runEnd: HTMLElement | null = null;
      const flush = () => {
        if (runStart === null || runEnd === null) return;
        const top = runStart.getBoundingClientRect().top - surfaceRect.top;
        const bottom = runEnd.getBoundingClientRect().bottom - surfaceRect.top;
        runs.push({ top, left: 0, width: surface.clientWidth, height: Math.max(0, bottom - top) });
      };
      for (const row of rows) {
        const id = row.getAttribute("data-block-id");
        if (id !== null && selection.has(id)) {
          if (runStart === null) runStart = row;
          runEnd = row;
        } else {
          flush();
          runStart = null;
          runEnd = null;
        }
      }
      flush();
      if (!sameRects(rectsRef.current, runs)) {
        rectsRef.current = runs;
        setRects(runs);
      }
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
    // No dependency array: recompute after EVERY render (parent renders on
    // any store notify — edits/expands re-wrap the card), not just on
    // selection identity changes.
  });

  if (rects.length === 0) return null;
  return (
    <>
      {rects.map((rect, index) => (
        <div
          key={index}
          className="nt-selection-outline"
          aria-hidden="true"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
        />
      ))}
    </>
  );
}
