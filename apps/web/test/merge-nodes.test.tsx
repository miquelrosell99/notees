/**
 * Node merge — web slice (jsdom over the in-process WorkspaceClient):
 *
 *  - client.mergeNodes applies the store planner's op list as ONE undo-journal
 *    batch: children move, class/property remap, mention rewrites land, the
 *    source trashes, and a single undo restores the source;
 *  - the unified MergeNodesModal is multi-source (any non-class node): the
 *    sources ride a pill-row NodeSelector (initialSourceIds pre-seed it),
 *    the target is picked from the all-mode anchored picker (blocks
 *    included, sources/classes excluded), a live dry-run summary aggregates
 *    the per-source plans, and the danger confirmation merges EVERY source
 *    (each trashed, children moved) before onMerged fires once;
 *  - guard failures surface as the error line and the modal stays open;
 *  - worker mode previews/applies through mergeNodesRemote (+ one pull);
 *  - the command palette offers a general "Merge nodes…" row regardless of
 *    a current node, and keeps the current-page row's mergeable gating;
 *  - the node context menu offers "Merge into…" on non-class nodes only.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { MergeGuardError, type MergePlanSummary } from "@notees/store";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import type { ClientNode } from "../src/core/workspace-client/index.js";
import type { WorkerClient } from "../src/core/worker-client.js";
import { EMPTY_UNDO_STATE } from "../src/core/undo-journal.js";
import { MergeNodesModal } from "../src/features/modals/MergeNodesModal.js";
import { MergeHost, requestMerge } from "../src/features/modals/mergeHost.js";
import { CommandPalette } from "../src/features/command-palette/CommandPalette.js";
import { NodeContextMenu } from "../src/features/node-menu/NodeContextMenu.js";

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
  await client.setClassProperty(cls, schema, {});
  const source = await client.createObject({ isEmbedded: false, name: "Source" });
  await client.assignClass(source, cls);
  await client.setProperty(source, schema, "authored note");
  const child = await client.createObject({ isEmbedded: false, name: "Child", parentId: source });
  return { source, child, cls, schema };
}

/** A second source with its own child — the multi-source leg. */
async function seedSecondSource(client: WorkspaceClient): Promise<{
  two: string;
  twoChild: string;
}> {
  const two = await client.createObject({ isEmbedded: false, name: "Second" });
  const twoChild = await client.createObject({
    isEmbedded: false,
    name: "Second child",
    parentId: two,
  });
  return { two, twoChild };
}

