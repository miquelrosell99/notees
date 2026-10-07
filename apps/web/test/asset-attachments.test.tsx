/**
 * Asset attachment UX tests (Zotero-style source containers): the properties
 * panel renders the `asset`-typed attachments property as the dedicated row
 * chrome — a list of the linked assets (thumbnail + file name + remove) with
 * the Upload / Link authoring buttons. Upload runs the AssetUploadModal
 * (drag-drop + paste + preview + progress; the CAS path POSTs to
 * /api/assets → asset node + asset.attach + property.set); Link opens the
 * node picker scoped to asset-classed nodes with create disabled. Names
 * resolve via the derived node_asset rows; downloads ride GET
 * /api/assets/:id (workspace API key header, blob URL so the key never
 * lands in a URL). jsdom over the in-process WorkspaceClient with a stubbed
 * fetch.
 *
 * The relay is pre-seeded with the server-style seed ops (apps/server/src/
 * seed.ts): the fixed-UUID asset + source classes and the attachments
 * property schema (…000000000011, the `asset` type since the type landed —
 * the filter is implicit in the type, no explicit targetClassFilter) — so
 * the pulled store matches what a real workspace bootstrap delivers.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, deriveDisplayName } from "@notees/domain";
import { newEnvelope, type Envelope } from "@notees/protocol";
import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const DEVICE = "0192a000-0000-7000-8000-000000000003";
const SERVER = "https://notees.test";
const API_KEY = "test-api-key";
const ASSET_CLASS = SYSTEM_CLASS_UUIDS.asset;
const SOURCE_CLASS = SYSTEM_CLASS_UUIDS.source;
const ATTACHMENTS = SYSTEM_PROPERTY_UUIDS.attachments;
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
  vi.unstubAllGlobals();
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
      "propertySchema.create",
      {
        propertySchemaId: ATTACHMENTS,
        name: "attachments",
        type: "asset",
        multi: true,
        scope: "class",
      },
      [],
    ),
  ]);
  return relay;
}

async function seedClient(options?: { rest?: boolean }): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(seedRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
    ...(options?.rest === true ? { serverUrl: SERVER, apiKey: API_KEY } : {}),
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
  const id = await client.createObject({ presentAsMain: true, name });
  await client.assignClass(id, SOURCE_CLASS);
  return id;
}

/** Expand the page's "Properties N" section (collapsed by default in the note layout). */
function expandProperties(): void {
  const header = screen.queryByRole("button", { name: /^Properties / });
  if (header !== null && header.getAttribute("aria-expanded") === "false") {
    fireEvent.click(header);
  }
}

/** The attachments row in the panel (the dedicated asset row). */
function attachmentsRow(): HTMLElement {
  expandProperties();
  return screen.getByText("attachments").closest(".nt-props-sidebar__prop, .nt-property-asset") as HTMLElement;
}

