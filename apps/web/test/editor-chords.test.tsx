/**
 * §34.19 editor keymap chords:
 *
 * - Alt+Shift+↑/↓ — move the block among its siblings without dragging
 *   (the v1 MOVE_UP/MOVE_DOWN chords; one object.move per press, the caret
 *   stays in the editor).
 * - Ctrl+. — toggle fold on the FOCUSED block; Ctrl+Alt+← folds and
 *   Ctrl+Alt+→ unfolds (the register's fold row; Alt+←/→ belongs to
 *   Back/Forward). Childless blocks are an honest no-op.
 *
 * Same harness as outliner-keys.test.tsx.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

beforeEach(() => {
  localStorage.clear();
});

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

/** Enter edit mode on the nth block (document order) and return its editor. */
function clickIntoBlock(container: HTMLElement, index = 0): HTMLElement {
  const contents = container.querySelectorAll<HTMLElement>(".nt-block-content");
  const target = contents[index];
  if (target === undefined) throw new Error(`no .nt-block-content at index ${index}`);
  fireEvent.click(target);
  const editor = target.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

async function childTexts(client: WorkspaceClient, pageId: string): Promise<string[]> {
  return client.getChildren(pageId).map((node) => {
    const first = node.contentAst[0] as { text?: string } | undefined;
    return first?.text ?? "";
  });
}

describe("Alt+Shift+↑/↓ block move chords", () => {
  it("moves the edited block before/after its siblings", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "A" }] });
    await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "B" }] });
    await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "C" }] });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 1); // B
    fireEvent.keyDown(editor, { key: "ArrowUp", altKey: true, shiftKey: true });
    await act(async () => {});
    expect(await childTexts(client, pageId)).toEqual(["B", "A", "C"]);

    fireEvent.keyDown(editor, { key: "ArrowDown", altKey: true, shiftKey: true });
    await act(async () => {});
    fireEvent.keyDown(editor, { key: "ArrowDown", altKey: true, shiftKey: true });
    await act(async () => {});
    expect(await childTexts(client, pageId)).toEqual(["A", "C", "B"]);
  });

  it("is an honest no-op at the sibling edges", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "A" }] });
    await client.createObject({ parentId: pageId, contentAst: [{ type: "text", text: "B" }] });
    const moveObject = vi.spyOn(client, "moveObject");
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const first = clickIntoBlock(container, 0);
    fireEvent.keyDown(first, { key: "ArrowUp", altKey: true, shiftKey: true });
    await act(async () => {});
    expect(moveObject).not.toHaveBeenCalled();

    const second = clickIntoBlock(container, 1);
    fireEvent.keyDown(second, { key: "ArrowDown", altKey: true, shiftKey: true });
    await act(async () => {});
    expect(moveObject).not.toHaveBeenCalled();
    expect(await childTexts(client, pageId)).toEqual(["A", "B"]);
  });
});

