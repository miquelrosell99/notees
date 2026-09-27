/**
 * Asset attachment UX tests (Zotero-style source containers): the properties
 * panel renders node-typed (`object`) properties as chips + a picker filtered
 * by the schema's targetClassFilter; asset-targeted rows add an "upload file"
 * action (POST /api/v1/assets → asset node + asset.attach + property.set);
 * chips resolve the asset's original name via the derived node_asset rows and
 * download through GET /api/v1/assets/:id (workspace API key header, blob URL
 * so the key never lands in a URL). jsdom over the in-process WorkspaceClient
 * with a stubbed fetch.
 *
 * The relay is pre-seeded with the server-style seed ops (apps/server/src/
 * seed.ts): the fixed-UUID asset + source classes and the attachments
 * property schema (…000000000011, targetClassFilter [asset]) — so the pulled
 * store matches what a real workspace bootstrap delivers.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
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
    seedEnvelope("class.create", { classId: ASSET_CLASS, name: "asset", icon: "mdiPaperclip" }, [ASSET_CLASS]),
    seedEnvelope("class.create", { classId: SOURCE_CLASS, name: "source", icon: "mdiBookshelf" }, [SOURCE_CLASS]),
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
  const id = await client.createObject({ nodeType: "page", name });
  await client.assignClass(id, SOURCE_CLASS);
  return id;
}

/** The attachments row in the panel (the source also binds linkedAuthors). */
function attachmentsRow(): HTMLElement {
  return screen.getByText("attachments").closest(".nt-property-object") as HTMLElement;
}

