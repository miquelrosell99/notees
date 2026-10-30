/**
 * The synthesis-evidence lint (research-tier2 slice 4) — a SUGGESTION-ONLY
 * dashed hint in the page header: a `synthesis`-classed page whose embedded
 * evidence set is empty or single-source gets a quiet nudge, never
 * enforcement.
 *
 * Evidence semantics (Review Focus #4): DISTINCT source-family targets of
 * `embed_ref` tokens in the page's SUBTREE — containment-aware (an embed of
 * a note block whose nearest source-family ancestor is a source counts as
 * evidence OF that source; the extends-aware source-family check walks
 * class parents, the sourcesQuery idiom). The edge table's `is_embedded`
 * sees no embeds (embeds ride content ASTs), so `mention` tokens with the
 * per-link `isEmbedded` transclusion flag are a SECONDARY signal only.
 *
 * Real WorkspaceClient over MemoryRelay + sql.js (the workflows/
 * add-source convention); the header renders through jsdom with the
 * ResizeObserver stub.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import type { ContentAst } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, workflowEntityId } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeView } from "../src/ui/NodeView.js";
import {
  evidenceReadsOf,
  synthesisEvidenceCount,
  synthesisEvidenceOf,
} from "../src/features/research-lint/evidence.js";

const WS = "0192a000-0000-7000-8000-0000000000f1";
const ACTOR = "0192a000-0000-7000-8000-0000000000f2";

/** Task 2's derived id — the deterministic synthesis class. */
const SYNTHESIS_ID = workflowEntityId("research", "class", "synthesis");

const NO_EVIDENCE_MESSAGE =
  "No embedded evidence — embed the source notes this synthesis rests on.";
const SINGLE_SOURCE_MESSAGE =
  "Single source — embed a second, contrasting source so the claim is tested.";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

/** Flush the microtasks an async client write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  // The source family the extends-aware check walks: book extends source;
  // the synthesis class is the workflow-materialized class (Task 2's id).
  await client.createClass("Synthesis", { id: SYNTHESIS_ID });
  await client.createClass("source", { id: SYSTEM_CLASS_UUIDS.source });
  await client.createClass("book", { id: SYSTEM_CLASS_UUIDS.book });
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.book, [SYSTEM_CLASS_UUIDS.source]);
  await flushWrites();
  return client;
}

const text = (s: string): ContentAst => [{ type: "text", text: s }];

/** A standalone source node (book-classed — source-family via extends, not directly). */
async function createBook(client: WorkspaceClient, title: string): Promise<string> {
  const id = await client.createObject({
    name: title,
    classIds: [SYSTEM_CLASS_UUIDS.book],
    isEmbedded: false,
  });
  await flushWrites();
  return id;
}

/** A synthesis-classed standalone page. */
async function createSynthesis(client: WorkspaceClient, title: string): Promise<string> {
  const id = await client.createObject({
    name: title,
    classIds: [SYNTHESIS_ID],
    isEmbedded: false,
  });
  await flushWrites();
  return id;
}

/** A block in the page's body carrying the given content AST. */
async function addBlock(client: WorkspaceClient, pageId: string, ast: ContentAst): Promise<string> {
  const id = await client.createObject({ parentId: pageId, contentAst: ast });
  await flushWrites();
  return id;
}

/** Render the page the way the app does — NodeView owns the header chrome. */
function renderPage(client: WorkspaceClient, pageId: string) {
  return render(<NodeView client={client} nodeId={pageId} onOpenNode={vi.fn()} cornerMenu />);
}

function lintRow(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".lint-hint-row");
}

// --- the evidence-counting contract -------------------------------------------

