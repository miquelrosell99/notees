/**
 * Asset annotation tests (SCHEMA.md annotation family): the seeded `highlight`
 * class (…000000000033) is the annotation class — no separate `annotation`
 * class exists in the domain seeds. Asset chips carry a ❝ affordance opening
 * the lazy Annotations section: the highlight-classed objects whose seeded
 * highlight_asset property (…000000000020) links the asset, plus the
 * add-annotation form (quote excerpt, optional page, optional note). Adding
 * an annotation creates the object named by the quote, sets highlight_asset +
 * the seeded provenance property (…000000000019), and authors the note as a
 * child block. jsdom over the in-process WorkspaceClient; the relay is
 * pre-seeded server-style (apps/server/src/seed.ts): asset/source/highlight
 * classes, the attachments + highlightAsset + provenance property schemas,
 * and the highlight class's two binding rows.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, deriveDisplayName } from "@notees/domain";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const DEVICE = "0192a000-0000-7000-8000-000000000003";
const ASSET_CLASS = SYSTEM_CLASS_UUIDS.asset;
const SOURCE_CLASS = SYSTEM_CLASS_UUIDS.source;
const HIGHLIGHT_CLASS = SYSTEM_CLASS_UUIDS.highlight;
const ATTACHMENTS = SYSTEM_PROPERTY_UUIDS.attachments;
const HIGHLIGHT_ASSET = SYSTEM_PROPERTY_UUIDS.highlightAsset;
const PROVENANCE = SYSTEM_PROPERTY_UUIDS.provenance;
const ASSET_ID_A = "0192a000-0000-7000-8000-0000000000a1";
const ASSET_ID_B = "0192a000-0000-7000-8000-0000000000a2";
/** 64 hex chars — the protocol's content-hash shape. */
const HASH_A = "a1".repeat(32);
const HASH_B = "b2".repeat(32);

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

/** The server-style seed ops the relay holds before the client bootstraps. */
function seedEnvelope(opType: string, payload: Record<string, unknown>, affected: string[]): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: DEVICE,
    client: "seed",
    hlc: { physical: 1, logical: 0 },
    affectedNodeIds: affected,
    opType,
    payload,
  });
}

