/**
 * TitleEditor — the page header's editable title. Title-is-content
 * (SCHEMA.md 2026-10-01): a page's title IS its own text content — there is
 * no stored name field. The header edits the page node's content directly
 * (a page's content is text-only by store invariant); committing replaces
 * it with the single text token the user typed. The DOM text is managed
 * imperatively (no children rendered), so external edits rehydrate the
 * header while it is not focused and caret/typing is never disturbed. An
 * empty title stores empty content and the UI shows the "Untitled"
 * placeholder (CSS :empty).
 */

import { useEffect, useRef } from "react";

import type { ContentAst } from "@notees/protocol";

import type { ClientNode } from "@/core/workspace-client.js";

import { displayNameForSettings, isDatePageNode } from "./dateDisplay.js";
import { useOutliner } from "./outliner-context.js";

/** The page's own title text (its content is text-only). */
function titleTextOf(page: ClientNode): string {
  return page.contentAst
    .map((token) => ((token as { type?: string; text?: string }).text ?? ""))
    .join("");
}

export function TitleEditor({ page }: { page: ClientNode }) {
  const { client } = useOutliner();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const draftRef = useRef(titleTextOf(page));
  /** Last value WE wrote — guards the Enter→blur double commit. */
  const committedRef = useRef(titleTextOf(page));

  // A date page's title IS its date: display it in the user's dateFormat and
  // don't offer renaming (the compact content label must stay canonical for
  // sorting and date lookups). Identity comes from the deterministic date
  // id, so migrated pages with content-only labels still render formatted.
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
    // No-op guard: committing the text that is already the content (e.g. a
    // focus/blur without typing) writes nothing.
    if (draft === titleTextOf(pageRef.current)) return;
    committedRef.current = draft;
    const contentAst: ContentAst =
      draft === "" ? [] : [{ type: "text" as const, text: draft }];
    void client.updateObject(pageRef.current.id, { contentAst });
  };

  useEffect(() => {
    const el = headingRef.current;
    if (el === null) return;
    el.textContent = titleTextOf(page);
    draftRef.current = titleTextOf(page);
    committedRef.current = titleTextOf(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  useEffect(() => {
    const el = headingRef.current;
    if (el === null || document.activeElement === el) return;
    const shown = titleTextOf(page);
    if (el.textContent !== shown) el.textContent = shown;
    committedRef.current = titleTextOf(page);
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
