/**
 * Forward path section tests (jsdom; SCHEMA.md "System sections"
 * lazy-loading contract): the page-level "Forward path" section — the
 * derived directed walk over the node's consumer edges (embedded-in →
 * synthesis → plan). Collapsed by default: a collapsed section executes NO
 * read (the spy stays silent) until the first expand; expanding resolves
 * the paths and renders the indented rows (edge-kind labels: embedded in /
 * mentioned in / the typed-link verb); a row click navigates (onOpenNode);
 * an expanded empty walk shows its empty text. The section carries no eager
 * count — the walk IS the read, so nothing queries while collapsed (the
 * unlinked-mentions badge rule: no count the query itself must pay for).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeView } from "../src/ui/App.js";

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

async function createPage(client: WorkspaceClient, title: string): Promise<string> {
  const id = await client.createObject({ isEmbedded: false });
  await client.updateObject(id, { contentAst: [{ type: "text", text: title }] });
  return id;
}

/** Section header button + its containing <section> for within() scoping. */
function section(headerName: RegExp): HTMLElement {
  const header = screen.getByRole("button", { name: headerName });
  return header.closest("section")!;
}

describe("ForwardPathSection", () => {
  it("renders collapsed with NO read until the first expand, then resolves the indented path rows", async () => {
    const client = await seedClient();
    const sourceId = await createPage(client, "Source paper");
    const synthesisId = await createPage(client, "Synthesis Y");
    const planId = await createPage(client, "Plan P");
    // The forward chain: the synthesis embeds the source; the plan
    // verb-marks the synthesis (nearest candidateSpan). Title-is-content:
    // the title text leads the stream, the marks follow.
    await client.updateObject(synthesisId, {
      contentAst: [
        { type: "text", text: "Synthesis Y" },
        { type: "embed_ref", nodeId: sourceId },
      ],
    });
    await client.updateObject(planId, {
      contentAst: [
        { type: "text", text: "Plan P informs " },
        { type: "mention", targetNodeId: synthesisId },
        {
          type: "typed_link",
          verb: "informs",
          text: "informs",
          metadata: { candidateSpans: [synthesisId] },
        },
      ],
    });

    const spy = vi.spyOn(client, "getForwardPaths");
    render(<NodeView client={client} nodeId={sourceId} onOpenNode={() => {}} />);

    const header = screen.getByRole("button", { name: /Forward path/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    // The lazy contract: nothing read the walk while collapsed.
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(spy).toHaveBeenCalledWith(sourceId);

    const sec = section(/Forward path/);
    // First hop: the synthesis, labeled by the embed edge; second hop: the
    // plan, indented under the synthesis, labeled by the verb.
    expect(within(sec).getByRole("button", { name: /Synthesis Y/ })).not.toBeNull();
    expect(within(sec).getByText("embedded in")).not.toBeNull();
    expect(within(sec).getByText("via informs")).not.toBeNull();
    expect(within(sec).getByRole("button", { name: /Plan P/ })).not.toBeNull();
  });

  it("indents each hop deeper than its predecessor", async () => {
    const client = await seedClient();
    const sourceId = await createPage(client, "Idea A");
    const synthId = await createPage(client, "Synth B");
    const planId = await createPage(client, "Plan C");
    await client.updateObject(synthId, {
      contentAst: [
        { type: "text", text: "Synth B" },
        { type: "embed_ref", nodeId: sourceId },
      ],
    });
    await client.updateObject(planId, {
      contentAst: [
        { type: "text", text: "Plan C shapes " },
        { type: "mention", targetNodeId: synthId },
        {
          type: "typed_link",
          verb: "shapes",
          text: "shapes",
          metadata: { candidateSpans: [synthId] },
        },
      ],
    });

    render(<NodeView client={client} nodeId={sourceId} onOpenNode={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Forward path/ }));
    const sec = section(/Forward path/);
    const hop1 = within(sec).getByRole("button", { name: /Synth B/ }).closest("li")!;
    const hop2 = within(sec).getByRole("button", { name: /Plan C/ }).closest("li")!;
    expect(hop1.style.paddingInlineStart).toBe("1em");
    expect(hop2.style.paddingInlineStart).toBe("2em");
  });

  it("a row click navigates to the hop node", async () => {
    const client = await seedClient();
    const sourceId = await createPage(client, "Source paper");
    const synthesisId = await createPage(client, "Synthesis Y");
    await client.updateObject(synthesisId, {
      contentAst: [
        { type: "text", text: "Synthesis Y" },
        { type: "embed_ref", nodeId: sourceId },
      ],
    });

    const onOpenNode = vi.fn();
    render(<NodeView client={client} nodeId={sourceId} onOpenNode={onOpenNode} />);
    fireEvent.click(screen.getByRole("button", { name: /Forward path/ }));
    fireEvent.click(within(section(/Forward path/)).getByRole("button", { name: /Synthesis Y/ }));
    expect(onOpenNode).toHaveBeenCalledWith(synthesisId);
  });

  it("an expanded empty walk shows its empty text (never a crash, never a stale list)", async () => {
    const client = await seedClient();
    const lonelyId = await createPage(client, "Lonely idea");

    render(<NodeView client={client} nodeId={lonelyId} onOpenNode={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Forward path/ }));
    expect(within(section(/Forward path/)).getByText("No forward paths.")).not.toBeNull();
  });

  it("a live write re-derives the expanded section", async () => {
    const client = await seedClient();
    const sourceId = await createPage(client, "Source paper");
    render(<NodeView client={client} nodeId={sourceId} onOpenNode={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Forward path/ }));
    expect(within(section(/Forward path/)).getByText("No forward paths.")).not.toBeNull();

    // The synthesis lands while the section is expanded: the walk re-runs.
    const synthesisId = await createPage(client, "Late synthesis");
    await client.updateObject(synthesisId, {
      contentAst: [
        { type: "text", text: "Late synthesis" },
        { type: "embed_ref", nodeId: sourceId },
      ],
    });
    await screen.findByRole("button", { name: /Late synthesis/ });
  });
});
