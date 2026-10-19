/**
 * The code_block editing surface — the owed editor branch of the block
 * editor. A CodeTextarea-integrated editor (the kit primitive): typing is
 * debounced and writes the token's `text` through the standard content
 * path (client.updateObject, one op per debounce window), the language
 * hint survives untouched, and blur/Esc flushes and hands back to read
 * mode. Draft state is local (like the whiteboard's CardTextEditor) so
 * client notify re-renders never clobber the caret; a clean editor
 * re-syncs from remote edits. Extracted verbatim from
 * BlockTextEditor.tsx (Stage D monolith split).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ContentAst } from "@notees/protocol";

import { SAVE_DEBOUNCE_MS } from "./BlockTextEditor.js";
import type { ClientNode } from "@/core/workspace-client/index.js";
import { CodeTextarea } from "../../ui/components/ui/CodeTextarea.js";

/**
 * True when the block IS one code_block token (the `/code` product): the
 * editor swaps the prose contentEditable for the code surface (the owed
 * code editor) — the token's `text` is edited verbatim (a textarea, not the
 * prose projection, which skips code tokens) and the language badge stays.
 */
export function codeTokenOf(ast: readonly unknown[]): { language?: string; text: string } | null {
  if (ast.length !== 1) return null;
  const token = ast[0];
  if (typeof token !== "object" || token === null) return null;
  const t = token as { type?: unknown; language?: unknown; text?: unknown };
  if (t.type !== "code_block" || typeof t.text !== "string") return null;
  return { ...(typeof t.language === "string" ? { language: t.language } : {}), text: t.text };
}

/**
 * The code_block editing surface — the owed editor branch. A
 * CodeTextarea-integrated editor (the kit primitive): typing is debounced
 * and writes the token's `text` through the standard content path
 * (client.updateObject, one op per debounce window), the language hint
 * survives untouched, and blur/Esc flushes and hands back to read mode.
 * Draft state is local (like the whiteboard's CardTextEditor) so client
 * notify re-renders never clobber the caret; a clean editor re-syncs from
 * remote edits.
 */
export function CodeBlockEditor({
  node,
  client,
  onExit,
}: {
  node: ClientNode;
  client: { getNode(id: string): ClientNode | undefined; updateObject(id: string, fields: { contentAst: ContentAst }): Promise<void> };
  onExit: () => void;
}) {
  const initial = codeTokenOf(node.contentAst);
  const [draft, setDraft] = useState(initial?.text ?? "");
  // The draft lives in state for the controlled textarea and in a ref for the
  // debounced flush (the callback must read the freshest text).
  const draftRefText = useRef(draft);
  draftRefText.current = draft;
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nodeRef = useRef(node);
  nodeRef.current = node;
  const language = initial?.language ?? null;

  const write = useCallback(
    (text: string) => {
      const current = nodeRef.current;
      const token = codeTokenOf(current.contentAst);
      if (token === null || token.text === text) return;
      const next = [
        {
          type: "code_block" as const,
          ...(token.language !== undefined ? { language: token.language } : {}),
          text,
        },
      ] as ContentAst;
      if (JSON.stringify(next) !== JSON.stringify(current.contentAst)) {
        void client.updateObject(current.id, { contentAst: next });
      }
    },
    [client],
  );

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    write(draftRefText.current);
  }, [write]);

  // Remote edits re-project while the local draft is clean; a dirty draft
  // (the caret is in the textarea) wins until its flush lands.
  useEffect(() => {
    if (dirtyRef.current) return;
    const token = codeTokenOf(nodeRef.current.contentAst);
    setDraft(token?.text ?? "");
  }, [node.contentAst]);

  // Unmount flush (a blurred-away surface never loses its last keystrokes).
  useEffect(() => () => flush(), [flush]);

  return (
    <span className="nt-code-editor" data-editor-companion>
      <span className="nt-code-block">
        {language !== null && <span className="nt-code-block__lang">{language}</span>}
        <CodeTextarea
          value={draft}
          onChange={(value) => {
            dirtyRef.current = true;
            setDraft(value);
            if (timerRef.current !== null) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
              dirtyRef.current = false;
              write(value);
            }, SAVE_DEBOUNCE_MS);
          }}
          className="nt-code-editor__area"
          label="Code"
          id={`code-editor-${node.id}`}
          autoFocus
          onBlur={() => {
            flush();
            onExit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              flush();
              onExit();
            }
          }}
        />
      </span>
    </span>
  );
}