describe("fold chords (Ctrl+. toggle, Ctrl+Alt+←/→)", () => {
  async function seedParentWithChild(client: WorkspaceClient) {
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const parentId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "parent" }],
    });
    await client.createObject({ parentId, contentAst: [{ type: "text", text: "child" }] });
    return { pageId, parentId };
  }

  it("Ctrl+. collapses the focused block's subtree and toggles back", async () => {
    const client = await seedClient();
    const { pageId } = await seedParentWithChild(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    expect(container.querySelector(".nt-block-children")).not.toBeNull();
    clickIntoBlock(container, 0);
    fireEvent.keyDown(document, { key: ".", ctrlKey: true });
    expect(container.querySelector(".nt-block-children")).toBeNull();

    // The row stays selected-rendered; re-enter and toggle back.
    clickIntoBlock(container, 0);
    fireEvent.keyDown(document, { key: ".", ctrlKey: true });
    expect(container.querySelector(".nt-block-children")).not.toBeNull();
  });

  it("Ctrl+Alt+← folds and Ctrl+Alt+→ unfolds (one-directional, no toggle flip)", async () => {
    const client = await seedClient();
    const { pageId } = await seedParentWithChild(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    clickIntoBlock(container, 0);
    fireEvent.keyDown(document, { key: "ArrowLeft", ctrlKey: true, altKey: true });
    expect(container.querySelector(".nt-block-children")).toBeNull();

    // Fold again on the already-folded block: still folded (no flip).
    clickIntoBlock(container, 0);
    fireEvent.keyDown(document, { key: "ArrowLeft", ctrlKey: true, altKey: true });
    expect(container.querySelector(".nt-block-children")).toBeNull();

    fireEvent.keyDown(document, { key: "ArrowRight", ctrlKey: true, altKey: true });
    expect(container.querySelector(".nt-block-children")).not.toBeNull();
  });

  it("childless blocks ignore the fold chords", async () => {
    const client = await seedClient();
    const { pageId } = await seedParentWithChild(client);
    const { container } = render(<PageView client={client} pageId={pageId} />);

    // Click the child (index 1 in document order) — no children of its own.
    clickIntoBlock(container, 1);
    fireEvent.keyDown(document, { key: ".", ctrlKey: true });
    fireEvent.keyDown(document, { key: "ArrowLeft", ctrlKey: true, altKey: true });
    // The parent's subtree is untouched, the child still edits.
    expect(container.querySelector(".nt-block-children")).not.toBeNull();
    expect(container.querySelector(".nt-block-text")).not.toBeNull();
  });
});

describe("Cmd/Ctrl+Enter task cycle chord", () => {
  function statusValue(client: WorkspaceClient, id: string): unknown {
    return client
      .getEffectiveProperties(id)
      .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.taskStatus)?.value;
  }

  function statusOptionId(client: WorkspaceClient, label: string): string {
    const option = client
      .listPropertySchemas()
      .find((s) => s.id === SYSTEM_PROPERTY_UUIDS.taskStatus)
      ?.options?.find((o) => o.label === label);
    if (option === undefined) throw new Error(`no "${label}" option`);
    return option.id;
  }

  it("cycles not-a-task -> task+Pending -> Done -> cleared", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Tasks" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Buy milk" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    // 1. not a task -> task + Pending (the family self-heals on first write).
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await act(async () => {});
    expect(client.getNode(blockId)?.classIds).toContain(SYSTEM_CLASS_UUIDS.task);
    expect(statusValue(client, blockId)).toBe(statusOptionId(client, "Pending"));

    // 2. open task -> Done.
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await act(async () => {});
    expect(client.getNode(blockId)?.classIds).toContain(SYSTEM_CLASS_UUIDS.task);
    expect(statusValue(client, blockId)).toBe(statusOptionId(client, "Done"));

    // 3. Done -> cleared: status unset, class dropped.
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await act(async () => {});
    expect(client.getNode(blockId)?.classIds).not.toContain(SYSTEM_CLASS_UUIDS.task);
    expect(statusValue(client, blockId)).toBeUndefined();
  });

  it("Ctrl+Enter (without meta) cycles too", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Tasks" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Buy milk" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    await act(async () => {});
    expect(client.getNode(blockId)?.classIds).toContain(SYSTEM_CLASS_UUIDS.task);
    expect(statusValue(client, blockId)).toBe(statusOptionId(client, "Pending"));
  });

  it("keeps plain Enter's block split intact after the chord", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Tasks" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Buy milk" }],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const editor = clickIntoBlock(container, 0);
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await act(async () => {});
    expect(client.getNode(blockId)?.classIds).toContain(SYSTEM_CLASS_UUIDS.task);

    // Plain Enter (no modifier) still splits: a sibling appears after.
    fireEvent.keyDown(editor, { key: "Enter" });
    await act(async () => {});
    const tree = client.getBlockTree(pageId);
    expect(tree).toHaveLength(2);
    expect(tree[0]!.node.id).toBe(blockId);
    expect(tree[1]!.node.parentId).toBe(pageId);
  });
});
