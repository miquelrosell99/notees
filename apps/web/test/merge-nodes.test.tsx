/**
 * Node merge — web slice (jsdom over the in-process WorkspaceClient):
 *
 *  - client.mergeNodes applies the store planner's op list as ONE undo-journal
 *    batch: children move, class/property remap, mention rewrites land, the
 *    source trashes, and a single undo restores the source;
 *  - the MergeNodesModal explains the merge, gates Proceed on a picked target
 *    (the pages-only NodeSelector, the source excluded), confirms through the
 *    danger ConfirmationModal, and surfaces a guard error as an error line
 *    while staying open;
 *  - the command palette offers "Merge current page into…" only where the
 *    host provides the merge host callback + a mergeable current node (a
 *    non-class page rendering with document chrome).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { MergeGuardError } from "@notees/store";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { EMPTY_UNDO_STATE } from "../src/core/undo-journal.js";
import { MergeNodesModal } from "../src/ui/components/modals/MergeNodesModal.js";
import { CommandPalette } from "../src/ui/components/CommandPalette.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  localStorage.clear();
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

/** Drain the microtasks a write's floating push+ack chain runs on. */
async function flushSync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => {});
}

/** Seed a mergeable source page: one child, one class with one bound property. */
async function seedSource(client: WorkspaceClient): Promise<{
  source: string;
  child: string;
  cls: string;
  schema: string;
}> {
  const cls = await client.createClass("Topic");
  const schema = await client.createPropertySchema({ name: "Note", type: "text" });
  await client.setClassProperty(cls, schema, { sequence: 0 });
  const source = await client.createObject({ presentAsMain: true, name: "Source" });
  await client.assignClass(source, cls);
  await client.setProperty(source, schema, "authored note");
  const child = await client.createObject({ presentAsMain: true, name: "Child", parentId: source });
  return { source, child, cls, schema };
}

describe("WorkspaceClient.mergeNodes", () => {
  it("applies the plan: children move, class/property remap, mentions rewrite, source trashes", async () => {
    const client = await seedClient();
    const { source, child, cls, schema } = await seedSource(client);
    const target = await client.createObject({ presentAsMain: true, name: "Target" });

    // A referrer page mentions the source — the mention retargets to the
    // target. (object.update keeps rich tokens; create-as-main flattens.)
    const referrer = await client.createObject({ presentAsMain: true, name: "Referrer" });
    await client.updateObject(referrer, {
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: source, text: "Source" },
      ],
    });

    const summary = await client.mergeNodes(source, target);

    expect(summary.childrenMoved).toBe(1);
    expect(summary.classesRemapped).toBe(1);
    expect(summary.propertiesCopied).toBe(1);
    expect(summary.contentLinksRewritten).toBe(1);

    // The source trashes; the child moves under the target.
    expect(client.getNode(source)).toBeUndefined();
    expect(client.getNodeRaw(source)?.isActive).toBe(false);
    expect(client.getNode(child)?.parentId).toBe(target);

    // Class + authored property remap onto the target.
    expect(client.getNode(target)?.classIds).toContain(cls);
    const row = client.store.database
      .prepare(
        "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?",
      )
      .get(target, schema) as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value)).toBe("authored note");

    // The referrer's mention now points at the target.
    const referrerAst = client.getNode(referrer)?.contentAst ?? [];
    const mention = referrerAst.find((t) => t.type === "mention");
    expect(mention?.targetNodeId).toBe(target);
  });

  it("the whole merge is ONE undo entry: one undo restores the source", async () => {
    const client = await seedClient();
    const { source, child, cls, schema } = await seedSource(client);
    const target = await client.createObject({ presentAsMain: true, name: "Target" });
    await flushSync();
    const undoBefore = client.undoDepth().undo;

    await client.mergeNodes(source, target);
    expect(client.undoDepth().undo).toBe(undoBefore + 1);

    expect(await client.undo()).toBe(true);
    expect(client.getNodeRaw(source)?.isActive).toBe(true);
    expect(client.getNode(child)?.parentId).toBe(source);
    expect(client.getNode(target)?.classIds).not.toContain(cls);
  });

  it("guard errors propagate loud before any op is emitted", async () => {
    const client = await seedClient();
    const { source } = await seedSource(client);
    const inner = await client.createObject({ parentId: source, name: "Inner" });
    await flushSync();
    const undoBefore = client.undoDepth().undo;

    // Merging a node into itself is a guard failure.
    await expect(client.mergeNodes(source, source)).rejects.toBeInstanceOf(MergeGuardError);
    // The target inside the source's subtree is a guard failure.
    await expect(client.mergeNodes(source, inner)).rejects.toBeInstanceOf(MergeGuardError);
    // Nothing was applied.
    expect(client.undoDepth().undo).toBe(undoBefore);
    expect(client.getNodeRaw(source)?.isActive).toBe(true);
  });
});

