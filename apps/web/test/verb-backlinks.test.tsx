/**
 * Bound-verb backlinks: a property
 * value over a bound verb schema (object/multi, created by the
 * create-and-bind gesture) projects into the edge index with verb =
 * propertySchemaId and target = the referenced node — so the TARGET's
 * linked references (the page section AND the block-level backlink gutter)
 * list it, the row opening the source like any other reference. The row
 * end stays identity chrome — the verb-badge naming the schema the edge
 * arrived through is retired (the property context lives in the row's own
 * Properties table). Typed-link marks
 * themselves stay targetless (the deferred-resolution ruling) — this
 * slice wires the designed targeted path (property values), not a
 * resolution heuristic. Harness: in-process WorkspaceClient + jsdom.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";
import { BlockBacklinkPanel } from "../src/ui/BlockBacklinks.js";
import { NodeCollection, groupByContainingPage } from "../src/features/collection/index.js";

/**
 * The reference collection the section composes (the retired ReferenceList's
 * exact composition) — the subject under test is the row chrome, not the
 * section chrome.
 */
function ReferenceCollection({
  client,
  target,
  onOpenPage,
}: {
  client: WorkspaceClient;
  target: string;
  onOpenPage: (id: string) => void;
}) {
  const items = client.getLinkedReferences(target).map((entry) => ({
    node: client.getNode(entry.source.id) ?? entry.source,
    meta: { containingPageId: entry.containingPageId, verb: entry.verb },
  }));
  const { standalone, groups } = groupByContainingPage(client, items, onOpenPage);
  return (
    <NodeCollection
      viewMode="outline"
      client={client}
      items={items}
      readOnly={false}
      groups={groups}
      ungroupedItems={standalone}
      onNodeClick={onOpenPage}
    />
  );
}

const WS = "0192a000-0000-7000-8000-0000000000e1";
const ACTOR = "0192a000-0000-7000-8000-0000000000e2";

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

/** The bound-verb shape the PG1 create-and-bind gesture authors. */
async function boundVerbSchema(client: WorkspaceClient, name: string): Promise<string> {
  return client.createPropertySchema({
    name,
    type: "object",
    multi: true,
    targetClassFilter: [],
  });
}

describe("bound-verb backlinks", () => {
  it("a bound-schema property value lists in the target's linked references with the verb", async () => {
    const client = await seedClient();
    const schemaId = await boundVerbSchema(client, "supports");
    const target = await client.createObject({ isEmbedded: false, name: "Target" });
    const source = await client.createObject({ isEmbedded: false, name: "Source" });
    await client.setProperty(source, schemaId, { nodeId: target }, 0);
    await flushSync();

    const entries = client.getLinkedReferences(target);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.containingPageId).toBe(source);
    expect(entries[0]!.verb).toBe(schemaId);
    // A plain mention row carries no verb. (The mention lives on a child
    // block — the entry's source is the block, its containing page the
    // mentioner.)
    const mentionSource = await client.createObject({ isEmbedded: false, name: "Mentioner" });
    await client.createObject({
      parentId: mentionSource,
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: target },
      ],
    });
    await flushSync();
    const mixed = client.getLinkedReferences(target);
    expect(mixed.find((e) => e.containingPageId === mentionSource)?.verb).toBeNull();
    expect(mixed.find((e) => e.containingPageId === source)?.verb).toBe(schemaId);
  });

  it("the linked-references row carries no verb badge and opens the source like any reference", async () => {
    const client = await seedClient();
    const schemaId = await boundVerbSchema(client, "supports");
    const target = await client.createObject({ isEmbedded: false, name: "Target" });
    const source = await client.createObject({ isEmbedded: false, name: "Source" });
    await client.setProperty(source, schemaId, { nodeId: target }, 0);
    await flushSync();

    const onOpenPage = vi.fn();
    render(<ReferenceCollection client={client} target={target} onOpenPage={onOpenPage} />);
    // The row end is identity chrome: the bound-verb badge that named the
    // property schema the edge arrived through is retired — the property
    // context lives in the row's own Properties table.
    expect(document.querySelector(".nt-ref-verb")).toBeNull();

    // The source IS its containing page (the property value lives on the
    // page itself), so stands: no self-named
    // one-row group — the page source rides the top-level flat outline.
    expect(document.querySelector(".outline-group")).toBeNull();
    const row = document.querySelector("ul.outline-flat > li")!;
    expect(row.textContent).toContain("Source");
  });

  it("the block-level backlink gutter lists the property source with no verb badge", async () => {
    const client = await seedClient();
    const schemaId = await boundVerbSchema(client, "cites");
    const hostPage = await client.createObject({ isEmbedded: false, name: "Host" });
    const targetBlock = await client.createObject({
      parentId: hostPage,
      contentAst: [{ type: "text", text: "The claim" }],
    });
    const source = await client.createObject({ isEmbedded: false, name: "Paper" });
    await client.setProperty(source, schemaId, { nodeId: targetBlock }, 0);
    await flushSync();

    render(<PageView client={client} pageId={hostPage} />);
    await flushSync();
    fireEvent.click(screen.getByRole("button", { name: "1 linked reference" }));
    const panel = document.querySelector(".nt-block-backlink-refs") as HTMLElement;
    await waitFor(() => expect(within(panel).getByText("Paper")).not.toBeNull());
    // No verb badge on the gutter row either — the seam is retired
    // everywhere the reference list renders.
    expect(panel.querySelector(".nt-ref-verb")).toBeNull();
  });

  it("unlinked references never carry a verb badge", async () => {
    const client = await seedClient();
    const target = await client.createObject({ isEmbedded: false, name: "Lonely Target" });
    const source = await client.createObject({ isEmbedded: false, name: "Scribe" });
    await client.createObject({
      parentId: source,
      contentAst: [{ type: "text", text: "Lonely Target is mentioned in prose only" }],
    });
    await flushSync();

    render(<ReferenceCollection client={client} target={target} onOpenPage={vi.fn()} />);
    expect(document.querySelector(".nt-ref-verb")).toBeNull();
  });
});
