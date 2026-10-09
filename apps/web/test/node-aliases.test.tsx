/**
 * Node aliases (SCHEMA.md "Node aliases") — the `aliasedNodeId` wire node
 * field (the retired `aliasOf` property carrier is gone):
 *
 *  - the ALIAS page carries the field pointing at its MAIN page (one-way;
 *    the main page holds nothing);
 *  - the main page's linked references roll up the alias's inbound edges
 *    (kind: "alias", additive — the alias page's own view lists ONLY its
 *    own edges); the roll-up rides the store's recursive read over the
 *    `aliased_node_id` column, chains included;
 *  - an alias page's title is a name-equivalent of the main page (unlinked
 *    references), while a source that LINKS the alias is NOT unlinked for
 *    the main (it is already linked by alias);
 *  - links keep the alias uuid at authoring — no rewriting; navigation
 *    resolves (the App funnels route every open through resolveAliasOpen,
 *    the client seam over the store's cycle-safe chain walker);
 *  - the aliases UI: the "Aliases" row at the TOP of the metadata panel
 *    (owner 2026-10-09; relocated from the title-row button) lists every
 *    alias as a pill — the pill opens the alias's OWN view (the RAW bypass)
 *    and its × clears THE ALIAS's field — and ADD writes THE SELECTED
 *    node's field (the backward write); the alias's own view carries the
 *    "Aliased node" pseudo-property row, re-pointable and clearable from
 *    the alias side;
 *  - the page restriction is enforced client-side: the write guard rejects
 *    non-page targets with a visible error, never writing.
 *
 * jsdom over the in-process WorkspaceClient, like block-backlinks.test.tsx.
 * Every write kicks a floating engine push whose ack notifies later
 * (microtasks), so each test flushes the queue after seeding.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PropertiesTable } from "../src/ui/components/MetadataSection.js";
import { aliasedNodeTargetError, resolveAliasOpen } from "../src/ui/components/aliasProperty.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

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

/** Page + alias page pointing at it (the wire-field write). */
async function seedAliasPair(
  client: WorkspaceClient,
  mainName: string,
  aliasName: string,
): Promise<{ mainId: string; aliasId: string }> {
  const mainId = await client.createObject({ presentAsMain: true, name: mainName });
  const aliasId = await client.createObject({ presentAsMain: true, name: aliasName });
  await client.updateObject(aliasId, { aliasedNodeId: mainId });
  return { mainId, aliasId };
}

/** A page containing one mention of `targetId`. */
async function seedMention(
  client: WorkspaceClient,
  name: string,
  targetId: string,
  text: string,
): Promise<string> {
  const pageId = await client.createObject({ presentAsMain: true, name });
  await client.createObject({
    parentId: pageId,
    contentAst: [
      { type: "text", text: "see " },
      { type: "mention", targetNodeId: targetId, text, linkId: `l-${name}` },
    ],
  });
  return pageId;
}

