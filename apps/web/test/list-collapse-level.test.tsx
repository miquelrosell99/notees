/**
 * List auto-collapse level — the "Auto-collapse nodes at this depth in
 * lists" device setting (`listCollapseLevel`) governs the STARTING fold
 * state of rows with children in flat node collections: rows at the named
 * depth and deeper start collapsed (depth 1 = the list's top-level rows),
 * 0 = disabled renders rows fully expanded. Collections that own their
 * collapse behavior — the `collapse` flag (the Child pages tree; the page
 * body is excluded structurally, it never reaches the flat path) — are
 * untouched by the setting. Harness: in-process WorkspaceClient + jsdom.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, render } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeCollection, groupByContainingPage } from "../src/features/collection/index.js";

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";
const SETTING_KEY = "notees.settings.listCollapseLevel";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  localStorage.clear();
});

async function flushSync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => {});
}

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

/**
 * Target ← "Source" page (the reference row, depth 1) with a child block
 * "Middle block" (depth 2) carrying its own child "Deep block" (depth 3).
 * The edge rides a bound property value on the page itself, so the entry's
 * source IS its containing page — the row rides the ungrouped top-level flat
 * outline.
 */
async function seedThreeDeep(): Promise<{ client: WorkspaceClient; target: string }> {
  const client = await seedClient();
  const schemaId = await client.createPropertySchema({
    name: "supports",
    type: "object",
    multi: true,
    targetClassFilter: [],
  });
  const target = await client.createObject({ isEmbedded: false, name: "Target" });
  const source = await client.createObject({ isEmbedded: false, name: "Source" });
  const middle = await client.createObject({
    parentId: source,
    contentAst: [{ type: "text", text: "Middle block" }],
  });
  await client.createObject({
    parentId: middle,
    contentAst: [{ type: "text", text: "Deep block" }],
  });
  await client.setProperty(source, schemaId, { nodeId: target }, 0);
  await flushSync();
  return { client, target };
}

/**
 * The reference collection the section composes (the retired ReferenceList's
 * exact composition — the subject under test is the outline view's collapse
 * behavior, not the section chrome).
 */
function renderRefs(client: WorkspaceClient, target: string): void {
  const items = client.getLinkedReferences(target).map((entry) => ({
    node: client.getNode(entry.source.id) ?? entry.source,
    meta: { containingPageId: entry.containingPageId, verb: entry.verb },
  }));
  const { standalone, groups } = groupByContainingPage(client, items, () => {});
  render(
    <NodeCollection
      viewMode="outline"
      client={client}
      items={items}
      readOnly={false}
      groups={groups}
      ungroupedItems={standalone}
    />,
  );
}

describe("list auto-collapse level", () => {
  it("level 0 (disabled) renders the rows fully expanded", async () => {
    localStorage.setItem(SETTING_KEY, "0");
    const { client, target } = await seedThreeDeep();
    renderRefs(client, target);
    await flushSync();
    expect(document.body.textContent).toContain("Middle block");
    expect(document.body.textContent).toContain("Deep block");
  });

  it("level 0 is the default when the setting was never written", async () => {
    const { client, target } = await seedThreeDeep();
    renderRefs(client, target);
    await flushSync();
    expect(document.body.textContent).toContain("Deep block");
  });

  it("level 1 folds the top-level rows (their children hidden)", async () => {
    localStorage.setItem(SETTING_KEY, "1");
    const { client, target } = await seedThreeDeep();
    renderRefs(client, target);
    await flushSync();
    // The row itself still renders; its subtree stays behind the chevron.
    expect(document.body.textContent).toContain("Source");
    expect(document.body.textContent).not.toContain("Middle block");
  });

  it("level 2 expands the top-level rows and folds their children", async () => {
    localStorage.setItem(SETTING_KEY, "2");
    const { client, target } = await seedThreeDeep();
    renderRefs(client, target);
    await flushSync();
    expect(document.body.textContent).toContain("Middle block");
    expect(document.body.textContent).not.toContain("Deep block");
  });

  it("a folded row unfolds on chevron click (the session-local override)", async () => {
    localStorage.setItem(SETTING_KEY, "1");
    const { client, target } = await seedThreeDeep();
    renderRefs(client, target);
    await flushSync();
    const row = document.querySelector(".nt-block[data-block-id]") as HTMLElement;
    expect(row).not.toBeNull();
    const toggle = row.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle.click();
    });
    expect(document.body.textContent).toContain("Middle block");
  });

  it("any flat NodeCollection honors the setting (query-result shape)", async () => {
    localStorage.setItem(SETTING_KEY, "1");
    const client = await seedClient();
    const parent = await client.createObject({ isEmbedded: false, name: "Hub row" });
    await client.createObject({
      parentId: parent,
      contentAst: [{ type: "text", text: "Hub child" }],
    });
    await flushSync();
    render(
      <NodeCollection
        viewMode="outline"
        client={client}
        items={[{ node: client.getNode(parent)! }]}
      />,
    );
    await flushSync();
    expect(document.body.textContent).toContain("Hub row");
    expect(document.body.textContent).not.toContain("Hub child");
  });

  it("a tree NodeCollection (the Child pages shape) never auto-folds", async () => {
    localStorage.setItem(SETTING_KEY, "1");
    const client = await seedClient();
    const parent = await client.createObject({ isEmbedded: false, name: "Tree row" });
    await client.createObject({
      parentId: parent,
      contentAst: [{ type: "text", text: "Tree child" }],
    });
    await flushSync();
    const node = client.getNode(parent)!;
    render(
      <NodeCollection
        viewMode="outline"
        client={client}
        tree
        readOnly
        items={[
          {
            node,
            children: client.getChildren(parent).map((child) => ({ node: child })),
          },
        ]}
      />,
    );
    await flushSync();
    // The tree path owns its collapse semantics — the setting does not apply.
    expect(document.body.textContent).toContain("Tree child");
  });

  it("the collapse flag opts a flat collection out (legacy fold at level 0)", async () => {
    localStorage.setItem(SETTING_KEY, "0");
    const client = await seedClient();
    const parent = await client.createObject({ isEmbedded: false, name: "Owned row" });
    await client.createObject({
      parentId: parent,
      contentAst: [{ type: "text", text: "Owned child" }],
    });
    await flushSync();
    render(
      <NodeCollection
        viewMode="outline"
        client={client}
        collapse
        items={[{ node: client.getNode(parent)! }]}
      />,
    );
    await flushSync();
    // Opted out: the pre-setting blanket default stands (row folded).
    expect(document.body.textContent).not.toContain("Owned child");
  });
});
