/**
 * Node aliases (issue #7) — the seeded single-value node-typed `aliasOf`
 * property (SCHEMA.md "Node aliases"):
 *
 *  - the ALIAS page carries {nodeId} of its MAIN page (one-way);
 *  - the main page's linked references roll up the alias's inbound edges
 *    (query-time union over the derived edge index — no derived-schema
 *    change); the alias page's own view lists ONLY its own edges;
 *  - the alias page's title is a name-equivalent of the main page
 *    (resolveNodeByName + unlinked references);
 *  - mention clicks targeting an alias open the MAIN page's view, while the
 *    alias page itself (opened as a node) shows its own view plus an
 *    "Alias of <main>" banner jumping to the main page;
 *  - the page restriction is enforced client-side: the alias row offers
 *    pages only and the write path rejects non-page targets with a visible
 *    error, never writing them.
 *
 * jsdom over the in-process WorkspaceClient, like block-backlinks.test.tsx.
 * Every write kicks a floating engine push whose ack notifies later
 * (microtasks), so each test flushes the queue after seeding.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PropertiesTable } from "../src/ui/components/MetadataSection.js";
import {
  aliasOfPageTargetError,
  ensureAliasOfProperty,
} from "../src/ui/components/aliasProperty.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const ALIAS_OF = SYSTEM_PROPERTY_UUIDS.aliasOf;

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

/** Drain the microtasks a write's floating push+ack chain runs on. */
async function flushSync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => {});
}

/** Page + alias page pointing at it (the aliasOf schema ensured first). */
async function seedAliasPair(
  client: WorkspaceClient,
  mainName: string,
  aliasName: string,
): Promise<{ mainId: string; aliasId: string }> {
  const mainId = await client.createObject({ presentAsMain: true, name: mainName });
  const aliasId = await client.createObject({ presentAsMain: true, name: aliasName });
  await ensureAliasOfProperty(client);
  await client.setProperty(aliasId, ALIAS_OF, { nodeId: mainId }, 0);
  return { mainId, aliasId };
}

describe("node aliases: linked-references roll-up", () => {
  it("the main page's linked references union the alias's inbound edges; the alias page lists only its own", async () => {
    const client = await seedClient();
    const { mainId, aliasId } = await seedAliasPair(client, "Cat", "Cats");
    const sourceAlias = await client.createObject({ presentAsMain: true, name: "Source A" });
    await client.createObject({
      parentId: sourceAlias,
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: aliasId, text: "Cats", linkId: "l1" },
      ],
    });
    const sourceMain = await client.createObject({ presentAsMain: true, name: "Source B" });
    await client.createObject({
      parentId: sourceMain,
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: mainId, text: "Cat", linkId: "l2" },
      ],
    });

    const mainRefs = client.getLinkedReferences(mainId);
    // Entries carry the linking BLOCK as source — the page shows up as the
    // containing page (the breadcrumb).
    const byPage = new Map(mainRefs.map((entry) => [entry.containingPageId, entry]));
    // The edge targeting the alias surfaces under the MAIN page…
    expect(byPage.get(sourceAlias)?.kind).toBe("alias");
    // …alongside the edge targeting the main page directly.
    expect(byPage.get(sourceMain)?.kind).toBe("direct");

    // The alias page's own view: only its own edges — the Source B edge
    // targets the main page, never the alias, so it stays off the alias.
    const aliasRefs = client.getLinkedReferences(aliasId);
    const aliasPages = new Set(aliasRefs.map((entry) => entry.containingPageId));
    expect(aliasPages.has(sourceAlias)).toBe(true);
    expect(aliasPages.has(sourceMain)).toBe(false);
    expect(
      aliasRefs.find((entry) => entry.containingPageId === sourceAlias)?.kind,
    ).toBe("direct");
  });

  it("a link from inside the alias's own subtree to the alias is content, not a main-page reference", async () => {
    const client = await seedClient();
    const { mainId, aliasId } = await seedAliasPair(client, "Cat", "Cats");
    await client.createObject({
      parentId: aliasId,
      contentAst: [
        { type: "text", text: "self " },
        { type: "mention", targetNodeId: mainId, text: "Cat", linkId: "l3" },
      ],
    });
    const aliasSelf = await client.createObject({
      parentId: aliasId,
      contentAst: [
        { type: "text", text: "self " },
        { type: "mention", targetNodeId: aliasId, text: "Cats", linkId: "l4" },
      ],
    });

    const mainRefs = client.getLinkedReferences(mainId);
    // The alias page's own body links to the main page — a direct reference
    // (the edge targets the main page itself)…
    expect(mainRefs.some((entry) => entry.containingPageId === aliasId)).toBe(true);
    // …but the alias's child block mentioning the alias is the alias's own
    // content: it must not ALSO surface as an alias roll-up row.
    expect(mainRefs.some((entry) => entry.source.id === aliasSelf)).toBe(false);
  });
});

describe("node aliases: name equivalence", () => {
  it("resolveNodeByName resolves the alias title to the alias page (the mention target)", async () => {
    const client = await seedClient();
    const { aliasId } = await seedAliasPair(client, "Cat", "Felines");
    expect(client.resolveNodeByName("Felines")).toBe(aliasId);
    expect(client.resolveNodeByName("felines")).toBe(aliasId);
    expect(client.resolveNodeByName("Cat")).not.toBeNull();
  });

  it("the alias title joins the main page's unlinked-reference names", async () => {
    const client = await seedClient();
    const { mainId } = await seedAliasPair(client, "Cat", "Felines");
    const plain = await client.createObject({ presentAsMain: true, name: "Plain Source" });
    await client.createObject({
      parentId: plain,
      contentAst: [{ type: "text", text: "Felines" }],
    });

    const unlinked = client.getUnlinkedReferences(mainId);
    expect(unlinked.some((entry) => entry.containingPageId === plain)).toBe(true);
  });
});

