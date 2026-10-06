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
 *
 * Clipboard: Ctrl/Cmd+C with no selection copies the page's node link
 * (`<origin>/<uuid>`) + toast (same contract as the block editor). A pasted
 * node link becomes the target's display name as plain text — a title
 * holds text only, so the mention token shape cannot live here.
 */

import { useEffect, useRef, type ClipboardEvent } from "react";

import type { ContentAst } from "@notees/protocol";

import type { ClientNode } from "@/core/workspace-client.js";
import { caretOffset, placeCaret, selectionOffsets } from "@/editor/selection.js";

import { displayNameForSettings, displayNameFromClient, isDatePageNode } from "./dateDisplay.js";
import { useOutliner } from "./outliner-context.js";
import { nodeLinkUrl, parseNodeLink } from "./nodeLink.js";
import { copyToClipboard } from "./components/modals/clipboard.js";
import { notificationStore } from "./components/ui/notificationStore.js";

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

  // These effects MUST stay above the date-page early return: that branch
  // can flip between renders (a title that merely LOOKS like a compact date
  // label renders static until its text stops parsing as one — typing
  // "20261006" then adding anything flips it), and hooks after the return
  // crashed the whole tree with React #310. Both effects no-op while the
  // static branch renders (headingRef unattached).
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

  /** Ctrl/Cmd+C with no selection: copy the page's node link + toast. */
  const copyPageLink = () => {
    const name = displayNameForSettings(pageRef.current);
    copyToClipboard(nodeLinkUrl(pageRef.current.id)).then(
      () => notificationStore.success("Node link copied", name),
      () => notificationStore.error("Couldn't copy", "Clipboard access was denied."),
    );
  };

  /**
   * A pasted node link resolves to the target's display name inserted as
   * plain text at the caret (titles are text-only). Anything else keeps
   * the contentEditable default; an unresolvable id pastes as raw text.
   * (Paste events carry no modifier state, so even Ctrl/Cmd+Shift+V takes
   * this path.)
   */
  const handlePaste = (event: ClipboardEvent<HTMLHeadingElement>) => {
    if (event.clipboardData === null) return;
    const targetId = parseNodeLink(event.clipboardData.getData("text/plain"));
    if (targetId === null) return;
    const name = displayNameFromClient(client, targetId);
    if (name === null) return;
    const el = headingRef.current;
    if (el === null) return;
    event.preventDefault();
    const caret = caretOffset(el) ?? el.textContent?.length ?? 0;
    const current = el.textContent ?? "";
    const next = current.slice(0, caret) + name + current.slice(caret);
    el.textContent = next;
    draftRef.current = next;
    placeCaret(el, caret + name.length);
    notificationStore.success("Node link pasted", name);
  };

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
          return;
        }
        const mod = event.metaKey || event.ctrlKey;
        if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c") {
          const el = headingRef.current;
          const range = el === null ? null : selectionOffsets(el);
          if (range === null || range.start === range.end) {
            event.preventDefault();
            copyPageLink();
          }
        }
      }}
      onPaste={handlePaste}
      onBlur={commit}
    />
  );
}