describe("WorkspaceClient.mergeNodes", () => {
  it("applies the plan: children move, class/property remap, mentions rewrite, source trashes", async () => {
    const client = await seedClient();
    const { source, child, cls, schema } = await seedSource(client);
    const target = await client.createObject({ isEmbedded: false, name: "Target" });

    // A referrer page mentions the source — the mention retargets to the
    // target. (object.update keeps rich tokens; create-as-main flattens.)
    const referrer = await client.createObject({ isEmbedded: false, name: "Referrer" });
    await client.updateObject(referrer, {
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: source },
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
    const target = await client.createObject({ isEmbedded: false, name: "Target" });
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
  it("pre-seeds the sources, aggregates the dry-run summary, and merges every source through the confirmation", async () => {
    const client = await seedClient();
    const { source, child } = await seedSource(client);
    const { two, twoChild } = await seedSecondSource(client);
    const target = await client.createObject({ isEmbedded: false, name: "Target" });
    await flushSync();

    const onMerged = vi.fn();
    const onClose = vi.fn();
    render(
      <MergeNodesModal
        isOpen
        client={client}
        initialSourceIds={[source, two]}
        onClose={onClose}
        onMerged={onMerged}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Merge 2 nodes into…" });
    // The multi-source explanation: everything moves into the target, the
    // sources trash.
    expect(within(dialog).getByText(/children, classes, properties, and links/i)).not.toBeNull();
    expect(within(dialog).getByText(/trash/i)).not.toBeNull();
    // Both source pills ride the row; the target is still unpicked.
    expect(within(dialog).getAllByText("Source").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Second")).not.toBeNull();
    expect(
      within(dialog).getByRole("button", { name: /pick a target/i }),
    ).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "Merge" })).toBeDisabled();

    // Pick the target through the all-mode picker.
    fireEvent.click(within(dialog).getByRole("button", { name: /pick a target/i }));
    const picker = screen.getByRole("dialog", { name: "Select node" });
    fireEvent.change(within(picker).getByLabelText("Search nodes…"), {
      target: { value: "Targ" },
    });
    fireEvent.click(within(picker).getByText("Target"));
    expect(screen.queryByRole("dialog", { name: "Select node" })).toBeNull();

    // The aggregated dry-run: both sources' children + the class remap.
    await within(dialog).findByText(/2 children moved/);
    expect(within(dialog).getByText(/1 class remapped/)).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "Merge" })).toBeEnabled();

    // Confirm names the sources and the target, then merges everything.
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    const confirm = screen.getByRole("dialog", { name: "Merge nodes?" });
    expect(within(confirm).getByText(/2 nodes/)).not.toBeNull();
    expect(within(confirm).getByText(/"Source"/)).not.toBeNull();
    expect(within(confirm).getByText(/"Second"/)).not.toBeNull();
    expect(within(confirm).getByText(/"Target"/)).not.toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(onMerged).toHaveBeenCalledTimes(1));
    expect(onMerged).toHaveBeenCalledWith(target);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    // EVERY source trashed; every child moved under the target.
    expect(client.getNodeRaw(source)?.isActive).toBe(false);
    expect(client.getNodeRaw(two)?.isActive).toBe(false);
    expect(client.getNode(child)?.parentId).toBe(target);
    expect(client.getNode(twoChild)?.parentId).toBe(target);
  });

  it("adds and removes sources through the pill row; each picker excludes the other side", async () => {
    const client = await seedClient();
    const { source } = await seedSource(client);
    const { two } = await seedSecondSource(client);
    const target = await client.createObject({ isEmbedded: false, name: "Target" });
    await flushSync();

    render(
      <MergeNodesModal
        isOpen
        client={client}
        initialSourceIds={[source]}
        onClose={() => {}}
        onMerged={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Merge 1 node into…" });

    // Add a second source through the pill-row picker.
    fireEvent.click(within(dialog).getByRole("button", { name: "Add source" }));
    const sourcePicker = screen.getByRole("dialog", { name: "Select node" });
    fireEvent.change(within(sourcePicker).getByLabelText("Search nodes…"), {
      target: { value: "Second" },
    });
    fireEvent.click(within(sourcePicker).getByText("Second"));
    expect(screen.queryByRole("dialog", { name: "Select node" })).toBeNull();
    expect(within(dialog).getByText("Second")).not.toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Merge 2 nodes into…" }),
    ).not.toBeNull();

    // The target picker excludes BOTH picked sources; the block scope tab
    // offers blocks (any non-class node is a legal target).
    const holder = await client.createObject({ isEmbedded: false, name: "Holder" });
    await client.createObject({ parentId: holder, name: "Stray block" });
    await flushSync();
    fireEvent.click(within(dialog).getByRole("button", { name: /pick a target/i }));
    const targetPicker = screen.getByRole("dialog", { name: "Select node" });
    fireEvent.change(within(targetPicker).getByLabelText("Search nodes…"), {
      target: { value: "Source" },
    });
    expect(within(targetPicker).queryByText("Source")).toBeNull();
    expect(within(targetPicker).queryByText("Second")).toBeNull();
    // Blocks answer the target picker too — under the Blocks scope tab.
    fireEvent.click(within(targetPicker).getByRole("tab", { name: "Blocks" }));
    fireEvent.change(within(targetPicker).getByLabelText("Search nodes…"), {
      target: { value: "Stray" },
    });
    expect(within(targetPicker).getByText("Stray block")).not.toBeNull();
    // Pages live on the Main tab.
    fireEvent.click(within(targetPicker).getByRole("tab", { name: "Main" }));
    fireEvent.change(within(targetPicker).getByLabelText("Search nodes…"), {
      target: { value: "Target" },
    });
    fireEvent.click(within(targetPicker).getByText("Target"));
    expect(screen.queryByRole("dialog", { name: "Select node" })).toBeNull();

    // The sources picker now excludes the picked target.
    fireEvent.click(within(dialog).getByRole("button", { name: "Add source" }));
    const sourcePicker2 = screen.getByRole("dialog", { name: "Select node" });
    fireEvent.change(within(sourcePicker2).getByLabelText("Search nodes…"), {
      target: { value: "Target" },
    });
    expect(within(sourcePicker2).queryByText("Target")).toBeNull();
    fireEvent.keyDown(within(sourcePicker2).getByLabelText("Search nodes…"), {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog", { name: "Select node" })).toBeNull();

    // Remove the second source: the row drops back to one pill and the
    // title follows.
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Second" }));
    expect(within(dialog).queryByText("Second")).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Merge 1 node into…" }),
    ).not.toBeNull();
    await within(dialog).findByText(/1 child moved/);
  });

  it("drops invalid initial sources (missing, trashed, or class nodes)", async () => {
    const client = await seedClient();
    const { source } = await seedSource(client);
    const trashed = await client.createObject({ isEmbedded: false, name: "Trashed" });
    const cls = await client.createClass("Kind");
    await client.deleteObject(trashed);
    await flushSync();

    render(
      <MergeNodesModal
        isOpen
        client={client}
        initialSourceIds={[source, trashed, cls, "0192a000-0000-7000-8000-0000000000ee"]}
        onClose={() => {}}
        onMerged={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Merge 1 node into…" });
    expect(within(dialog).getByText("Source")).not.toBeNull();
    expect(within(dialog).queryByText("Trashed")).toBeNull();
    expect(within(dialog).queryByText("Kind")).toBeNull();
  });

  it("a guard failure on apply surfaces as an error line and the modal stays open", async () => {
    const client = await seedClient();
    const { source } = await seedSource(client);
    const target = await client.createObject({ isEmbedded: false, name: "Target" });
    await flushSync();

    vi.spyOn(client, "mergeNodes").mockRejectedValue(
      new MergeGuardError("merge target is inside the source's subtree"),
    );
    const onMerged = vi.fn();
    render(
      <MergeNodesModal
        isOpen
        client={client}
        initialSourceIds={[source]}
        onClose={() => {}}
        onMerged={onMerged}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Merge 1 node into…" });
    fireEvent.click(within(dialog).getByRole("button", { name: /pick a target/i }));
    const picker = screen.getByRole("dialog", { name: "Select node" });
    fireEvent.change(within(picker).getByLabelText("Search nodes…"), {
      target: { value: "Targ" },
    });
    fireEvent.click(within(picker).getByText("Target"));
    await within(dialog).findByText(/1 child moved/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    const confirm = screen.getByRole("dialog", { name: "Merge nodes?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));

    // Back at the merge dialog with the guard message; not merged, open.
    await within(dialog).findByRole("alert");
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "merge target is inside the source's subtree",
    );
    expect(onMerged).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Merge 1 node into…" })).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "Merge" })).toBeEnabled();
  });
});

describe("MergeNodesModal (worker client — the server merge route)", () => {
  const L = "0192a000-0000-7000-8000-0000000000a1";
  const R = "0192a000-0000-7000-8000-0000000000a2";

  function stubNode(partial: Partial<ClientNode> & { id: string }): ClientNode {
    return {
      workspaceId: "ws1",
      isClass: false,
      isEmbedded: false,
      parentId: null,
      classIds: [],
      tagIds: [],
      name: null,
      contentAst: [{ type: "text", text: "Some page" }],
      icon: null,
      coverAssetId: null,
      bannerAssetId: null,
      listStyle: null,
      aliasedNodeId: null,
      parentlessRole: "page",
      description: null,
      color: null,
      isActive: true,
      createdAt: null,
      updatedAt: null,
      ...partial,
    };
  }

  const EMPTY_SUMMARY: MergePlanSummary = {
    childrenMoved: 0,
    classesRemapped: 0,
    tagsRemapped: 0,
    propertiesCopied: 0,
    propertiesSkipped: 0,
    contentLinksRewritten: 0,
    propertyValuesRewritten: 0,
    standaloneChildrenRelocated: 0,
    aliasesRepointed: 0,
    collectionsRemapped: 0,
    fieldsCopied: 0,
  };

  function workerStub(): {
    client: WorkerClient;
    remote: ReturnType<typeof vi.fn>;
    pull: ReturnType<typeof vi.fn>;
  } {
    const nodes = new Map<string, ClientNode>([
      [L, stubNode({ id: L, contentAst: [{ type: "text", text: "Left" }] })],
      [R, stubNode({ id: R, contentAst: [{ type: "text", text: "Right" }] })],
    ]);
    const remote = vi.fn(async (_source: string, _target: string, dryRun = false) => {
      if (dryRun) return { ...EMPTY_SUMMARY, childrenMoved: 1 };
      return EMPTY_SUMMARY;
    });
    const pull = vi.fn(async () => {});
    const client = {
      getNode: (id: string) => nodes.get(id),
      getNodeRaw: (id: string) => nodes.get(id),
      search: (query: string) =>
        [...nodes.values()].filter((node) =>
          node.contentAst.some(
            (token) => token.type === "text" && token.text.toLowerCase().includes(query.toLowerCase()),
          ),
        ),
      listPages: () => [...nodes.values()].filter((node) => node.parentId === null && !node.isClass),
      listClasses: () => [],
      getClassMembers: () => [],
      effectiveClassParentlessBlock: () => false,
      getDisplayName: () => null,
      createClass: async () => "unused",
      updateObject: async () => {},
      mergeNodesRemote: remote,
      pull,
    } as unknown as WorkerClient;
    return { client, remote, pull };
  }

  it("previews through mergeNodesRemote dry-run, applies through the route, then pulls once", async () => {
    const { client, remote, pull } = workerStub();
    const onMerged = vi.fn();
    render(
      <MergeNodesModal
        isOpen
        client={client}
        initialSourceIds={[L]}
        onClose={() => {}}
        onMerged={onMerged}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Merge 1 node into…" });
    // Pick the target through the anchored picker.
    fireEvent.click(within(dialog).getByRole("button", { name: /pick a target/i }));
    const picker = screen.getByRole("dialog", { name: "Select node" });
    fireEvent.change(within(picker).getByLabelText("Search nodes…"), {
      target: { value: "Right" },
    });
    fireEvent.click(within(picker).getByText("Right"));

    // The preview rides the ?dryRun=true route variant.
    await waitFor(() => expect(remote).toHaveBeenCalledWith(L, R, true));
    await within(dialog).findByText(/1 child moved/);

    fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    const confirm = screen.getByRole("dialog", { name: "Merge nodes?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(onMerged).toHaveBeenCalledTimes(1));
    expect(onMerged).toHaveBeenCalledWith(R);
    // The real merge (no dryRun flag), then ONE pull.
    expect(remote).toHaveBeenCalledWith(L, R, false);
    await waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
  });
});

describe("command palette merge actions", () => {
  function renderPalette(
    client: WorkspaceClient,
    props: {
      currentNodeId?: string;
      onOpenMerge?: () => void;
      onOpenMergeGeneral?: () => void;
    },
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

  it("offers a general Merge nodes… row without a current node", async () => {
    const client = await seedClient();
    await flushSync();
    const onOpenMergeGeneral = vi.fn();
    renderPalette(client, { onOpenMergeGeneral });

    fireEvent.click(await screen.findByText("Merge nodes…"));
    expect(onOpenMergeGeneral).toHaveBeenCalledTimes(1);
  });

  it("omits the general row where the host provides no onOpenMergeGeneral", async () => {
    const client = await seedClient();
    await flushSync();
    renderPalette(client, {});
    expect(screen.queryByText("Merge nodes…")).toBeNull();
  });

  it("offers Merge current page into… for a mergeable current node", async () => {
    const client = await seedClient();
    const page = await client.createObject({ isEmbedded: false, name: "Page" });
    await flushSync();
    const onOpenMerge = vi.fn();
    renderPalette(client, { currentNodeId: page, onOpenMerge });

    fireEvent.click(await screen.findByText("Merge current page into…"));
    expect(onOpenMerge).toHaveBeenCalledTimes(1);
  });

  it("omits the current-page action without a current node, and for non-mergeable nodes", async () => {
    const client = await seedClient();
    const page = await client.createObject({ isEmbedded: false, name: "Page" });
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

describe("node context menu merge entry", () => {
  function stubNode(partial: Partial<ClientNode> & { id: string }): ClientNode {
    return {
      workspaceId: "ws1",
      isClass: false,
      isEmbedded: false,
      parentId: null,
      classIds: [],
      tagIds: [],
      name: null,
      contentAst: [{ type: "text", text: "Some page" }],
      icon: null,
      coverAssetId: null,
      bannerAssetId: null,
      listStyle: null,
      aliasedNodeId: null,
      parentlessRole: "page",
      description: null,
      color: null,
      isActive: true,
      createdAt: null,
      updatedAt: null,
      ...partial,
    };
  }

  function renderMenu(node: ClientNode) {
    const client = {
      updateObject: async () => {},
      assignClass: async () => {},
      unassignClass: async () => {},
      deleteObject: async () => {},
      getNode: (id: string) => (id === node.id ? node : undefined),
      getChildren: () => [],
      getChildrenFresh: async () => [],
      getEffectiveProperties: () => [],
      createObject: async () => "unused",
      setProperty: async () => {},
      assignProperty: async () => {},
      moveObject: async () => {},
      listPropertySchemas: () => [],
      effectiveClassColor: () => null,
      effectiveClassIcons: () => new Map(),
      effectiveClassParentlessBlock: () => false,
      getDisplayName: () => null,
      applyOps: async () => [],
    };
    return render(
      <NodeContextMenu
        state={{ x: 0, y: 0, node, isPage: !node.parentId }}
        client={client}
        onClose={() => {}}
        onOpenNode={() => {}}
      />,
    );
  }

  it("offers Merge into… on pages and inline blocks, omits it on class nodes", () => {
    const { unmount } = renderMenu(stubNode({ id: "page-1" }));
    expect(screen.getByText("Merge into…")).not.toBeNull();
    unmount();

    const second = renderMenu(stubNode({ id: "block-1", parentId: "page-0", isEmbedded: true }));
    expect(screen.getByText("Merge into…")).not.toBeNull();
    second.unmount();

    renderMenu(stubNode({ id: "class-1", isClass: true }));
    expect(screen.queryByText("Merge into…")).toBeNull();
  });

  it("firing the entry requests the merge and the app-level host opens the modal", async () => {
    const client = await seedClient();
    const { source } = await seedSource(client);
    await flushSync();

    // The menu's own node answers its stub client; the host rides the real
    // one — the module-level queue is the only channel between them.
    const menuNode = stubNode({ id: source, contentAst: [{ type: "text", text: "Source" }] });
    render(
      <>
        <NodeContextMenu
          state={{ x: 0, y: 0, node: menuNode, isPage: true }}
          client={
            {
              updateObject: async () => {},
              assignClass: async () => {},
              unassignClass: async () => {},
              deleteObject: async () => {},
              getNode: (id: string) => (id === menuNode.id ? menuNode : undefined),
              getChildren: () => [],
              getChildrenFresh: async () => [],
              getEffectiveProperties: () => [],
              createObject: async () => "unused",
              setProperty: async () => {},
              assignProperty: async () => {},
              moveObject: async () => {},
              listPropertySchemas: () => [],
              effectiveClassColor: () => null,
              effectiveClassIcons: () => new Map(),
              effectiveClassParentlessBlock: () => false,
              getDisplayName: () => null,
            } as never
          }
          onClose={() => {}}
          onOpenNode={() => {}}
        />
        <MergeHost client={client} onOpenNode={() => {}} />
      </>,
    );

    fireEvent.click(screen.getByText("Merge into…"));
    // The host drained the request: the modal opens pre-seeded with the node.
    const dialog = await screen.findByRole("dialog", { name: "Merge 1 node into…" });
    expect(within(dialog).getByText("Source")).not.toBeNull();
  });
});
