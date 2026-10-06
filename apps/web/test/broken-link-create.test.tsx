/**
 * Broken-link "create page with UUID" row — LinkEditModal's
 * broken-target state: when a mention's target id resolves to no node, the
 * modal offers creating the page AT that id (the caller-id create path).
 * The mention heals in place — its targetNodeId stays, the token is never
 * retargeted.
 *
 * Same harness as node-link-gestures.test.tsx.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
/** A uuid that exists nowhere in the workspace (the broken mention target). */
const DEAD_TARGET = "0192a000-0000-7000-8000-0000000000ff";

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
  delete (document as unknown as Record<string, unknown>).caretRangeFromPoint;
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

function clickIntoBlock(container: HTMLElement): HTMLElement {
  const content = container.querySelector<HTMLElement>(".nt-block-content");
  if (content === null) throw new Error("no .nt-block-content");
  fireEvent.click(content);
  const editor = content.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

/** Caret probe stub: the mention hit-test reads caretRangeFromPoint. */
function mockCaretAt(editor: HTMLElement, proseOffset: number): void {
  const doc = document as Document & { caretRangeFromPoint?: unknown };
  doc.caretRangeFromPoint = () => {
    const range = document.createRange();
    let acc = 0;
    let target: Node | null = null;
    let inner = 0;
    for (const child of Array.from(editor.childNodes)) {
      const len = child.textContent?.length ?? 0;
      if (acc + len >= proseOffset) {
        target = child;
        inner = Math.max(0, proseOffset - acc);
        break;
      }
      acc += len;
    }
    if (target === null) {
      range.selectNodeContents(editor);
      range.collapse(false);
      return range;
    }
    const textNode = target instanceof HTMLElement ? (target.firstChild ?? target) : target;
    const max = (textNode.textContent ?? "").length;
    range.setStart(textNode, Math.min(inner, max));
    range.setEnd(textNode, Math.min(inner, max));
    return range;
  };
}

function openEditLinkModal(container: HTMLElement): HTMLElement {
  const editor = clickIntoBlock(container);
  mockCaretAt(editor, 6); // inside "the missing page" ([4, 20))
  fireEvent.contextMenu(editor, { clientX: 12, clientY: 12 });
  const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
  if (menu === null) throw new Error("context menu did not open");
  const edit = Array.from(menu.querySelectorAll<HTMLElement>("[role=menuitem]")).find(
    (el) => el.textContent === "Edit link…",
  );
  if (edit === undefined) throw new Error("no Edit link… item");
  fireEvent.click(edit);
  const modal = document.body.querySelector<HTMLElement>(".link-edit-modal");
  if (modal === null) throw new Error("link edit modal did not open");
  return modal;
}

describe("broken-link create page with UUID", () => {
  it("shows the heal row for a missing target; the click creates the page at that id and keeps the mention", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "see " },
        {
          type: "mention",
          targetNodeId: DEAD_TARGET,
          text: "the missing page",
          linkId: "0192a000-0000-7000-8000-0000000000aa",
        },
        { type: "text", text: " soon" },
      ],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const modal = openEditLinkModal(container);
    expect(modal.querySelector(".link-edit-modal__broken")).not.toBeNull();

    const create = Array.from(modal.querySelectorAll("button")).find(
      (b) => b.textContent === "Create page with this id",
    );
    if (create === undefined) throw new Error("no create-with-uuid button");
    fireEvent.click(create);
    await act(async () => {});

    // The modal closed; the node now exists at the exact id…
    expect(document.body.querySelector(".link-edit-modal")).toBeNull();
    const healed = client.getNode(DEAD_TARGET);
    expect(healed).not.toBeUndefined();
    expect(healed?.parentId).toBeNull(); // a root page

    // …and the mention token is UNCHANGED (no retarget, no rewrite).
    const ast = client.getNode(blockId)?.contentAst as ContentAst;
    expect(ast[1]).toEqual({
      type: "mention",
      targetNodeId: DEAD_TARGET,
      text: "the missing page",
      linkId: "0192a000-0000-7000-8000-0000000000aa",
    });
  });

  it("hides the heal row when the target resolves", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Home" });
    const targetId = await client.createObject({ presentAsMain: true, name: "Target" });
    await client.createObject({
      parentId: pageId,
      contentAst: [
        { type: "text", text: "see " },
        {
          type: "mention",
          targetNodeId: targetId,
          text: "Target",
          linkId: "0192a000-0000-7000-8000-0000000000aa",
        },
      ],
    });
    const { container } = render(<PageView client={client} pageId={pageId} />);

    const modal = openEditLinkModal(container);
    expect(modal.querySelector(".link-edit-modal__broken")).toBeNull();
  });
});
