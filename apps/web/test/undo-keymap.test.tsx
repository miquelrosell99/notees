/**
 * §34.63 global undo/redo — the web wiring:
 *
 *  - undoRedoKeyHandler (App.tsx): Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z (or
 *    Ctrl/Cmd+Y) redo, guarded from form fields AND the outliner editor
 *    (contentEditable) — the editor-interaction rule (docs/ux.md "Undo and
 *    redo"): text editing keeps its local behavior, everything else runs the
 *    session journal. preventDefault fires only when the journal can act.
 *  - CommandPalette: the action registry gains Undo/Redo rows carrying the
 *    journal labels, present only when the journal has something to (re)apply.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { EMPTY_UNDO_STATE, type UndoUiState } from "../src/core/undo-journal.js";
import { undoRedoKeyHandler } from "../src/ui/App.js";
import { CommandPalette } from "../src/ui/components/CommandPalette.js";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

function makeHandler(calls: string[]) {
  const available: UndoUiState = {
    canUndo: true,
    canRedo: true,
    undoLabel: "Undo edit text",
    redoLabel: "Redo edit text",
  };
  const handler = undoRedoKeyHandler({
    undoState: () => available,
    onUndo: () => calls.push("undo"),
    onRedo: () => calls.push("redo"),
  });
  document.addEventListener("keydown", handler);
  return handler;
}

describe("undoRedoKeyHandler — the editor-interaction rule", () => {
  const calls: string[] = [];

  afterEach(() => {
    calls.length = 0;
    vi.restoreAllMocks();
  });

  it("Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes, Ctrl/Cmd+Y redoes", () => {
    const handler = makeHandler(calls);
    const undoEvent = key({ key: "z", ctrlKey: true });
    const redoShiftEvent = key({ key: "z", ctrlKey: true, shiftKey: true });
    const redoYEvent = key({ key: "y", metaKey: true });
    document.dispatchEvent(undoEvent);
    document.dispatchEvent(redoShiftEvent);
    document.dispatchEvent(redoYEvent);
    document.removeEventListener("keydown", handler);
    expect(calls).toEqual(["undo", "redo", "redo"]);
    expect(undoEvent.defaultPrevented).toBe(true);
    expect(redoShiftEvent.defaultPrevented).toBe(true);
    expect(redoYEvent.defaultPrevented).toBe(true);
  });

  it("yields to the outliner editor: a contentEditable target keeps the keystroke", () => {
    const handler = makeHandler(calls);
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    document.body.appendChild(editor);
    const undoEvent = key({ key: "z", ctrlKey: true });
    const redoEvent = key({ key: "z", ctrlKey: true, shiftKey: true });
    editor.dispatchEvent(undoEvent);
    editor.dispatchEvent(redoEvent);
    document.removeEventListener("keydown", handler);
    editor.remove();
    expect(calls).toEqual([]);
    expect(undoEvent.defaultPrevented).toBe(false);
    expect(redoEvent.defaultPrevented).toBe(false);
  });

  it("yields to form fields (input / textarea / select)", () => {
    const handler = makeHandler(calls);
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    document.body.appendChild(input);
    document.body.appendChild(textarea);
    input.dispatchEvent(key({ key: "z", ctrlKey: true }));
    textarea.dispatchEvent(key({ key: "z", ctrlKey: true, shiftKey: true }));
    document.removeEventListener("keydown", handler);
    input.remove();
    textarea.remove();
    expect(calls).toEqual([]);
  });

  it("does nothing when the journal is empty (no preventDefault, no call)", () => {
    const empty: UndoUiState = { ...EMPTY_UNDO_STATE };
    const handler = undoRedoKeyHandler({
      undoState: () => empty,
      onUndo: () => calls.push("undo"),
      onRedo: () => calls.push("redo"),
    });
    document.addEventListener("keydown", handler);
    const undoEvent = key({ key: "z", ctrlKey: true });
    const redoEvent = key({ key: "z", ctrlKey: true, shiftKey: true });
    document.dispatchEvent(undoEvent);
    document.dispatchEvent(redoEvent);
    document.removeEventListener("keydown", handler);
    expect(calls).toEqual([]);
    expect(undoEvent.defaultPrevented).toBe(false);
    expect(redoEvent.defaultPrevented).toBe(false);
  });

  it("ignores unmodified z, Alt+Z, and plain typing", () => {
    const handler = makeHandler(calls);
    document.dispatchEvent(key({ key: "z" }));
    document.dispatchEvent(key({ key: "z", altKey: true, ctrlKey: true }));
    document.dispatchEvent(key({ key: "x", ctrlKey: true }));
    document.removeEventListener("keydown", handler);
    expect(calls).toEqual([]);
  });
});

describe("CommandPalette Undo/Redo rows (§34.63)", () => {
  const WS = "0192a000-0000-7000-8000-000000000001";
  const ACTOR = "0192a000-0000-7000-8000-000000000002";
  let sqlModule: SqlJsStatic;
  const clients: WorkspaceClient[] = [];

  beforeAll(async () => {
    sqlModule = await initSqlJs();
  });

  afterEach(() => {
    while (clients.length > 0) clients.pop()!.close();
  });

  async function seedClient(): Promise<WorkspaceClient> {
    const client = await WorkspaceClient.create({
      transport: new MemoryTransport(new MemoryRelay()),
      actorId: ACTOR,
      sqlJs: sqlModule,
    });
    await client.bootstrapWorkspace(WS);
    await client.createObject({ presentAsMain: true, name: "Solo" });
    clients.push(client);
    return client;
  }

  function renderPalette(undoState: UndoUiState, calls: string[]): void {
    render(
      <CommandPalette
        client={clients[clients.length - 1]!}
        open
        onRequestOpen={() => {}}
        onClose={() => {}}
        onOpenNode={() => {}}
        onNewPage={() => {}}
        onSignOut={() => {}}
        undoState={undoState}
        onUndo={() => calls.push("undo")}
        onRedo={() => calls.push("redo")}
        cacheVersion={0}
      />,
    );
  }

  it("shows the Undo/Redo rows with the journal labels and runs the callbacks", async () => {
    const client = await seedClient();
    await client.updateObject(client.roots()[0]!.id, {
      contentAst: [{ type: "text", text: "Solo edited" }],
    });
    const state = await client.undoState();
    expect(state.undoLabel).toBe("Undo edit text");
    const calls: string[] = [];
    renderPalette(state, calls);

    const undoRow = screen.getByText("Undo edit text");
    const redoRow = screen.queryByText(/Redo/);
    expect(redoRow).toBeNull(); // nothing undone yet — no redo row
    fireEvent.click(undoRow);
    expect(calls).toEqual(["undo"]);
  });

  it("hides both rows when the journal is empty", async () => {
    await seedClient();
    const calls: string[] = [];
    renderPalette(
      { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null },
      calls,
    );
    expect(screen.queryByText(/^Undo /)).toBeNull();
    expect(screen.queryByText(/^Redo /)).toBeNull();
  });

  it("shows the Redo row after an undo, labeled by the original gesture", async () => {
    const client = await seedClient();
    const id = client.roots()[0]!.id;
    await client.updateObject(id, { contentAst: [{ type: "text", text: "Solo edited" }] });
    await client.undo();
    const state = await client.undoState();
    expect(state.redoLabel).toBe("Redo edit text");
    const calls: string[] = [];
    render(
      <CommandPalette
        client={client}
        open
        onRequestOpen={() => {}}
        onClose={() => {}}
        onOpenNode={() => {}}
        onNewPage={() => {}}
        onSignOut={() => {}}
        undoState={state}
        onUndo={() => calls.push("undo")}
        onRedo={() => {
          calls.push("redo");
          void client.redo();
        }}
        cacheVersion={0}
      />,
    );
    fireEvent.click(screen.getByText("Redo edit text"));
    expect(calls).toEqual(["redo"]);
    expect(client.getNode(id)?.contentAst).toEqual([{ type: "text", text: "Solo edited" }]);
  });
});