describe("node aliases: navigation semantics", () => {
  it("clicking a mention of the alias opens the MAIN page's view", async () => {
    const client = await seedClient();
    const { mainId, aliasId } = await seedAliasPair(client, "Cat", "Cats");
    const sourceId = await client.createObject({ presentAsMain: true, name: "Source A" });
    await client.createObject({
      parentId: sourceId,
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: aliasId, text: "Cats", linkId: "l5" },
      ],
    });
    await flushSync();

    const onOpenPage = vi.fn();
    render(<PageView client={client} pageId={sourceId} onOpenPage={onOpenPage} />);
    await flushSync();

    fireEvent.click(screen.getByRole("button", { name: "Cats" }));
    expect(onOpenPage).toHaveBeenCalledWith(mainId);
  });

  it("the alias view carries an 'Alias of <main>' banner that jumps to the main page", async () => {
    const client = await seedClient();
    const { mainId, aliasId } = await seedAliasPair(client, "Cat", "Cats");
    await flushSync();

    const onOpenPage = vi.fn();
    render(<PageView client={client} pageId={aliasId} onOpenPage={onOpenPage} />);
    await flushSync();

    const banner = screen.getByRole("button", { name: "Alias of Cat" });
    expect(banner).toBeInTheDocument();
    fireEvent.click(banner);
    expect(onOpenPage).toHaveBeenCalledWith(mainId);
  });

  it("opening the alias page directly shows its own view (no redirect)", async () => {
    const client = await seedClient();
    const { aliasId } = await seedAliasPair(client, "Cat", "Cats");
    await flushSync();

    const onOpenPage = vi.fn();
    const { container } = render(
      <PageView client={client} pageId={aliasId} onOpenPage={onOpenPage} />,
    );
    await flushSync();

    // The alias's own title renders (the header title row) — the view is
    // the alias's.
    expect(container.querySelector(".nt-block--title")!.textContent).toBe("Cats");
    expect(onOpenPage).not.toHaveBeenCalled();
  });
});

describe("node aliases: page restriction (client-side enforcement)", () => {
  it("aliasOfPageTargetError rejects blocks and classes, accepts pages", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Cat" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "a block" }],
    });
    const classId = await client.createClass("A Class");

    expect(aliasOfPageTargetError(client, pageId)).toBeNull();
    expect(aliasOfPageTargetError(client, blockId)).toBe(
      "Alias of: the target must be a page.",
    );
    expect(aliasOfPageTargetError(client, classId)).toBe(
      "Alias of: the target must be a page.",
    );
    expect(aliasOfPageTargetError(client, "0192a000-0000-7000-8000-000000000099")).toBe(
      "Alias of: the target must be a page.",
    );
  });

  it("the alias row offers pages only and writes a valid pick through the picker", async () => {
    const client = await seedClient();
    await ensureAliasOfProperty(client);
    // A fresh alias page WITHOUT a value yet (single-value row hides its Add
    // affordance once a pill exists).
    const aliasId = await client.createObject({ presentAsMain: true, name: "Felines" });
    const pageId = await client.createObject({ presentAsMain: true, name: "Dog" });
    const hostId = await client.createObject({ presentAsMain: true, name: "Host" });
    const blockId = await client.createObject({
      parentId: hostId,
      contentAst: [{ type: "text", text: "Blocky" }],
    });
    await flushSync();

    render(<PropertiesTable client={client} nodeId={aliasId} />);

    // The row label renders with the Add affordance.
    const row = screen.getByText("Alias of").closest("li")!;
    const addButton = within(row).getByRole("button", { name: "Add" });
    fireEvent.click(addButton);

    // The picker offers PAGES only: "Dog" matches, the inline block "Blocky"
    // never appears in the candidate set.
    const searchInput = screen.getByLabelText("Search Alias of");
    fireEvent.change(searchInput, { target: { value: "Dog" } });
    expect(screen.getByText("Dog")).toBeInTheDocument();
    fireEvent.change(searchInput, { target: { value: "Blocky" } });
    expect(screen.queryByText("Blocky")).toBeNull();
    expect(blockId).not.toBeNull(); // the block stayed a non-candidate above

    fireEvent.change(searchInput, { target: { value: "Dog" } });
    fireEvent.click(screen.getByText("Dog").closest("button")!);
    await flushSync();

    // Written: the authored aliasOf value names the picked page.
    const authored = client
      .getEffectiveProperties(aliasId)
      .filter((entry) => entry.propertySchemaId === ALIAS_OF && entry.source === "authored");
    expect(authored).toHaveLength(1);
    expect(authored[0]!.value).toEqual({ nodeId: pageId });
  });

  it("the alias row does not render for inline-block carriers", async () => {
    const client = await seedClient();
    await ensureAliasOfProperty(client);
    const pageId = await client.createObject({ presentAsMain: true, name: "Host" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "a block" }],
    });
    // A stray value bypassing the panel (raw writer) — the row still hides.
    await client.setProperty(blockId, ALIAS_OF, { nodeId: pageId }, 0);
    await flushSync();

    const { container, unmount } = render(<PropertiesTable client={client} nodeId={blockId} />);
    expect(container.textContent).not.toContain("Alias of");
    unmount();

    // …while the page carrier renders the row (a "Cat" pointing at "Host").
    const aliasId = await client.createObject({ presentAsMain: true, name: "Cat" });
    await client.setProperty(aliasId, ALIAS_OF, { nodeId: pageId }, 0);
    await flushSync();
    const { container: pageContainer } = render(
      <PropertiesTable client={client} nodeId={aliasId} />,
    );
    expect(pageContainer.textContent).toContain("Alias of");
  });
});
