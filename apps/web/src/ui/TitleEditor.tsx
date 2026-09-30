/**
 * TitleEditor — the page header's editable title. Pages carry a stored
 * `name` (SCHEMA.md name derivation: the stored name wins), committed via
 * stored name (their title lives in content), so the header displays the
 * derived content excerpt until the user types a real title. The DOM text is
 * managed imperatively (no children rendered), so external renames
 * rehydrate the header while it is not focused and caret/typing is never
 * disturbed. An empty name shows the "Untitled" placeholder (CSS :empty).
 */

import { useEffect, useRef } from "react";

import { deriveDisplayName } from "@notees/domain";

import type { ClientNode } from "@/core/workspace-client.js";

import { displayNameForSettings, isDatePageNode } from "./dateDisplay.js";
import { useOutliner } from "./outliner-context.js";

export function TitleEditor({ page }: { page: ClientNode }) {
  const { client } = useOutliner();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const draftRef = useRef(page.name ?? "");
  /** Last value WE wrote — guards the Enter→blur double commit. */
  const committedRef = useRef(page.name ?? "");

  // A date page's name IS its date: display it in the user's dateFormat and
  // don't offer renaming (the compact stored label must stay canonical for
  // sorting and date lookups). Identity comes from the deterministic date
  // id, so migrated pages with a null name still render formatted.
  if (isDatePageNode(page)) {
    return (
      <h1 className="nt-page-title" role="heading" aria-level={1}>
        {displayNameForSettings(page)}
      </h1>
    );
  }

  const commit = () => {
    const el = headingRef.current;
    const draft = el?.textContent ?? draftRef.current;
    draftRef.current = draft;
    if (draft === committedRef.current) return;
    // The derived excerpt is display-only: focusing and blurring without
    // typing must not persist it as a stored name (that would freeze a
    // title that should keep tracking the content).
    if (pageRef.current.name == null && draft === deriveDisplayName(pageRef.current)) return;
    committedRef.current = draft;
    void client.updateObject(pageRef.current.id, { name: draft });
  };

  useEffect(() => {
    const el = headingRef.current;
    if (el === null) return;
    el.textContent = page.name ?? deriveDisplayName(page);
    draftRef.current = page.name ?? "";
    committedRef.current = page.name ?? "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  useEffect(() => {
    const el = headingRef.current;
    if (el === null || document.activeElement === el) return;
    const shown = page.name ?? deriveDisplayName(page);
    if (el.textContent !== shown) el.textContent = shown;
    committedRef.current = page.name ?? "";
    // Wider than [page.name]: a null-named page's derived excerpt must
    // refresh as the content is edited.
  }, [page]);

  return (
    <h1
      ref={headingRef}
      className="nt-page-title nt-title-editable"
      contentEditable
      suppressContentEditableWarning
      role="heading"
      aria-level={1}
      spellCheck={false}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault(); // a title is single-line
          commit();
          headingRef.current?.blur();
        }
      }}
      onBlur={commit}
    />
  );
}