describe("node aliases: linked-references roll-up", () => {
  it("a link to an alias appears under the main's backlinks AND the alias's own (additive)", async () => {
    const client = await seedClient();
    const { mainId, aliasId } = await seedAliasPair(client, "Cat", "Cats");
    const sourceAlias = await seedMention(client, "Source A", aliasId, "Cats");
    const sourceMain = await seedMention(client, "Source B", mainId, "Cat");

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
    const aliasPages = new Map(aliasRefs.map((entry) => [entry.containingPageId, entry.kind]));
    expect(aliasPages.get(sourceAlias)).toBe("direct");
    expect(aliasPages.has(sourceMain)).toBe(false);
  });

  it("a CHAIN alias rolls up to the chain terminal's backlinks", async () => {
    const client = await seedClient();
    const { mainId, aliasId } = await seedAliasPair(client, "Cat", "Cats");
    const chainId = await client.createObject({ presentAsMain: true, name: "Felines" });
    await client.updateObject(chainId, { aliasedNodeId: aliasId });
    const sourceChain = await seedMention(client, "Source C", chainId, "Felines");

    const mainRefs = client.getLinkedReferences(mainId);
    expect(
      mainRefs.find((entry) => entry.containingPageId === sourceChain)?.kind,
    ).toBe("alias");
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

  it("a source that LINKS the alias is not an unlinked reference of the main (already linked by alias)", async () => {
    const client = await seedClient();
    const { mainId, aliasId } = await seedAliasPair(client, "Cat", "Cats");
    const linker = await seedMention(client, "Linker", aliasId, "Cats");
    // A literal-text mention of the alias title (no link) IS unlinked.
    const literal = await client.createObject({ presentAsMain: true, name: "Literal" });
    await client.createObject({
      parentId: literal,
      contentAst: [{ type: "text", text: "Cats are great" }],
    });

    const unlinked = client.getUnlinkedReferences(mainId);
    const pages = new Set(unlinked.map((entry) => entry.containingPageId));
    expect(pages.has(literal)).toBe(true);
    expect(pages.has(linker)).toBe(false);
  });
});

describe("node aliases: the redirect seam (resolveAliasOpen)", () => {
  it("resolves chains to the terminal; ordinary ids pass through unchanged", async () => {
    const client = await seedClient();
    const { mainId, aliasId } = await seedAliasPair(client, "Cat", "Cats");
    const chainId = await client.createObject({ presentAsMain: true, name: "Felines" });
    await client.updateObject(chainId, { aliasedNodeId: aliasId });

    expect(resolveAliasOpen(client, chainId)).toBe(mainId);
    expect(resolveAliasOpen(client, aliasId)).toBe(mainId);
    expect(resolveAliasOpen(client, mainId)).toBe(mainId);
    const plain = await client.createObject({ presentAsMain: true, name: "Dog" });
    expect(resolveAliasOpen(client, plain)).toBe(plain);
  });
});

describe("node aliases: links keep the alias uuid (no authoring rewrite)", () => {
  it("a mention authored to the alias keeps the alias uuid as its target; the seam resolves", async () => {
    const client = await seedClient();
    const { mainId, aliasId } = await seedAliasPair(client, "Cat", "Cats");
    await seedMention(client, "Source A", aliasId, "Cats");

    // The derived edge index carries the ALIAS uuid as the target — the
    // link is authored as-is, never rewritten to the main page.
    const aliasBacklinks = client.getBacklinks(aliasId);
    expect(aliasBacklinks.length).toBeGreaterThan(0);
    expect(aliasBacklinks.every((edge) => edge.targetId === aliasId)).toBe(true);
    // The Source A mention is NOT among the main page's direct backlinks…
    const sourceBlock = client.getChildren(
      (await client.resolveNodeByName("Source A"))!,
    )[0]!;
    const mainBacklinks = client.getBacklinks(mainId);
    expect(mainBacklinks.every((edge) => edge.targetId === mainId)).toBe(true);
    expect(mainBacklinks.some((edge) => edge.sourceId === sourceBlock.id)).toBe(false);
    // …and the alias's direct backlinks include the mention edge.
    expect(aliasBacklinks.some((edge) => edge.sourceId === sourceBlock.id)).toBe(true);

    // Navigation resolves: the mention's target opens the MAIN page.
    expect(resolveAliasOpen(client, aliasId)).toBe(mainId);
  });
});

describe("node aliases: name equivalence", () => {
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

  it("an alias page's own title resolves to the alias page (navigation redirects)", async () => {
    const client = await seedClient();
    const { aliasId } = await seedAliasPair(client, "Cat", "Felines");
    expect(client.resolveNodeByName("Felines")).toBe(aliasId);
    expect(client.resolveNodeByName("felines")).toBe(aliasId);
    // …and the seam maps it to the main page for opening.
    expect(resolveAliasOpen(client, client.resolveNodeByName("Felines")!)).not.toBe(aliasId);
  });
});

describe("node aliases: navigation semantics", () => {
  it("clicking a mention of the alias calls onOpenPage with the alias id; the funnel seam opens the MAIN page", async () => {
    const client = await seedClient();
    const { mainId, aliasId } = await seedAliasPair(client, "Cat", "Cats");
    const sourceId = await seedMention(client, "Source A", aliasId, "Cats");
    await flushSync();

    // The App funnel contract: onOpenPage IS the resolving seam
    // (openPage = openPageAt(resolveAliasOpen(id))).
    const opened: string[] = [];
    render(
      <PageView
        client={client}
        pageId={sourceId}
        onOpenPage={(id) => opened.push(resolveAliasOpen(client, id))}
      />,
    );
    await flushSync();

    fireEvent.click(screen.getByRole("button", { name: "Cats" }));
    expect(opened).toEqual([mainId]);
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
  it("aliasedNodeTargetError rejects blocks and classes, accepts pages", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Cat" });
    const blockId = await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "a block" }],
    });
    const classId = await client.createClass("A Class");

    expect(aliasedNodeTargetError(client, pageId)).toBeNull();
    expect(aliasedNodeTargetError(client, blockId)).toBe(
      "Aliased node: the target must be a page.",
    );
    expect(aliasedNodeTargetError(client, classId)).toBe(
      "Aliased node: the target must be a page.",
    );
    expect(aliasedNodeTargetError(client, "0192a000-0000-7000-8000-000000000099")).toBe(
      "Aliased node: the target must be a page.",
    );
  });
});

