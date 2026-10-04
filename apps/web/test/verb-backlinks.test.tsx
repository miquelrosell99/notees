/**
 * Bound-verb backlinks (§34.69 — the §34.66 boundary follow-up): a property
 * value over a bound verb schema (object/multi, created by the PG1
 * create-and-bind gesture) projects into the edge index with verb =
 * propertySchemaId and target = the referenced node — so the TARGET's
 * linked references (the page section AND the block-level backlink gutter)
 * list it. The surfaces render the verb's SCHEMA NAME (never the raw id)
 * and the row opens the source like any other reference. Typed-link marks
 * themselves stay targetless (the M2-deferred resolution ruling) — this
 * slice wires the designed targeted path (property values), not a
 * resolution heuristic. Harness: in-process WorkspaceClient + jsdom.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { ReferenceList } from "../src/ui/components/SystemSections.js";
import { BlockBacklinkPanel } from "../src/ui/BlockBacklinks.js";

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

describe("bound-verb backlinks (§34.69)", () => {
  it("a bound-schema property value lists in the target's linked references with the verb", async () => {
    const client = await seedClient();
    const schemaId = await boundVerbSchema(client, "supports");
    const target = await client.createObject({ presentAsMain: true, name: "Target" });
    const source = await client.createObject({ presentAsMain: true, name: "Source" });
    await client.setProperty(source, schemaId, { nodeId: target }, 0);
    await flushSync();

    const entries = client.getLinkedReferences(target);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.containingPageId).toBe(source);
    expect(entries[0]!.verb).toBe(schemaId);
    // A plain mention row carries no verb. (The mention lives on a child
    // block — the entry's source is the block, its containing page the
    // mentioner.)
    const mentionSource = await client.createObject({ presentAsMain: true, name: "Mentioner" });
    await client.createObject({
      parentId: mentionSource,
      contentAst: [
        { type: "text", text: "see " },
        { type: "mention", targetNodeId: target, text: "Target" },
      ],
    });
    await flushSync();
    const mixed = client.getLinkedReferences(target);
    expect(mixed.find((e) => e.containingPageId === mentionSource)?.verb).toBeNull();
    expect(mixed.find((e) => e.containingPageId === source)?.verb).toBe(schemaId);
  });

  it("the linked-references surface renders the schema NAME badge and opens the source on click", async () => {
    const client = await seedClient();
    const schemaId = await boundVerbSchema(client, "supports");
    const target = await client.createObject({ presentAsMain: true, name: "Target" });
    const source = await client.createObject({ presentAsMain: true, name: "Source" });
    await client.setProperty(source, schemaId, { nodeId: target }, 0);
    await flushSync();

    const onOpenPage = vi.fn();
    render(
      <ReferenceList
        entries={client.getLinkedReferences(target)}
        client={client}
        onOpenPage={onOpenPage}
      />,
    );
    const badge = screen.getByText("supports");
    expect(badge.getAttribute("title")).toBe("via supports");
    expect(badge.classList.contains("nt-ref-verb")).toBe(true);

    // The row opens the source like other references: the containing-page
    // group header navigates to the referencing page on click.
    const header = screen.getByRole("button", { name: /^Source/ });
    fireEvent.click(header);
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledWith(source));
  });

  it("the block-level backlink gutter renders the verb badge for a block target", async () => {
    const client = await seedClient();
    const schemaId = await boundVerbSchema(client, "cites");
    const hostPage = await client.createObject({ presentAsMain: true, name: "Host" });
    const targetBlock = await client.createObject({
      parentId: hostPage,
      contentAst: [{ type: "text", text: "The claim" }],
    });
    const source = await client.createObject({ presentAsMain: true, name: "Paper" });
    await client.setProperty(source, schemaId, { nodeId: targetBlock }, 0);
    await flushSync();

    render(<PageView client={client} pageId={hostPage} />);
    await flushSync();
    fireEvent.click(screen.getByRole("button", { name: "1 linked reference" }));
    const panel = document.querySelector(".nt-block-backlink-refs") as HTMLElement;
    await waitFor(() => expect(within(panel).getByText("cites")).not.toBeNull());
    expect((within(panel).getByText("cites") as HTMLElement).classList.contains("nt-ref-verb")).toBe(
      true,
    );
  });

  it("unlinked references never carry a verb badge", async () => {
    const client = await seedClient();
    const target = await client.createObject({ presentAsMain: true, name: "Lonely Target" });
    const source = await client.createObject({ presentAsMain: true, name: "Scribe" });
    await client.createObject({
      parentId: source,
      contentAst: [{ type: "text", text: "Lonely Target is mentioned in prose only" }],
    });
    await flushSync();

    render(
      <ReferenceList
        entries={client.getUnlinkedReferences(target)}
        client={client}
        onOpenPage={vi.fn()}
        unlinkedPageId={target}
      />,
    );
    expect(document.querySelector(".nt-ref-verb")).toBeNull();
  });
});
