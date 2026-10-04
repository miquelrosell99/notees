/**
 * ScratchpadCapture — the seeded scratchpad page's quick-capture surface
 * (§34.19 :1180, the Scratchpad row). A keyboard-first input pinned to the
 * top of the scratchpad page: type, press Enter, and the text lands as a
 * block appended to the page. Shift+Enter stays inside the draft; a multi-
 * line draft sends each non-empty line as its own block (the same ordering
 * the QuickAdd modal's send-all uses).
 *
 * The capture lives ON the page (not a floating panel — v1's transient popup
 * deliberately not ported; the v2 scratchpad is a real, persisted page whose
 * blocks are ordinary nodes). PageView mounts this only for the seeded
 * scratchpad page id, never embedded.
 */

import { useRef, useState } from "react";

import { SYSTEM_PAGE_UUIDS } from "@notees/domain";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Button } from "./ui/Button.js";
import "./ScratchpadCapture.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** The seeded scratchpad page id (exported for the PageView mount test). */
export const SCRATCHPAD_PAGE_ID: string = SYSTEM_PAGE_UUIDS.scratchpad;

export function ScratchpadCapture({ client }: { client: AnyClient }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  /** aria-live feedback for the last capture (keyboard users get no click echo). */
  const [lastCapture, setLastCapture] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = async () => {
    // One block per non-empty line, in draft order (blank lines collapse).
    const lines = draft
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length === 0 || busy) return;
    setBusy(true);
    try {
      for (const line of lines) {
        await client.createObject({
          parentId: SCRATCHPAD_PAGE_ID,
          contentAst: [{ type: "text", text: line }],
        });
      }
      setDraft("");
      setLastCapture(lines.length === 1 ? "Captured 1 block." : `Captured ${lines.length} blocks.`);
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nt-scratch-capture">
      <textarea
        ref={inputRef}
        className="nt-scratch-capture-input"
        rows={2}
        value={draft}
        placeholder="Capture a thought… (Enter to add, Shift+Enter for a new line)"
        aria-label="Scratchpad capture"
        onChange={(event) => {
          setDraft(event.target.value);
          setLastCapture(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="nt-scratch-capture-bar">
        <span className="nt-scratch-capture-live" role="status" aria-live="polite">
          {lastCapture ?? ""}
        </span>
        <Button
          variant="primary"
          size="sm"
          icon="mdi-send"
          disabled={draft.trim() === "" || busy}
          loading={busy}
          onClick={() => void send()}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