describe("node aliases: the aliases UI (the metadata panel's Aliases row)", () => {
  it("the main page's metadata panel lists the aliases as pills; the pill opens the alias's OWN view (bypass)", async () => {
    const client = await seedClient();
    const { aliasId } = await seedAliasPair(client, "Cat", "Cats");
    await flushSync();

    const onOpenPage = vi.fn();
    const onOpenPageRaw = vi.fn();
    render(
      <PageView
        client={client}
        pageId={(await client.resolveNodeByName("Cat"))!}
        onOpenPage={onOpenPage}
        onOpenPageRaw={onOpenPageRaw}
      />,
    );
    await flushSync();

    // The row rides the metadata panel's top (the side panel, panelled
    // layout): the alias names itself on a pill — no title-row button.
    const row = screen.getByText("Aliases:").closest(".nt-aliases-row") as HTMLElement;
    expect(row).not.toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Cats" }));
    // The bypass: the RAW open — the alias view, not the redirect.
    expect(onOpenPageRaw).toHaveBeenCalledWith(aliasId);
    expect(onOpenPage).not.toHaveBeenCalled();
  });

  it("ADD picks a node and writes THE SELECTED node's aliasedNodeId (the backward write); already-aliased nodes filter out; the × clears the alias", async () => {
    const client = await seedClient();
    const { mainId, aliasId } = await seedAliasPair(client, "Cat", "Cats");
    const dogId = await client.createObject({ presentAsMain: true, name: "Dog" });
    await flushSync();

    const onOpenPage = vi.fn();
    render(<PageView client={client} pageId={mainId} onOpenPage={onOpenPage} />);
    await flushSync();

    fireEvent.click(screen.getByRole("button", { name: /^Add alias$/ }));

    const searchInput = screen.getByLabelText("Search pages…");
    const picker = screen.getByRole("dialog", { name: "Select node" });
    // The already-aliased "Cats" never appears as a candidate (the row's
    // own pill matches the name globally — the assertion is picker-scoped)…
    fireEvent.change(searchInput, { target: { value: "Cats" } });
    expect(within(picker).queryByText("Cats")).toBeNull();
    fireEvent.change(searchInput, { target: { value: "Dog" } });
    fireEvent.click(screen.getByText("Dog").closest("button")!);
    await flushSync();

    // …and the pick lands on the SELECTED node's field — the main page's
    // own field stays untouched (it holds nothing).
    expect(client.getNode(dogId)?.aliasedNodeId).toBe(mainId);
    expect(client.getNode(mainId)?.aliasedNodeId).toBeNull();
    expect(client.getNode(aliasId)?.aliasedNodeId).toBe(mainId);

    // Both aliases now ride the row as pills (the retired count button is
    // gone — the list itself is the count).
    const row = screen.getByText("Aliases:").closest(".nt-aliases-row") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Cats" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Dog" })).toBeInTheDocument();

    // The × per entry clears THE ALIAS's own field — the removal path.
    fireEvent.click(within(row).getByRole("button", { name: "Remove alias Dog" }));
    await flushSync();
    expect(client.getNode(dogId)?.aliasedNodeId).toBeNull();
    const rowAfter = screen.getByText("Aliases:").closest(".nt-aliases-row") as HTMLElement;
    expect(within(rowAfter).queryByRole("button", { name: "Dog" })).toBeNull();
  });
});

describe("node aliases: the alias-side pseudo-property row", () => {
  it("the alias view carries the 'Aliased node' row naming the main; Change re-points it; the pill clears it", async () => {
    const client = await seedClient();
    const { mainId, aliasId } = await seedAliasPair(client, "Cat", "Cats");
    const otherId = await client.createObject({ presentAsMain: true, name: "Dog" });
    await flushSync();

    render(<PropertiesTable client={client} nodeId={aliasId} />);
    const row = screen.getByText("Aliased node").closest("li")!;
    expect(within(row).getByRole("button", { name: "Cat" })).toBeInTheDocument();

    // Re-point: Change → pick "Dog" → the ALIAS's field moves.
    fireEvent.click(within(row).getByRole("button", { name: /Change aliased node/ }));
    const searchInput = screen.getByLabelText("Search Aliased node");
    fireEvent.change(searchInput, { target: { value: "Dog" } });
    fireEvent.click(screen.getByText("Dog").closest("button")!);
    await flushSync();
    expect(client.getNode(aliasId)?.aliasedNodeId).toBe(otherId);
    expect(client.getNode(mainId)?.aliasedNodeId).toBeNull();

    // Clear: the × writes present-null; the row renders null afterwards.
    const rowAfter = screen.getByText("Aliased node").closest("li")!;
    fireEvent.click(within(rowAfter).getByRole("button", { name: /Remove alias target/ }));
    await flushSync();
    expect(client.getNode(aliasId)?.aliasedNodeId).toBeNull();
  });

  it("an ordinary page renders no 'Aliased node' row; neither does a block carrier", async () => {
    const client = await seedClient();
    const { mainId } = await seedAliasPair(client, "Cat", "Cats");
    const pageId = await client.createObject({ presentAsMain: true, name: "Dog" });
    const blockHost = await client.createObject({ presentAsMain: true, name: "Host" });
    const blockId = await client.createObject({
      parentId: blockHost,
      contentAst: [{ type: "text", text: "a block" }],
    });
    // A stray field on the block (raw writer bypass): the row still hides —
    // every read filters aliases to pages.
    await client.updateObject(blockId, { aliasedNodeId: mainId });
    await flushSync();

    const { container, unmount } = render(<PropertiesTable client={client} nodeId={pageId} />);
    expect(container.textContent).not.toContain("Aliased node");
    unmount();

    const { container: blockContainer } = render(
      <PropertiesTable client={client} nodeId={blockId} />,
    );
    expect(blockContainer.textContent).not.toContain("Aliased node");
  });
});