describe("synthesisEvidenceOf — counting both directions", () => {
  it("an embed_ref counts with NO is_embedded mention links at all (the edge table sees no embeds)", async () => {
    const client = await seedClient();
    const book = await createBook(client, "Book A");
    const synthesis = await createSynthesis(client, "Claim");
    await addBlock(client, synthesis, [
      { type: "text", text: "As shown in " },
      { type: "embed_ref", nodeId: book },
    ]);

    expect(await synthesisEvidenceOf(evidenceReadsOf(client), synthesis)).toBe(1);
    expect(synthesisEvidenceCount(client, synthesis)).toBe(1);
  });

  it("an is_embedded mention alone counts as SECONDARY evidence; a plain mention does not", async () => {
    const client = await seedClient();
    const book = await createBook(client, "Book A");
    const plain = await createSynthesis(client, "Plain mention");
    await addBlock(client, plain, [{ type: "mention", targetNodeId: book }]);
    expect(await synthesisEvidenceOf(evidenceReadsOf(client), plain)).toBe(0);

    const embedded = await createSynthesis(client, "Transcluded mention");
    await addBlock(client, embedded, [
      { type: "mention", targetNodeId: book, isEmbedded: true },
    ]);
    expect(await synthesisEvidenceOf(evidenceReadsOf(client), embedded)).toBe(1);
  });

  it("an embed of a note block resolves to its nearest source ancestor (containment-aware)", async () => {
    const client = await seedClient();
    const book = await createBook(client, "Book A");
    // A note block living INSIDE the source's subtree.
    const note = await addBlock(client, book, text("a key passage"));

    const synthesis = await createSynthesis(client, "Claim");
    await addBlock(client, synthesis, [
      { type: "text", text: "see " },
      { type: "embed_ref", nodeId: note },
    ]);
    expect(await synthesisEvidenceOf(evidenceReadsOf(client), synthesis)).toBe(1);
  });

  it("distinctness: the same source reached twice (embed + note embed) counts once; two sources count two", async () => {
    const client = await seedClient();
    const bookA = await createBook(client, "Book A");
    const bookB = await createBook(client, "Book B");
    const noteInA = await addBlock(client, bookA, text("a passage"));

    const synthesis = await createSynthesis(client, "Claim");
    await addBlock(client, synthesis, [
      { type: "embed_ref", nodeId: bookA },
      { type: "embed_ref", nodeId: noteInA },
      { type: "mention", targetNodeId: bookB, isEmbedded: true },
    ]);
    expect(await synthesisEvidenceOf(evidenceReadsOf(client), synthesis)).toBe(2);
  });

  it("extends-aware: a user class extending source is source-family", async () => {
    const client = await seedClient();
    const paperId = "0192a000-0000-7000-8000-0000000000f3";
    await client.createClass("paper", { id: paperId });
    await client.setClassExtends(paperId, [SYSTEM_CLASS_UUIDS.source]);
    const paper = await client.createObject({
      name: "Preprint P",
      classIds: [paperId],
      isEmbedded: false,
    });
    await flushWrites();

    const synthesis = await createSynthesis(client, "Claim");
    await addBlock(client, synthesis, [{ type: "embed_ref", nodeId: paper }]);
    expect(await synthesisEvidenceOf(evidenceReadsOf(client), synthesis)).toBe(1);
  });

  it("an embed of an orphan note (no source ancestor) is not evidence", async () => {
    const client = await seedClient();
    const pad = await createSynthesis(client, "scratch pad");
    const note = await addBlock(client, pad, text("loose note"));

    const synthesis = await createSynthesis(client, "Claim");
    await addBlock(client, synthesis, [{ type: "embed_ref", nodeId: note }]);
    expect(await synthesisEvidenceOf(evidenceReadsOf(client), synthesis)).toBe(0);
  });

  it("the pure interface honors the reads contract (mocked reads, no client)", async () => {
    const sourceX = "0192a000-0000-7000-8000-0000000000e9";
    const reads = {
      subtreeContentAst: async () =>
        new Map<string, ContentAst>([
          [
            "n1",
            [
              { type: "embed_ref", nodeId: "orphan-note" },
              { type: "mention", targetNodeId: "m1", isEmbedded: true },
              { type: "mention", targetNodeId: "m2" },
            ],
          ],
        ]),
      nearestSourceAncestorId: async (nodeId: string) =>
        nodeId === "m1" ? sourceX : null,
    };
    expect(await synthesisEvidenceOf(reads, "root")).toBe(1);
  });
});

// --- the lint in the page header ------------------------------------------------

describe("the synthesis lint in the page header", () => {
  it("the 0-arm: a synthesis page with no embedded evidence shows the dashed hint", async () => {
    const client = await seedClient();
    const synthesis = await createSynthesis(client, "The claim");

    const { container } = renderPage(client, synthesis);
    const row = lintRow(container);
    expect(row).not.toBeNull();
    expect(row!.getAttribute("role")).toBe("status");
    expect(within(row as HTMLElement).getByText(NO_EVIDENCE_MESSAGE)).toBeInTheDocument();
  });

  it("the 1-arm: exactly one source shows the single-source hint (the removal test)", async () => {
    const client = await seedClient();
    const book = await createBook(client, "Book A");
    const synthesis = await createSynthesis(client, "The claim");
    await addBlock(client, synthesis, [{ type: "embed_ref", nodeId: book }]);

    const { container } = renderPage(client, synthesis);
    const row = lintRow(container);
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(SINGLE_SOURCE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(NO_EVIDENCE_MESSAGE)).toBeNull();
  });

  it("two or more sources: the hint retires (the evidence set stands on its own)", async () => {
    const client = await seedClient();
    const bookA = await createBook(client, "Book A");
    const bookB = await createBook(client, "Book B");
    const synthesis = await createSynthesis(client, "The claim");
    await addBlock(client, synthesis, [
      { type: "embed_ref", nodeId: bookA },
      { type: "embed_ref", nodeId: bookB },
    ]);

    const { container } = renderPage(client, synthesis);
    expect(lintRow(container)).toBeNull();
  });

  it("hidden on non-synthesis nodes — a plain page with no evidence grows no lint", async () => {
    const client = await seedClient();
    const plain = await client.createObject({ name: "Ordinary page", isEmbedded: false });
    await flushWrites();

    const { container } = renderPage(client, plain);
    expect(lintRow(container)).toBeNull();
    expect(screen.queryByText(NO_EVIDENCE_MESSAGE)).toBeNull();
    expect(screen.queryByText(SINGLE_SOURCE_MESSAGE)).toBeNull();
  });

  it("suggestion-only: the lint renders read-only — no client write method fires, no button in the row", async () => {
    const client = await seedClient();
    const synthesis = await createSynthesis(client, "The claim");
    // The spies install AFTER the fixture writes — only the render may call.
    const createObject = vi.spyOn(client, "createObject");
    const updateObject = vi.spyOn(client, "updateObject");
    const setProperty = vi.spyOn(client, "setProperty");
    const assignClass = vi.spyOn(client, "assignClass");

    const { container } = renderPage(client, synthesis);
    await flushWrites();

    const row = lintRow(container);
    expect(row).not.toBeNull();
    expect(row!.querySelector("button")).toBeNull();
    for (const spy of [createObject, updateObject, setProperty, assignClass]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