function seedRelay(): MemoryRelay {
  const relay = new MemoryRelay();
  relay.ingest([
    seedEnvelope("class.create", { classId: ASSET_CLASS, contentAst: [{ type: "text", text: "asset" }], icon: "mdiPaperclip" }, [ASSET_CLASS]),
    seedEnvelope("class.create", { classId: SOURCE_CLASS, contentAst: [{ type: "text", text: "source" }], icon: "mdiBookshelf" }, [SOURCE_CLASS]),
    seedEnvelope(
      "class.create",
      { classId: HIGHLIGHT_CLASS, contentAst: [{ type: "text", text: "highlight" }], icon: "mdiFormatHighlight" },
      [HIGHLIGHT_CLASS],
    ),
    seedEnvelope(
      "propertySchema.create",
      {
        propertySchemaId: ATTACHMENTS,
        name: "attachments",
        type: "object",
        multi: true,
        scope: "class",
        targetClassFilter: [ASSET_CLASS],
      },
      [],
    ),
    // The annotation link + provenance, bound to the highlight class (the
    // server seed emits a schema AND a class_property row per system spec).
    seedEnvelope(
      "propertySchema.create",
      {
        propertySchemaId: HIGHLIGHT_ASSET,
        name: "highlightAsset",
        type: "object",
        multi: false,
        scope: "class",
        targetClassFilter: [ASSET_CLASS],
      },
      [],
    ),
    seedEnvelope(
      "class.property.set",
      { classId: HIGHLIGHT_CLASS, propertySchemaId: HIGHLIGHT_ASSET, sequence: 0 },
      [HIGHLIGHT_CLASS],
    ),
    seedEnvelope(
      "propertySchema.create",
      {
        propertySchemaId: PROVENANCE,
        name: "provenance",
        type: "text",
        multi: false,
        scope: "class",
      },
      [],
    ),
    seedEnvelope(
      "class.property.set",
      { classId: HIGHLIGHT_CLASS, propertySchemaId: PROVENANCE, sequence: 1 },
      [HIGHLIGHT_CLASS],
    ),
  ]);
  return relay;
}

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(seedRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

async function createSource(client: WorkspaceClient, name: string): Promise<string> {
  const id = await client.createObject({ nodeType: "page", name });
  await client.assignClass(id, SOURCE_CLASS);
  return id;
}

/** An asset node carrying node_asset metadata: the chip label + annotate affordance. */
async function makeAsset(client: WorkspaceClient, originalName: string): Promise<string> {
  const id = await client.createObject({ nodeType: "page", name: `${originalName} node`, classIds: [ASSET_CLASS] });
  await client.attachAsset(id, {
    assetId: originalName === "a.pdf" ? ASSET_ID_A : ASSET_ID_B,
    hash: originalName === "a.pdf" ? HASH_A : HASH_B,
    mimeType: "application/pdf",
    size: 1,
    originalName,
  });
  return id;
}

/** Expand the page's "Properties N" section (collapsed by default in the note layout). */
function expandProperties(): void {
  const header = screen.queryByRole("button", { name: /^Properties / });
  if (header !== null && header.getAttribute("aria-expanded") === "false") {
    fireEvent.click(header);
  }
}

/** The annotations section (header button + its containing <section>). */
function annotationSection(): HTMLElement {
  expandProperties();
  const header = screen.getByRole("button", { name: /^Annotations$/ });
  return header.closest("section")!;
}

/** Enter edit mode on the nth block (document order) and return its editor. */
function clickIntoBlock(container: HTMLElement, index: number): HTMLElement {
  const contents = container.querySelectorAll<HTMLElement>(".nt-block-content");
  const target = contents[index];
  if (target === undefined) throw new Error(`no .nt-block-content at index ${index}`);
  fireEvent.click(target);
  const editor = target.querySelector<HTMLElement>(".nt-block-text");
  if (editor === null) throw new Error("editor did not mount after click");
  return editor;
}

/** Emulate typing/browsers mutating the contentEditable DOM + input event. */
function typeInto(editor: HTMLElement, text: string): void {
  editor.textContent = text;
  fireEvent.input(editor);
}

describe("Asset annotations (highlight class)", () => {
  it("adding an annotation creates the highlight-classed object, the asset link, provenance, and the note block", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const assetNodeId = await makeAsset(client, "paper.pdf");
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: assetNodeId }, 0);

    render(<PageView client={client} pageId={sourceId} />);
    expandProperties();
    fireEvent.click(screen.getByRole("button", { name: "Annotate paper.pdf" }));
    fireEvent.change(screen.getByLabelText("Quote"), { target: { value: "the missing chapter" } });
    fireEvent.change(screen.getByLabelText("Page"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: "verify against the manuscript" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add annotation" }));
    await flushWrites();

    // The read model: one highlight-classed annotation, titled by the quote.
    const annotations = client.getAnnotationsForAsset(assetNodeId);
    expect(annotations).toHaveLength(1);
    const annotation = annotations[0]!;
    expect(annotation.classIds).toContain(HIGHLIGHT_CLASS);
    expect(deriveDisplayName(annotation)).toBe("the missing chapter");

    // Authored property rows: the asset link + the provenance text.
    const effective = client.getEffectiveProperties(annotation.id);
    const link = effective.find((row) => row.propertySchemaId === HIGHLIGHT_ASSET);
    expect(link?.source).toBe("authored");
    expect(link?.boundBy).toBe(HIGHLIGHT_CLASS);
    expect(link?.value).toEqual({ nodeId: assetNodeId });
    const provenance = effective.find((row) => row.propertySchemaId === PROVENANCE);
    expect(provenance?.source).toBe("authored");
    expect(provenance?.value).toBe("web · p. 12");

    // The note is a child block of the annotation page.
    const children = client.getChildren(annotation.id);
    expect(children).toHaveLength(1);
    expect(children[0]!.contentAst).toEqual([
      { type: "text", text: "verify against the manuscript" },
    ]);

    // The expanded section picked the new annotation up (notification re-query).
    within(annotationSection()).getByText("the missing chapter");
  });

  it("the annotations section is lazy: no query until the affordance opens it", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const assetNodeId = await makeAsset(client, "paper.pdf");
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: assetNodeId }, 0);
    await client.createAnnotation({ assetId: assetNodeId, quote: "a quiet quote" });

    const spy = vi.spyOn(client, "getAnnotationsForAsset");
    render(<PageView client={client} pageId={sourceId} />);
    expandProperties();

    // Collapsed (not even mounted): the read never runs.
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Annotate paper.pdf" }));
    expect(spy).toHaveBeenCalledTimes(1);
    within(annotationSection()).getByText("a quiet quote");
  });

  it("the list shows the annotation with its quote excerpt and page context", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const assetNodeId = await makeAsset(client, "paper.pdf");
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: assetNodeId }, 0);
    await client.createAnnotation({ assetId: assetNodeId, quote: "the missing chapter", page: "12" });

    render(<PageView client={client} pageId={sourceId} />);
    expandProperties();
    fireEvent.click(screen.getByRole("button", { name: "Annotate paper.pdf" }));

    const row = within(annotationSection())
      .getByText("the missing chapter")
      .closest("button")!;
    expect(row.textContent).toContain("web · p. 12");
  });

  it("clicking an annotation row jumps to the annotation object", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const assetNodeId = await makeAsset(client, "paper.pdf");
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: assetNodeId }, 0);
    const annotationId = await client.createAnnotation({
      assetId: assetNodeId,
      quote: "jump target quote",
    });

    const onOpenPage = vi.fn();
    render(<PageView client={client} pageId={sourceId} onOpenPage={onOpenPage} />);
    expandProperties();
    fireEvent.click(screen.getByRole("button", { name: "Annotate paper.pdf" }));

    fireEvent.click(within(annotationSection()).getByText("jump target quote").closest("button")!);
    expect(onOpenPage).toHaveBeenCalledWith(annotationId);
  });

  it("the annotation note is an editable child block in the annotation's page view", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const assetNodeId = await makeAsset(client, "paper.pdf");
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: assetNodeId }, 0);
    const annotationId = await client.createAnnotation({
      assetId: assetNodeId,
      quote: "annotated quote",
      note: "first draft",
    });
    const blockId = client.getChildren(annotationId)[0]!.id;

    // The annotation opens as an ordinary page; the outliner renders the note.
    const { container } = render(<PageView client={client} pageId={annotationId} />);
    expandProperties();
    const editor = clickIntoBlock(container, 0);
    typeInto(editor, "revised note");
    fireEvent.blur(editor);

    expect(client.getNode(blockId)?.contentAst).toEqual([{ type: "text", text: "revised note" }]);
  });

  it("removing the highlight class from the annotation keeps the authored properties (design law)", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const assetNodeId = await makeAsset(client, "paper.pdf");
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: assetNodeId }, 0);
    const annotationId = await client.createAnnotation({
      assetId: assetNodeId,
      quote: "surviving quote",
      page: "3",
    });

    // Sanity: bound authored rows while the class membership stands.
    const before = client.getEffectiveProperties(annotationId);
    expect(before.map((row) => [row.propertySchemaId, row.source, row.boundBy])).toEqual([
      [HIGHLIGHT_ASSET, "authored", HIGHLIGHT_CLASS],
      [PROVENANCE, "authored", HIGHLIGHT_CLASS],
    ]);

    // The M1 protocol has no class.remove op (membership is add-only via the
    // object.create re-issue); simulate the membership removal at the store
    // level — exactly the rows a future removal op's applier will write.
    client.store.database
      .prepare("DELETE FROM class_member_set WHERE node_id = ? AND class_id = ?")
      .run(annotationId, HIGHLIGHT_CLASS);
    client.store.database
      .prepare("UPDATE node SET class_ids = ? WHERE id = ?")
      .run("[]", annotationId);

    // Authored values survive — now unbound (no current class binds them).
    const after = client.getEffectiveProperties(annotationId);
    expect(after.map((row) => [row.propertySchemaId, row.source, row.boundBy])).toEqual([
      [HIGHLIGHT_ASSET, "authored", null],
      [PROVENANCE, "authored", null],
    ]);
    // The class-derived affordance is gone; the authored link itself survives.
    expect(client.getAnnotationsForAsset(assetNodeId)).toEqual([]);

    // The annotation's page view marks the surviving rows "unbound".
    render(<PageView client={client} pageId={annotationId} />);
    expandProperties();
    expect(screen.getAllByText("unbound")).toHaveLength(2);
  });

  it("page and note are optional: provenance records the bare origin, no note means no child block", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const assetNodeId = await makeAsset(client, "paper.pdf");
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: assetNodeId }, 0);

    const annotationId = await client.createAnnotation({
      assetId: assetNodeId,
      quote: "bare quote",
    });

    const provenance = client
      .getEffectiveProperties(annotationId)
      .find((row) => row.propertySchemaId === PROVENANCE);
    expect(provenance?.value).toBe("web");
    expect(client.getChildren(annotationId)).toEqual([]);
  });

  it("annotations are scoped per asset: another asset's section stays empty", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const assetNodeA = await makeAsset(client, "a.pdf");
    const assetNodeB = await makeAsset(client, "b.pdf");
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: assetNodeA }, 0);
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: assetNodeB }, 1);
    await client.createAnnotation({ assetId: assetNodeA, quote: "only on A", page: "7" });

    render(<PageView client={client} pageId={sourceId} />);
    expandProperties();

    // The un-annotated asset: empty state, the form still reachable.
    fireEvent.click(screen.getByRole("button", { name: "Annotate b.pdf" }));
    within(annotationSection()).getByText("No annotations yet.");
    expect(within(annotationSection()).queryByText("only on A")).toBeNull();

    // The annotated asset: opening its affordance replaces the section (one
    // open annotations section per chips row) and shows quote + page.
    fireEvent.click(screen.getByRole("button", { name: "Annotate a.pdf" }));
    const row = within(annotationSection()).getByText("only on A").closest("button")!;
    expect(row.textContent).toContain("web · p. 7");
  });
});