describe("MergeNodesModal", () => {
  it("explains the merge, gates Proceed on a picked target, and completes through the confirmation", async () => {
    const client = await seedClient();
    const { source } = await seedSource(client);
    const target = await client.createObject({ presentAsMain: true, name: "Target" });
    await flushSync();

    const onMerged = vi.fn();
    const onClose = vi.fn();
    render(
      <MergeNodesModal
        isOpen
        client={client}
        sourceId={source}
        onClose={onClose}
        onMerged={onMerged}
      />,
    );

    // The explanation names the source; Proceed waits for a target.
    expect(screen.getByText(/blocks and child pages/)).not.toBeNull();
    expect(screen.getAllByText("Source").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Proceed" })).toBeDisabled();

    // Open the target picker (the source is excluded), search, pick.
    fireEvent.click(screen.getByRole("button", { name: /pick a target page/i }));
    const picker = screen.getByRole("dialog", { name: "Select node" });
    expect(within(picker).queryByText("Source")).toBeNull();
    fireEvent.change(within(picker).getByLabelText("Search pages…"), {
      target: { value: "Targ" },
    });
    fireEvent.click(within(picker).getByText("Target"));
    expect(screen.queryByRole("dialog", { name: "Select node" })).toBeNull();
    expect(screen.getByRole("button", { name: "Proceed" })).toBeEnabled();

    // Proceed asks the danger confirmation naming both titles, then merges.
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
    expect(screen.getByText(/this will move everything from/i)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(onMerged).toHaveBeenCalledTimes(1));
    expect(onMerged).toHaveBeenCalledWith(target);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(client.getNodeRaw(source)?.isActive).toBe(false);
    expect(client.getNode(target)?.contentAst).toEqual([{ type: "text", text: "Target" }]);
  });

  it("a guard error surfaces as an error line and the modal stays open", async () => {
    const client = await seedClient();
    const { source } = await seedSource(client);
    const target = await client.createObject({ presentAsMain: true, name: "Target" });
    await flushSync();

    vi.spyOn(client, "mergeNodes").mockRejectedValue(
      new MergeGuardError("merge target is inside the source's subtree"),
    );
    const onMerged = vi.fn();
    render(
      <MergeNodesModal
        isOpen
        client={client}
        sourceId={source}
        onClose={() => {}}
        onMerged={onMerged}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /pick a target page/i }));
    const picker = screen.getByRole("dialog", { name: "Select node" });
    fireEvent.change(within(picker).getByLabelText("Search pages…"), {
      target: { value: "Targ" },
    });
    fireEvent.click(within(picker).getByText("Target"));
    fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    // Back at the merge dialog with the guard message; not merged, not closed.
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain(
      "merge target is inside the source's subtree",
    );
    expect(onMerged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Proceed" })).toBeEnabled();
  });
});

describe("command palette merge action", () => {
  function renderPalette(
    client: WorkspaceClient,
    props: { currentNodeId?: string; onOpenMerge?: () => void },
  ) {
    return render(
      <CommandPalette
        client={client}
        open
        onRequestOpen={() => {}}
        onClose={() => {}}
        onOpenNode={() => {}}
        onNewPage={() => {}}
        onSignOut={() => {}}
        undoState={EMPTY_UNDO_STATE}
        onUndo={() => {}}
        onRedo={() => {}}
        cacheVersion={0}
        {...props}
      />,
    );
  }

  it("offers Merge current page into… for a mergeable current node", async () => {
    const client = await seedClient();
    const page = await client.createObject({ presentAsMain: true, name: "Page" });
    await flushSync();
    const onOpenMerge = vi.fn();
    renderPalette(client, { currentNodeId: page, onOpenMerge });

    fireEvent.click(await screen.findByText("Merge current page into…"));
    expect(onOpenMerge).toHaveBeenCalledTimes(1);
  });

  it("omits the action without a current node, and for non-mergeable nodes", async () => {
    const client = await seedClient();
    const page = await client.createObject({ presentAsMain: true, name: "Page" });
    const cls = await client.createClass("Kind");
    // A parented block with the render bit unset — an inline block.
    const block = await client.createObject({ parentId: page, name: "Block" });
    await flushSync();

    // No currentNodeId at all.
    const first = renderPalette(client, { onOpenMerge: () => {} });
    expect(first.queryByText("Merge current page into…")).toBeNull();
    first.unmount();

    // The current node is a class — not mergeable.
    const second = renderPalette(client, { currentNodeId: cls, onOpenMerge: () => {} });
    expect(second.queryByText("Merge current page into…")).toBeNull();
    second.unmount();

    // The current node is an inline block — not mergeable.
    renderPalette(client, { currentNodeId: block, onOpenMerge: () => {} });
    expect(screen.queryByText("Merge current page into…")).toBeNull();
  });
});