/** Stub fetch: upload POSTs answer with `body`, download GETs with bytes. */
function stubFetch(body: Record<string, unknown> = uploadBody()) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url) === `${SERVER}/api/v1/assets`) {
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

describe("Asset attachments (node-typed properties)", () => {
  it("shows the bound attachments row for a source with no attachments yet", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");

    render(<PageView client={client} pageId={sourceId} />);
    const row = attachmentsRow();
    expect(row.textContent).toContain("attachments");
    // No values: no "default" hint, but the add affordance is reachable.
    expect(row.textContent).not.toContain("default");
    expect(within(row).getByRole("button", { name: "+ Add" })).not.toBeNull();
  });

  it("picker filters candidates by the schema's target class", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    await client.createObject({ nodeType: "page", name: "scan.pdf", classIds: [ASSET_CLASS] });
    await client.createObject({ nodeType: "page", name: "Random notes" });

    render(<PageView client={client} pageId={sourceId} />);
    fireEvent.click(within(attachmentsRow()).getByRole("button", { name: "+ Add" }));

    // Only asset-class nodes are candidates; the plain page is filtered out.
    expect(screen.getByText("scan.pdf")).not.toBeNull();
    expect(screen.queryByText("Random notes")).toBeNull();
  });

  it("picker search narrows candidates by name within the target class", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    await client.createObject({ nodeType: "page", name: "chapter-one.pdf", classIds: [ASSET_CLASS] });
    await client.createObject({ nodeType: "page", name: "cover.png", classIds: [ASSET_CLASS] });

    render(<PageView client={client} pageId={sourceId} />);
    fireEvent.click(within(attachmentsRow()).getByRole("button", { name: "+ Add" }));
    fireEvent.change(screen.getByLabelText("Search attachments"), { target: { value: "cover" } });

    expect(screen.getByText("cover.png")).not.toBeNull();
    expect(screen.queryByText("chapter-one.pdf")).toBeNull();
  });

  it("uploading a file POSTs to the asset store and links the new asset", async () => {
    const client = await seedClient({ rest: true });
    const sourceId = await createSource(client, "The Book");
    const calls = stubFetch();

    render(<PageView client={client} pageId={sourceId} />);
    fireEvent.click(within(attachmentsRow()).getByRole("button", { name: "+ Add" }));
    const file = new File(["hello"], "paper.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Upload attachments"), { target: { files: [file] } });

    // The chip lands with the server-returned original name.
    await screen.findByRole("button", { name: "paper.pdf" });

    // The upload hit the server with the workspace API key, multipart body.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${SERVER}/api/v1/assets`);
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe(API_KEY);
    expect(headers["X-Workspace-Id"]).toBe(WS);
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);

    // The property value list links the new asset node (authored row).
    const effective = client.getEffectiveProperties(sourceId);
    expect(effective).toHaveLength(1);
    const row = effective[0]!;
    expect(row.propertySchemaId).toBe(ATTACHMENTS);
    expect(row.source).toBe("authored");
    const assetNodeId = (row.value as { nodeId: string }).nodeId;

    // The asset node carries the asset class + file name; node_asset ties it
    // to the content-addressed bytes (the chip's name/download read).
    const assetNode = client.getNode(assetNodeId)!;
    expect(assetNode.classIds).toContain(ASSET_CLASS);
    expect(assetNode.name).toBe("paper.pdf");
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
    fireEvent.click(within(attachmentsRow()).getByRole("button", { name: "+ Add" }));
    const file = new File(["hello"], "paper.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Upload attachments"), { target: { files: [file] } });

    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("500");
    expect(client.getEffectiveProperties(sourceId)).toEqual([]);
  });

  it("chip removal unlinks the slot (property.unset per idx)", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const nodeA = await client.createObject({ nodeType: "page", name: "Asset node A", classIds: [ASSET_CLASS] });
    const nodeB = await client.createObject({ nodeType: "page", name: "Asset node B", classIds: [ASSET_CLASS] });
    await attachFile(client, nodeA, { assetId: ASSET_ID_A, hash: HASH_A, originalName: "a.pdf" });
    await attachFile(client, nodeB, { assetId: ASSET_ID_B, hash: HASH_B, originalName: "b.pdf" });
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: nodeA }, 0);
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: nodeB }, 1);

    render(<PageView client={client} pageId={sourceId} />);
    expect(screen.getByRole("button", { name: "a.pdf" })).not.toBeNull();
    fireEvent.click(screen.getByLabelText("Remove a.pdf"));
    await flushWrites();

    // Only the second link survives — the multi-value list was rewritten.
    const refs = client
      .getEffectiveProperties(sourceId)
      .map((r) => (r.value as { nodeId: string }).nodeId);
    expect(refs).toEqual([nodeB]);
    expect(screen.queryByText("a.pdf")).toBeNull();
    expect(screen.getByRole("button", { name: "b.pdf" })).not.toBeNull();
  });

  it("attachment chips render the asset's original name from node_asset, not the node name", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const assetNode = await client.createObject({ nodeType: "page", name: "Asset node", classIds: [ASSET_CLASS] });
    await attachFile(client, assetNode, {
      assetId: ASSET_ID_A,
      hash: HASH_A,
      originalName: "Chapter 1 — scan.pdf",
    });
    await client.setProperty(sourceId, ATTACHMENTS, { nodeId: assetNode }, 0);

    const { container } = render(<PageView client={client} pageId={sourceId} />);
    // The chip resolves through the node_asset row, so the file name (not the
    // generic node name, and never a bare UUID) is what the user shows.
    expect(screen.getByRole("button", { name: "Chapter 1 — scan.pdf" })).not.toBeNull();
    expect(container.textContent).not.toContain(assetNode);
  });

  it("clicking an attachment chip downloads it via the server asset URL", async () => {
    const client = await seedClient({ rest: true });
    const sourceId = await createSource(client, "The Book");
    const assetNode = await client.createObject({ nodeType: "page", name: "Asset node", classIds: [ASSET_CLASS] });
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
    const download = calls.find((c) => c.url === `${SERVER}/api/v1/assets/${ASSET_ID_A}`);
    expect(download).toBeDefined();
    expect((download!.init.headers as Record<string, string>)["X-API-Key"]).toBe(API_KEY);
  });

  it("a source with attachments round-trips through effective properties", async () => {
    const client = await seedClient();
    const sourceId = await createSource(client, "The Book");
    const nodeA = await client.createObject({ nodeType: "page", name: "Asset node A", classIds: [ASSET_CLASS] });
    const nodeB = await client.createObject({ nodeType: "page", name: "Asset node B", classIds: [ASSET_CLASS] });
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

    // The panel renders both chips in idx order with their asset names.
    const { container } = render(<PageView client={client} pageId={sourceId} />);
    const chipNames = Array.from(container.querySelectorAll("button.nt-chip-label")).map(
      (el) => el.textContent,
    );
    expect(chipNames).toEqual(["front.pdf", "back.pdf"]);
  });

  it("a non-asset node-typed property renders the picker without the upload action", async () => {
    const client = await seedClient();
    const personClass = await client.createObject({ nodeType: "class", name: "person" });
    const mentorSchema = await client.createPropertySchema({
      name: "mentor",
      type: "object",
      targetClassFilter: [personClass],
    });
    const teamClass = await client.createClass("Team");
    await client.setClassProperty(teamClass, mentorSchema, { sequence: 0 });
    const teamId = await client.createObject({ nodeType: "page", name: "Crew" });
    await client.assignClass(teamId, teamClass);
    await client.createObject({ nodeType: "page", name: "Ada Lovelace", classIds: [personClass] });
    await client.createObject({ nodeType: "page", name: "Grace Hopper" });

    render(<PageView client={client} pageId={teamId} />);
    const row = screen.getByText("mentor").closest(".nt-property-object") as HTMLElement;
    expect(row.textContent).not.toContain("default");
    fireEvent.click(within(row).getByRole("button", { name: "+ Add" }));

    // Picker-only: filtered to persons, no upload affordance.
    expect(screen.getByText("Ada Lovelace")).not.toBeNull();
    expect(screen.queryByText("Grace Hopper")).toBeNull();
    expect(screen.queryByText("Upload file…")).toBeNull();
    expect(screen.queryByLabelText("Upload mentor")).toBeNull();
  });
});
