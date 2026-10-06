/**
 * The topbar undo/redo buttons + the history menu with jump-to:
 *
 *  - TopBar renders the journal cluster from the state slice: disabled when
 *    empty, the live labels ("Undo edit text") as titles/aria labels, and
 *    the undo button's chevron opens the history popup.
 *  - historyKeyHandler (App.tsx): Ctrl/Cmd+Shift+H toggles, guarded from
 *    text fields and the outliner editor like the undo chords.
 *  - The journal's history(): the bounded undo stack oldest-first with
 *    labels, timestamps, and deduped affected ids (jump targets).
 *  - HistoryMenuPopup: browsable entries newest-first with labels + times,
 *    click jumps by opening the first affected node that still resolves,
 *    entries whose nodes are gone disable, Escape/outside close.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { EMPTY_UNDO_STATE } from "../src/core/undo-journal.js";
import { historyKeyHandler } from "../src/ui/App.js";
import { TopBar } from "../src/ui/components/TopBar.js";
import { HistoryMenuPopup } from "../src/ui/components/HistoryMenuPopup.js";
import type { SyncStatusSnapshot } from "../src/core/workspace-client.js";

const WS = "0192a000-0000-7000-8000-0000000000f1";
const ACTOR = "0192a000-0000-7000-8000-0000000000f2";

const SYNC: SyncStatusSnapshot = {
  status: "idle",
  error: null,
  pending: 0,
  failed: 0,
  quarantined: 0,
  parked: 0,
  realtime: false,
  cursorSeq: 0,
};

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

async function flushSync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => {});
}

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

describe("topbar undo/redo buttons", () => {
  it("renders disabled buttons with neutral labels on an empty journal, live labels when available", () => {
    const { rerender } = render(
      <TopBar
        syncStatus={SYNC}
        sidebarOpen
        rightPanelOpen={false}
        undoState={EMPTY_UNDO_STATE}
        onUndo={() => {}}
        onRedo={() => {}}
        onToggleSidebar={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );
    const undo = screen.getByRole("button", { name: "Undo" });
    const redo = screen.getByRole("button", { name: "Redo" });
    expect(undo).toHaveProperty("disabled", true);
    expect(redo).toHaveProperty("disabled", true);
    // The history chevron sits beside the undo button.
    expect(screen.getByRole("button", { name: "Toggle history" })).toBeDefined();

    rerender(
      <TopBar
        syncStatus={SYNC}
        sidebarOpen
        rightPanelOpen={false}
        undoState={{
          canUndo: true,
          canRedo: true,
          undoLabel: "Undo edit text",
          redoLabel: "Redo delete",
        }}
        onUndo={() => {}}
        onRedo={() => {}}
        onToggleSidebar={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );
    const liveUndo = screen.getByRole("button", { name: "Undo edit text" });
    expect(liveUndo).toHaveProperty("disabled", false);
    expect(liveUndo.getAttribute("title")).toBe("Undo edit text");
    expect(screen.getByRole("button", { name: "Redo delete" })).toHaveProperty("disabled", false);
  });

  it("runs the callbacks and hides the cluster without journal props", () => {
    const calls: string[] = [];
    render(
      <TopBar
        syncStatus={SYNC}
        sidebarOpen
        rightPanelOpen={false}
        undoState={{
          canUndo: true,
          canRedo: true,
          undoLabel: "Undo edit text",
          redoLabel: "Redo delete",
        }}
        onUndo={() => calls.push("undo")}
        onRedo={() => calls.push("redo")}
        onToggleHistory={() => calls.push("history")}
        onToggleSidebar={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo edit text" }));
    fireEvent.click(screen.getByRole("button", { name: "Redo delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle history" }));
    expect(calls).toEqual(["undo", "redo", "history"]);

    const { container } = render(
      <TopBar
        syncStatus={SYNC}
        sidebarOpen
        rightPanelOpen={false}
        onToggleSidebar={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );
    expect(container.querySelector(".nt-topbar-undo")).toBeNull();
  });
});

describe("historyKeyHandler — Ctrl/Cmd+Shift+H", () => {
  it("toggles on the chord, yields to text fields and the editor, ignores unmodified h", () => {
    const calls: string[] = [];
    const handler = historyKeyHandler({ onToggle: () => calls.push("toggle") });
    document.addEventListener("keydown", handler);

    document.dispatchEvent(key({ key: "H", ctrlKey: true, shiftKey: true }));
    document.dispatchEvent(key({ key: "h", metaKey: true, shiftKey: true }));
    // Guards: unmodified, no shift, Alt variant.
    document.dispatchEvent(key({ key: "h", ctrlKey: true }));
    document.dispatchEvent(key({ key: "h", ctrlKey: true, altKey: true, shiftKey: true }));
    // Text fields + contenteditable keep the keystroke.
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    document.body.append(input, editor);
    input.dispatchEvent(key({ key: "H", ctrlKey: true, shiftKey: true }));
    editor.dispatchEvent(key({ key: "H", metaKey: true, shiftKey: true }));
    input.remove();
    editor.remove();

    document.removeEventListener("keydown", handler);
    expect(calls).toEqual(["toggle", "toggle"]);
  });
});

describe("journal history", () => {
  it("lists the bounded stack oldest-first with labels, timestamps, and jump targets", async () => {
    const client = await seedClient();
    expect(await client.undoHistory()).toEqual([]);

    const a = await client.createObject({ presentAsMain: true, name: "Alpha" });
    const b = await client.createObject({ presentAsMain: true, name: "Beta" });
    await client.updateObject(a, { contentAst: [{ type: "text", text: "Alpha edited" }] });
    await client.updateObject(a, { contentAst: [{ type: "text", text: "Alpha edited twice" }] });
    await flushSync();

    const history = await client.undoHistory();
    // create A → create B → one coalesced text entry (two quick edits).
    expect(history.map((entry) => entry.verb)).toEqual(["create", "create", "edit text"]);
    expect(history[0]!.affected).toEqual([a]);
    expect(history[1]!.affected).toEqual([b]);
    expect(history[2]!.affected).toEqual([a]);
    expect(history[2]!.coalesceKey).toBe(`text:${a}`);
    for (const entry of history) expect(typeof entry.at).toBe("number");

    // Undoing moves the entry to the redo side — it leaves the browsable
    // history (the menu lists what you DID, not what you could redo).
    await client.undo();
    expect((await client.undoHistory()).map((entry) => entry.verb)).toEqual(["create", "create"]);
  });
});

describe("HistoryMenuPopup — browsable history with jump-to", () => {
  it("lists entries newest-first with labels + times; clicking jumps to the affected node", async () => {
    const client = await seedClient();
    const a = await client.createObject({ presentAsMain: true, name: "Alpha" });
    const b = await client.createObject({ presentAsMain: true, name: "Beta" });
    await client.updateObject(b, { contentAst: [{ type: "text", text: "Beta edited" }] });
    await flushSync();

    const anchorRef = { current: document.createElement("button") };
    const onOpenNode = vi.fn();
    const onClose = vi.fn();
    render(
      <HistoryMenuPopup
        client={client}
        isOpen
        onClose={onClose}
        anchorRef={anchorRef}
        onOpenNode={onOpenNode}
      />,
    );

    // Newest first: "Undo edit text" (the Beta edit) rides the top.
    const rows = await screen.findAllByRole("menuitem");
    expect(rows.length).toBe(3);
    expect(rows[0]!.textContent).toContain("Undo edit text");
    expect(rows[1]!.textContent).toContain("Undo create");
    expect(rows[2]!.textContent).toContain("Undo create");
    // Timestamps ride every row.
    expect(rows[0]!.querySelector(".history-popup__row-time")?.textContent).toMatch(/\d{1,2}:\d{2}/);

    // Jump: the text edit's affected node is Beta — clicking opens it and
    // closes the popup.
    fireEvent.click(rows[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenNode).toHaveBeenCalledWith(b);
    expect(a).not.toBe(b);
  });

  it("renders an honest empty state, disables entries whose nodes are gone, and closes on Escape", async () => {
    const client = await seedClient();
    // A detached anchor button stands in for the topbar chevron (jsdom
    // measures it at 0,0 — the popup positions and becomes visible).
    const anchor = { current: document.createElement("button") };
    const { rerender } = render(
      <HistoryMenuPopup
        client={client}
        isOpen
        onClose={() => {}}
        anchorRef={anchor}
        onOpenNode={() => {}}
      />,
    );
    await screen.findByText(/Nothing to undo yet/);

    // Journal an entry, then delete its node: the row lists disabled.
    const a = await client.createObject({ presentAsMain: true, name: "Gone soon" });
    await flushSync();
    await client.deleteObject(a, { permanent: true });
    await flushSync();
    rerender(
      <HistoryMenuPopup
        client={client}
        isOpen
        onClose={() => {}}
        anchorRef={anchor}
        onOpenNode={() => {}}
      />,
    );
    const row = (await screen.findAllByRole("menuitem"))[0]!;
    expect(row).toHaveProperty("disabled", true);
    expect(row.getAttribute("title")).toMatch(/no longer exists/);

    // Escape closes via the dismissal layer.
    const onClose = vi.fn();
    rerender(
      <HistoryMenuPopup
        client={client}
        isOpen
        onClose={onClose}
        anchorRef={anchor}
        onOpenNode={() => {}}
      />,
    );
    await screen.findAllByRole("menuitem");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