/** Stub fetch: upload POSTs answer with `body`, download GETs with bytes. */
function stubFetch(body: Record<string, unknown> = uploadBody()) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url) === `${SERVER}/api/assets`) {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("file-bytes", { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

function uploadBody(overrides: Record<string, unknown> = {}) {
  return {
    assetId: ASSET_ID_A,
    hash: HASH_A,
    mimeType: "application/pdf",
    size: 5,
    originalName: "paper.pdf",
    ...overrides,
  };
}

async function attachFile(
  client: WorkspaceClient,
  nodeId: string,
  asset: { assetId: string; hash: string; originalName: string },
): Promise<void> {
  await client.attachAsset(nodeId, {
    assetId: asset.assetId,
    hash: asset.hash,
    mimeType: "application/pdf",
    size: 1,
    originalName: asset.originalName,
  });
}

describe("Asset attachments (the asset property row)", () => {
  it("shows the bound attachments row for a source with no attachments yet — the Upload and Link buttons, no generic Add pill", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");

    render(<PageView client={client} pageId={sourceId} />);
    const row = attachmentsRow();
    expect(row.textContent).toContain("attachments");
    // No values: no "default" hint, both authoring buttons reachable.
    expect(row.textContent).not.toContain("default");
    expect(within(row).getByRole("button", { name: "Upload" })).not.toBeNull();
    expect(within(row).getByRole("button", { name: "Link" })).not.toBeNull();
    expect(within(row).queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("Link opens the picker filtered to the asset class, with create disabled", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    await client.createObject({ presentAsMain: true, name: "scan.pdf", classIds: [ASSET_CLASS] });
    await client.createObject({ presentAsMain: true, name: "Random notes" });

    render(<PageView client={client} pageId={sourceId} />);
    fireEvent.click(within(attachmentsRow()).getByRole("button", { name: "Link" }));

    // Only asset-class nodes are candidates; the plain page is filtered out.
    expect(screen.getByText("scan.pdf")).not.toBeNull();
    expect(screen.queryByText("Random notes")).toBeNull();
    // Create is disabled: a query offers no create row (and no upload row).
    fireEvent.change(screen.getByLabelText("Search attachments"), { target: { value: "scan" } });
    expect(screen.getByText("scan.pdf")).not.toBeNull();
    expect(screen.queryByText(/Create/)).toBeNull();
    expect(screen.queryByText("Upload file…")).toBeNull();
  });

  it("picker search narrows candidates by name within the asset class", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    await client.createObject({ presentAsMain: true, name: "chapter-one.pdf", classIds: [ASSET_CLASS] });
    await client.createObject({ presentAsMain: true, name: "cover.png", classIds: [ASSET_CLASS] });

    render(<PageView client={client} pageId={sourceId} />);
    fireEvent.click(within(attachmentsRow()).getByRole("button", { name: "Link" }));
    fireEvent.change(screen.getByLabelText("Search attachments"), { target: { value: "cover" } });

    expect(screen.getByText("cover.png")).not.toBeNull();
    expect(screen.queryByText("chapter-one.pdf")).toBeNull();
  });

  it("picking an asset from Link writes the property value", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    // The picker searches node names — the asset node is named by its file.
    const assetId = await client.createObject({ presentAsMain: true, name: "scan.pdf", classIds: [ASSET_CLASS] });
    await attachFile(client, assetId, { assetId: ASSET_ID_A, hash: HASH_A, originalName: "scan.pdf" });

    render(<PageView client={client} pageId={sourceId} />);
    fireEvent.click(within(attachmentsRow()).getByRole("button", { name: "Link" }));
    fireEvent.change(screen.getByLabelText("Search attachments"), { target: { value: "scan" } });
    await flushWrites();
    fireEvent.click(
      document.querySelector(
        ".node-result-item:not(.node-result-item--create):not(.node-result-item--date)",
      )!,
    );
    await flushWrites();

    const effective = client.getEffectiveProperties(sourceId);
    expect(effective).toHaveLength(1);
    expect(effective[0]!.propertySchemaId).toBe(ATTACHMENTS);
    expect(effective[0]!.value).toEqual({ nodeId: assetId });
  });

  it("uploading a file POSTs to the asset store and links the new asset", async () => {
    const client = await seedClient({ rest: true });
    const sourceId = await createSource(client, "The Book");
    const calls = stubFetch();

    render(<PageView client={client} pageId={sourceId} />);
    // The Upload button opens the AssetUploadModal directly (drag-drop +
    // preview + progress).
    fireEvent.click(within(attachmentsRow()).getByRole("button", { name: "Upload" }));
    const dialog = await screen.findByRole("dialog", { name: /upload file/i });
    const file = new File(["hello"], "paper.pdf", { type: "application/pdf" });
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    await within(dialog).findAllByText("paper.pdf");
    fireEvent.click(within(dialog).getByRole("button", { name: /upload/i }));
    await flushWrites();

    // The list row lands with the server-returned original name.
    await screen.findByRole("button", { name: "paper.pdf" });

    // The upload hit the server with the workspace API key, multipart body.
    // (The page-header star's prefs GET also passes this stub — count only
    // the asset call.)
    const assetCalls = calls.filter((call) => call.url === `${SERVER}/api/assets`);
    expect(assetCalls).toHaveLength(1);
    expect(assetCalls[0]!.init.method).toBe("POST");
    const headers = assetCalls[0]!.init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe(API_KEY);
    expect(headers["X-Workspace-Id"]).toBe(WS);
    expect(assetCalls[0]!.init.body).toBeInstanceOf(FormData);

    // The property value list links the new asset node (authored row).
    const effective = client.getEffectiveProperties(sourceId);
    expect(effective).toHaveLength(1);
    const row = effective[0]!;
    expect(row.propertySchemaId).toBe(ATTACHMENTS);
    expect(row.source).toBe("authored");
    const assetNodeId = (row.value as { nodeId: string }).nodeId;

    // The asset node carries the asset class + file name as its title content;
    // node_asset ties it to the content-addressed bytes (the row's
    // name/download read).
    const assetNode = client.getNode(assetNodeId)!;
    expect(assetNode.classIds).toContain(ASSET_CLASS);
    expect(deriveDisplayName(assetNode)).toBe("paper.pdf");
    expect(client.getAssetInfo(assetNodeId)).toEqual(
      expect.objectContaining({ assetId: ASSET_ID_A, originalName: "paper.pdf", size: 5 }),
    );
  });

  it("a failed upload surfaces an error and links nothing", async () => {
    const client = await seedClient({ rest: true });
    const sourceId = await createSource(client, "The Book");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    render(<PageView client={client} pageId={sourceId} />);
    fireEvent.click(within(attachmentsRow()).getByRole("button", { name: "Upload" }));
    const dialog = await screen.findByRole("dialog", { name: /upload file/i });
    const file = new File(["hello"], "paper.pdf", { type: "application/pdf" });
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    await within(dialog).findAllByText("paper.pdf");
    fireEvent.click(within(dialog).getByRole("button", { name: /upload/i }));

    // The modal keeps the file selected and surfaces the server's message.
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("500");
    expect(client.getEffectiveProperties(sourceId)).toEqual([]);
  });

  it("an unacceptable file is rejected with a named error before any upload", async () => {
    const client = await seedClient({ rest: true });
    const sourceId = await createSource(client, "The Book");
    stubFetch();
    const upload = vi.spyOn(client, "uploadAsset");

    render(<PageView client={client} pageId={sourceId} />);
    fireEvent.click(within(attachmentsRow()).getByRole("button", { name: "Upload" }));
    const dialog = await screen.findByRole("dialog", { name: /upload file/i });
    const file = new File(["MZ"], "program.exe", { type: "application/x-msdownload" });
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("not an accepted type");
    expect(upload).not.toHaveBeenCalled();
    expect(client.getEffectiveProperties(sourceId)).toEqual([]);
  });

  it("a pasted file fills the upload modal (the clipboard path)", async () => {
    const client = await seedClient({ rest: true });
    const sourceId = await createSource(client, "The Book");
    stubFetch();

    render(<PageView client={client} pageId={sourceId} />);
    fireEvent.click(within(attachmentsRow()).getByRole("button", { name: "Upload" }));
    const dialog = await screen.findByRole("dialog", { name: /upload file/i });
    const file = new File(["hello"], "pasted.pdf", { type: "application/pdf" });
    fireEvent.paste(document.body, { clipboardData: { files: [file] } });
    await within(dialog).findAllByText("pasted.pdf");
  });

  it("item removal unlinks the slot (property.unset per idx)", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const nodeA = await client.createObject({ presentAsMain: true, name: "Asset node A", classIds: [ASSET_CLASS] });
    const nodeB = await client.createObject({ presentAsMain: true, name: "Asset node B", classIds: [ASSET_CLASS] });
    await attachFile(client, nodeA, { assetId: ASSET_ID_A, hash: HASH_A, originalName: "a.pdf" });
    await attachFile(client, nodeB, { assetId: ASSET_ID_B, hash: HASH_B, originalName: "b.pdf" });
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: nodeA }, 0);
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: nodeB }, 1);

    render(<PageView client={client} pageId={sourceId} />);
    const row = attachmentsRow();
    expect(screen.getByRole("button", { name: "a.pdf" })).not.toBeNull();
    fireEvent.click(within(row).getByLabelText("Remove a.pdf"));
    await flushWrites();

    // Only the second link survives — the multi-value list was rewritten.
    const refs = client
      .getEffectiveProperties(sourceId)
      .map((r) => (r.value as { nodeId: string }).nodeId);
    expect(refs).toEqual([nodeB]);
    expect(screen.queryByText("a.pdf")).toBeNull();
    expect(screen.getByRole("button", { name: "b.pdf" })).not.toBeNull();
  });

  it("attachment rows render the asset's original name from node_asset, not the node name", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const assetNode = await client.createObject({ presentAsMain: true, name: "Asset node", classIds: [ASSET_CLASS] });
    await attachFile(client, assetNode, {
      assetId: ASSET_ID_A,
      hash: HASH_A,
      originalName: "Chapter 1 — scan.pdf",
    });
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: assetNode }, 0);

    const { container } = render(<PageView client={client} pageId={sourceId} />);
    // The row resolves through the node_asset row, so the file name (not the
    // generic node name, and never a bare UUID) is what the user shows.
    expect(screen.getByRole("button", { name: "Chapter 1 — scan.pdf" })).not.toBeNull();
    expect(container.textContent).not.toContain(assetNode);
  });

  it("clicking an attachment row downloads it via the server asset URL", async () => {
    const client = await seedClient({ rest: true });
    const sourceId = await createSource(client, "The Book");
    const assetNode = await client.createObject({ presentAsMain: true, name: "Asset node", classIds: [ASSET_CLASS] });
    await attachFile(client, assetNode, { assetId: ASSET_ID_A, hash: HASH_A, originalName: "a.pdf" });
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: assetNode }, 0);
    const calls = stubFetch();
    const opened: string[] = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: (blob: Blob) => {
        void blob;
        return "blob:notees-test";
      },
      revokeObjectURL: () => {},
    });
    vi.spyOn(window, "open").mockImplementation(((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open);

    render(<PageView client={client} pageId={sourceId} />);
    fireEvent.click(screen.getByRole("button", { name: "a.pdf" }));

    await waitFor(() => expect(opened).toEqual(["blob:notees-test"]));
    const download = calls.find((c) => c.url === `${SERVER}/api/assets/${ASSET_ID_A}`);
    expect(download).toBeDefined();
    expect((download!.init.headers as Record<string, string>)["X-API-Key"]).toBe(API_KEY);
  });

  it("a source with attachments round-trips through effective properties", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const nodeA = await client.createObject({ presentAsMain: true, name: "Asset node A", classIds: [ASSET_CLASS] });
    const nodeB = await client.createObject({ presentAsMain: true, name: "Asset node B", classIds: [ASSET_CLASS] });
    await attachFile(client, nodeA, { assetId: ASSET_ID_A, hash: HASH_A, originalName: "front.pdf" });
    await attachFile(client, nodeB, { assetId: ASSET_ID_B, hash: HASH_B, originalName: "back.pdf" });
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: nodeA }, 0);
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: nodeB }, 1);

    // The read model reflects the writes: per-slot authored rows in idx
    // order. (boundBy stays null — the seed emits property schemas but no
    // class_property binding rows, same as a real server bootstrap.)
    const effective = client.getEffectiveProperties(sourceId);
    expect(effective.map((r) => [r.propertySchemaId, r.idx, r.source, r.value])).toEqual([
      [ATTACHMENTS, 0, "authored", { nodeId: nodeA }],
      [ATTACHMENTS, 1, "authored", { nodeId: nodeB }],
    ]);
    expect(effective[0]!.boundBy).toBeNull();

    // The panel renders both rows in idx order with their asset names.
    const { container } = render(<PageView client={client} pageId={sourceId} />);
    const names = Array.from(container.querySelectorAll(".nt-asset-item__name")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["front.pdf", "back.pdf"]);
  });

  it("multi rows keep the Upload/Link buttons at the list's bottom; image assets render thumbnails", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,THUMBS");
    const sourceId = await createSource(client, "The Book");
    const nodeA = await client.createObject({ presentAsMain: true, name: "Asset node A", classIds: [ASSET_CLASS] });
    const nodeB = await client.createObject({ presentAsMain: true, name: "Asset node B", classIds: [ASSET_CLASS] });
    // A is an image asset (thumbnail), B a document (kind icon).
    await client.attachAsset(nodeA, { assetId: ASSET_ID_A, hash: HASH_A, mimeType: "image/png", size: 1, originalName: "front.png" });
    await attachFile(client, nodeB, { assetId: ASSET_ID_B, hash: HASH_B, originalName: "back.pdf" });
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: nodeA }, 0);
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: nodeB }, 1);

    render(<PageView client={client} pageId={sourceId} />);
    const row = attachmentsRow();
    const items = row.querySelectorAll(".nt-asset-item");
    expect(items).toHaveLength(2);
    expect(within(row).getByRole("button", { name: "front.png" })).not.toBeNull();
    expect(within(row).getByRole("button", { name: "back.pdf" })).not.toBeNull();
    // The image asset renders a thumbnail <img> (bytes resolve async through
    // the session cache); removals ride each item.
    await flushWrites();
    expect(row.querySelector("img.nt-asset-item__thumb")).not.toBeNull();
    expect(within(row).getByLabelText("Remove front.png")).not.toBeNull();
    expect(within(row).getByLabelText("Remove back.pdf")).not.toBeNull();
    // Both buttons sit at the list's bottom (after the items in the DOM).
    const actions = row.querySelector<HTMLElement>(".nt-asset-actions")!;
    expect(actions.compareDocumentPosition(items[1]!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(within(actions).getByRole("button", { name: "Upload" })).not.toBeNull();
    expect(within(actions).getByRole("button", { name: "Link" })).not.toBeNull();
    // The attachments row is the dedicated asset row — not the generic
    // object row (the source's separate `authors` row is object-typed).
    expect(row.querySelector(".nt-property-object")).toBeNull();
  });

  it("a single-value asset row hides the buttons until the value is cleared", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "hero", type: "asset", multi: false });
    const heroClass = await client.createClass("heroed");
    await client.setClassProperty(heroClass, schemaId, { sequence: 0 });
    const pageId = await client.createObject({ presentAsMain: true, name: "Heroed page" });
    await client.assignClass(pageId, heroClass);
    const assetId = await client.createObject({ presentAsMain: true, name: "hero.png", classIds: [ASSET_CLASS] });
    await client.setProperty(pageId, schemaId, { nodeId: assetId }, 0);

    render(<PageView client={client} pageId={pageId} />);
    const row = screen.getByText("hero").closest(".nt-props-sidebar__prop, .nt-property-asset") as HTMLElement;
    // Valued: the item renders, the authoring buttons do NOT.
    expect(within(row).getByRole("button", { name: "hero.png" })).not.toBeNull();
    expect(within(row).queryByRole("button", { name: "Upload" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Link" })).toBeNull();

    // Clearing swaps the row for the bound empty row (a fresh element) — the
    // buttons are back, hosted by the empty binding.
    fireEvent.click(within(row).getByLabelText("Remove hero.png"));
    await flushWrites();
    expect(client.getEffectiveProperties(pageId)).toEqual([]);
    const emptied = screen.getByText("hero").closest(".nt-props-sidebar__prop, .nt-property-asset") as HTMLElement;
    expect(within(emptied).getByRole("button", { name: "Upload" })).not.toBeNull();
    expect(within(emptied).getByRole("button", { name: "Link" })).not.toBeNull();
  });

  it("a non-asset node-typed property renders the picker without the upload action", async () => {
    const client = await seedClient();
    const personClass = await client.createClass("person");
    const mentorSchema = await client.createPropertySchema({
      name: "mentor",
      type: "object",
      targetClassFilter: [personClass],
    });
    const teamClass = await client.createClass("Team");
    await client.setClassProperty(teamClass, mentorSchema, { sequence: 0 });
    const teamId = await client.createObject({ presentAsMain: true, name: "Crew" });
    await client.assignClass(teamId, teamClass);
    await client.createObject({ presentAsMain: true, name: "Ada Lovelace", classIds: [personClass] });
    await client.createObject({ presentAsMain: true, name: "Grace Hopper" });

    render(<PageView client={client} pageId={teamId} />);
    expandProperties();
    const row = screen.getByText("mentor").closest(".nt-props-sidebar__prop, .nt-property-object") as HTMLElement;
    expect(row.textContent).not.toContain("default");
    fireEvent.click(within(row).getByRole("button", { name: "Add" }));

    // Picker-only: filtered to persons, no upload affordance.
    expect(screen.getByText("Ada Lovelace")).not.toBeNull();
    expect(screen.queryByText("Grace Hopper")).toBeNull();
    expect(screen.queryByText("Upload file…")).toBeNull();
    expect(screen.queryByLabelText("Upload mentor")).toBeNull();
  });
});
