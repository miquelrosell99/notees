/**
 * Modals + overlays tests (jsdom): the ported dialogs render their legacy
 * chrome, write through the WorkspaceClient surface, and the export modal
 * builds its preview from the local @notees/export engine. The
 * BackendUnavailableOverlay toggles banner/lock off the sync status, and
 * the toast host connects the notification store to the presentational
 * toast.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { unzipSync } from "fflate";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { deriveDisplayName } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { ExportPageModal } from "../src/ui/components/modals/ExportPageModal.js";
import { DuplicatePageModal } from "../src/ui/components/modals/DuplicatePageModal.js";
import { CreatePageWithUuidModal } from "../src/ui/components/modals/CreatePageWithUuidModal.js";
import { QuickAddModal } from "../src/ui/components/modals/QuickAddModal.js";
import { WorkspaceNameModal } from "../src/ui/components/modals/WorkspaceNameModal.js";
import { BackendUnavailableOverlay } from "../src/ui/components/ui/BackendUnavailableOverlay.js";
import { LoadingSkeleton, Skeleton } from "../src/ui/components/ui/LoadingSkeleton.js";
import { NotificationToaster } from "../src/ui/components/ui/NotificationToaster.js";
import { notificationStore } from "../src/ui/components/ui/notificationStore.js";
import type { SyncStatusSnapshot } from "../src/core/workspace-client.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  notificationStore.clearAll();
});

async function makeClient(options: { serverUrl?: string; apiKey?: string } = {}): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
    ...(options.serverUrl !== undefined ? { serverUrl: options.serverUrl } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

const OK_STATUS: SyncStatusSnapshot = {
  status: "idle",
  error: null,
  pending: 0,
  failed: 0,
  quarantined: 0,
  parked: 0,
  realtime: false,
  cursorSeq: 0,
};

/** Read a Blob's bytes in jsdom (whose Blob has no arrayBuffer()). */
function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Capture downloadBlob's anchor + blob (jsdom has no URL.createObjectURL). */
function stubDownload() {
  const captured: { blob: Blob | null; anchor: HTMLAnchorElement | null; restore: () => void } = {
    blob: null,
    anchor: null,
    restore: () => {},
  };
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn((blob: Blob) => {
      captured.blob = blob;
      return "blob:mock";
    }),
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      captured.anchor = this;
    });
  captured.restore = () => click.mockRestore();
  return captured;
}

describe("ExportPageModal", () => {
  it("previews the subtree markdown from the local export engine", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Book flights" }],
    });
    const childId = await client.createObject({ presentAsMain: true, name: "Packing", parentId: pageId });
    await client.createObject({
      parentId: childId,
      contentAst: [{ type: "text", text: "Sunscreen" }],
    });

    render(
      <ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={pageId} nodeName="Trip" />,
    );

    const preview = (await screen.findByLabelText("markdown preview", undefined, {
      timeout: 2000,
    })) as HTMLTextAreaElement;
    await vi.waitFor(
      () => {
        expect(preview.value).toContain("name: Trip");
        expect(preview.value).toContain("# Trip");
        expect(preview.value).toContain("- Book flights");
        // Child page included as its own section by default.
        expect(preview.value).toContain("# Packing");
        expect(preview.value).toContain("- Sunscreen");
      },
      { timeout: 2000 },
    );
  }, 10000);

  it("lists the registry formats as cards, disabling unavailable ones with their reason", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });

    render(<ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={pageId} />);

    // Format cards, not tabs.
    expect(screen.queryByRole("tablist")).toBeNull();
    // Markdown is the first available format — selected by default.
    expect(screen.getByRole("radio", { name: /markdown/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /markdown/i })).not.toHaveAttribute("aria-disabled");
    // The redesign format set: html is available since H1 and Word since D1;
    // the remaining skeletons stay disabled cards carrying the registry reason.
    expect(screen.getByRole("radio", { name: /html/i })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("radio", { name: /word/i })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("radio", { name: /pdf.*task P1/is })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("radio", { name: /latex.*task L1/is })).toHaveAttribute("aria-disabled", "true");

    // Clicking a disabled card changes nothing: markdown stays selected.
    fireEvent.click(screen.getByRole("radio", { name: /pdf/i }));
    expect(screen.getByRole("radio", { name: /markdown/i })).toBeChecked();
    expect(screen.getByRole("radio", { name: /pdf/i })).not.toBeChecked();
  }, 10000);

  it("renders the format's registry options and honors Include child pages", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });
    const childId = await client.createObject({ presentAsMain: true, name: "Packing", parentId: pageId });
    await client.createObject({
      parentId: childId,
      contentAst: [{ type: "text", text: "Sunscreen" }],
    });

    render(<ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={pageId} />);

    const preview = (await screen.findByLabelText("markdown preview", undefined, {
      timeout: 2000,
    })) as HTMLTextAreaElement;
    await vi.waitFor(() => expect(preview.value).toContain("# Packing"), { timeout: 2000 });

    // The registry's markdown options render as checkbox rows.
    fireEvent.click(screen.getByRole("checkbox", { name: /include child pages/i }));

    await vi.waitFor(
      () => {
        expect((screen.getByLabelText("markdown preview") as HTMLTextAreaElement).value).not.toContain(
          "# Packing",
        );
      },
      { timeout: 2000 },
    );
  }, 10000);

  it("feeds the option checkboxes to the engine (type labels, outline)", async () => {
    const client = await makeClient();
    const classId = await client.createClass("Company");
    // WORKAROUND(store applier): class.create's contentAst never lands in the
    // class node's content — seed the title via object.update (same
    // workaround as the DuplicatePageModal spec above).
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "Company" }] });
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip", classIds: [classId] });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "text", text: "Book flights" }],
    });

    render(<ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={pageId} />);

    const preview = (await screen.findByLabelText("markdown preview", undefined, {
      timeout: 2000,
    })) as HTMLTextAreaElement;
    await vi.waitFor(
      () => {
        // Outline ON by default: block children render as nested bullets.
        expect(preview.value).toContain("- Book flights");
        // Type labels OFF by default: no classNames frontmatter line.
        expect(preview.value).not.toContain("classNames:");
      },
      { timeout: 2000 },
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /type labels/i }));
    await vi.waitFor(
      () => {
        expect(preview.value).toContain("classNames:");
        expect(preview.value).toContain("- Company");
      },
      { timeout: 2000 },
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /child outline/i }));
    await vi.waitFor(
      () => expect(preview.value).not.toContain("- Book flights"),
      { timeout: 2000 },
    );
  }, 10000);

  it("downloads one markdown file for a single node", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });

    let capturedBlob: Blob | null = null;
    const createObjectUrl = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return "blob:mock";
    });
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectUrl, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectUrl, configurable: true });
    let captured: HTMLAnchorElement | null = null;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        captured = this;
      });

    render(<ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={pageId} />);
    await screen.findByLabelText("markdown preview", undefined, { timeout: 2000 });

    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    expect(createObjectUrl).toHaveBeenCalled();
    expect(captured).not.toBeNull();
    expect(captured!.getAttribute("download")).toBe("Trip.md");
    expect(capturedBlob).not.toBeNull();
    expect(capturedBlob!.type).toBe("text/markdown");

    click.mockRestore();
  }, 10000);

  it("zips every selected node's subtree plus the manifest for a batch", async () => {
    const client = await makeClient();
    const tripId = await client.createObject({ presentAsMain: true, name: "Trip" });
    const packingId = await client.createObject({ presentAsMain: true, name: "Packing" });

    let capturedBlob: Blob | null = null;
    const createObjectUrl = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return "blob:mock";
    });
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectUrl, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectUrl, configurable: true });
    let captured: HTMLAnchorElement | null = null;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        captured = this;
      });

    render(
      <ExportPageModal
        isOpen={true}
        onClose={() => {}}
        client={client}
        nodeUuids={[tripId, packingId]}
      />,
    );
    await screen.findByLabelText("markdown preview", undefined, { timeout: 2000 });

    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    await vi.waitFor(() => expect(captured).not.toBeNull());
    // One zip named after the first node (the E5 `<slug>.zip` convention).
    expect(captured!.getAttribute("download")).toBe("Trip.zip");
    expect(capturedBlob).not.toBeNull();
    expect(capturedBlob!.type).toBe("application/zip");

    const entries = unzipSync(new Uint8Array(await readBlobBytes(capturedBlob!)));
    const decode = (data: Uint8Array) => new TextDecoder().decode(data);
    // Human-readable <slug>-<id8>.md names (the id8 is a hash of the node id —
    // assert the shape, not the hash value).
    const entryFor = (slug: string) => {
      const match = Object.keys(entries).filter((name) => new RegExp(`^${slug}-[0-9a-f]{8}\\.md$`).test(name));
      expect(match).toHaveLength(1);
      return match[0]!;
    };
    const tripPath = entryFor("Trip");
    const packingPath = entryFor("Packing");
    // Every selected node's subtree made it into the ONE zip, with the
    // human-readable slug filenames and the bundle manifest alongside.
    expect(Object.keys(entries)).toEqual(expect.arrayContaining([tripPath, packingPath, "notees-manifest.json"]));
    expect(decode(entries[tripPath]!)).toContain("# Trip");
    expect(decode(entries[packingPath]!)).toContain("# Packing");

    const manifest = JSON.parse(decode(entries["notees-manifest.json"]!)) as {
      version: number;
      nodes: Array<{ id: string; path: string; type: string }>;
    };
    expect(manifest.version).toBe(2);
    expect(manifest.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([tripId, packingId]));
    expect(manifest.nodes.map((node) => node.path)).toEqual(
      expect.arrayContaining([tripPath, packingPath]),
    );

    click.mockRestore();
  }, 10000);

  it("zips asset bytes under assets/ and rewrites the markdown ref when Include asset files is on", async () => {
    const client = await makeClient({ serverUrl: "https://notees.example.com", apiKey: "test-key" });
    const assetId = "0192a000-0000-7000-8000-0000000000a1";
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });
    // asset_ref lives on an inline block (document-chrome content is
    // text-only; block-scale rich tokens survive on inline blocks).
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "asset_ref", assetId }],
    });
    const hash = "a".repeat(64);
    await client.attachAsset(pageId, {
      assetId,
      hash,
      mimeType: "image/png",
      size: 4,
      originalName: "Boarding Pass.PNG",
    });

    const assetBytes = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/assets/${assetId}`)) {
        return new Response(assetBytes, { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const download = stubDownload();
    render(
      <ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={pageId} nodeName="Trip" />,
    );
    await screen.findByLabelText("markdown preview", undefined, { timeout: 2000 });

    fireEvent.click(screen.getByRole("checkbox", { name: /include asset files/i }));
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    await vi.waitFor(() => expect(download.anchor).not.toBeNull());
    // A single node with assets switches to zip delivery (E7).
    expect(download.anchor!.getAttribute("download")).toBe("Trip.zip");
    expect(download.blob!.type).toBe("application/zip");
    // The bytes were fetched over the authenticated asset endpoint.
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith(`/api/assets/${assetId}`)),
    ).toBe(true);

    const entries = unzipSync(new Uint8Array(await readBlobBytes(download.blob!)));
    const decode = (data: Uint8Array) => new TextDecoder().decode(data);
    const pagePath = Object.keys(entries).find((name) => /^Trip-[0-9a-f]{8}\.md$/.test(name)) ?? "";
    expect(pagePath).not.toBe("");
    // The E5 naming convention: original-name slug + content-hash8 + ext.
    const assetPath = `assets/Boarding-Pass-${hash.slice(0, 8)}.png`;
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([pagePath, assetPath, "notees-manifest.json"]),
    );
    expect(Array.from(entries[assetPath]!)).toEqual([137, 80, 78, 71]);
    // The markdown ref was rewritten from the raw uuid to the relative path.
    const markdown = decode(entries[pagePath]!);
    expect(markdown).toContain(`![asset](${assetPath})`);
    expect(markdown).not.toContain(`![asset](<${assetId}>)`);

    download.restore();
  }, 10000);

  it("keeps the raw uuid ref and adds no asset file when the bytes are unfetchable", async () => {
    const client = await makeClient({ serverUrl: "https://notees.example.com", apiKey: "test-key" });
    const assetId = "0192a000-0000-7000-8000-0000000000a2";
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "asset_ref", assetId }],
    });
    await client.attachAsset(pageId, {
      assetId,
      hash: "b".repeat(64),
      mimeType: "image/png",
      size: 4,
      originalName: "Receipt.png",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));

    const download = stubDownload();
    render(
      <ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={pageId} nodeName="Trip" />,
    );
    await screen.findByLabelText("markdown preview", undefined, { timeout: 2000 });

    fireEvent.click(screen.getByRole("checkbox", { name: /include asset files/i }));
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    await vi.waitFor(() => expect(download.anchor).not.toBeNull());
    const entries = unzipSync(new Uint8Array(await readBlobBytes(download.blob!)));
    const pagePath = Object.keys(entries).find((name) => /^Trip-[0-9a-f]{8}\.md$/.test(name)) ?? "";
    expect(pagePath).not.toBe("");
    // The export still lands as a zip; the failed asset is skipped, not fatal.
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([pagePath, "notees-manifest.json"]),
    );
    expect(Object.keys(entries).some((key) => key.startsWith("assets/"))).toBe(false);
    expect(new TextDecoder().decode(entries[pagePath]!)).toContain(`![asset](<${assetId}>)`);

    download.restore();
  }, 10000);

  it("scans every exported root's subtree for assets in a batch with Include asset files", async () => {
    const client = await makeClient({ serverUrl: "https://notees.example.com", apiKey: "test-key" });
    const assetA = "0192a000-0000-7000-8000-0000000000a1";
    const assetB = "0192a000-0000-7000-8000-0000000000b2";
    const tripId = await client.createObject({ presentAsMain: true, name: "Trip" });
    await client.createObject({
      parentId: tripId,
      contentAst: [{ type: "asset_ref", assetId: assetA }],
    });
    await client.attachAsset(tripId, {
      assetId: assetA,
      hash: "a".repeat(64),
      mimeType: "image/png",
      size: 4,
      originalName: "Boarding Pass.PNG",
    });
    const packingId = await client.createObject({ presentAsMain: true, name: "Packing" });
    await client.createObject({
      parentId: packingId,
      contentAst: [{ type: "asset_ref", assetId: assetB }],
    });
    await client.attachAsset(packingId, {
      assetId: assetB,
      hash: "b".repeat(64),
      mimeType: "image/jpeg",
      size: 4,
      originalName: "Receipt.jpg",
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/assets/${assetA}`)) {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      if (url.endsWith(`/api/assets/${assetB}`)) {
        return new Response(new Uint8Array([2]), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const download = stubDownload();
    render(
      <ExportPageModal
        isOpen={true}
        onClose={() => {}}
        client={client}
        nodeUuids={[tripId, packingId]}
      />,
    );
    await screen.findByLabelText("markdown preview", undefined, { timeout: 2000 });

    fireEvent.click(screen.getByRole("checkbox", { name: /include asset files/i }));
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    await vi.waitFor(() => expect(download.anchor).not.toBeNull());
    expect(download.anchor!.getAttribute("download")).toBe("Trip.zip");

    const entries = unzipSync(new Uint8Array(await readBlobBytes(download.blob!)));
    const decode = (data: Uint8Array) => new TextDecoder().decode(data);
    const mdFor = (slug: string) => {
      const match = Object.keys(entries).filter((name) => new RegExp(`^${slug}-[0-9a-f]{8}\\.md$`).test(name));
      expect(match).toHaveLength(1);
      return match[0]!;
    };
    const tripPath = mdFor("Trip");
    const packingPath = mdFor("Packing");
    const assetPathA = `assets/Boarding-Pass-${"a".repeat(8)}.png`;
    const assetPathB = `assets/Receipt-${"b".repeat(8)}.jpg`;
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([tripPath, packingPath, assetPathA, assetPathB, "notees-manifest.json"]),
    );
    expect(decode(entries[tripPath]!)).toContain(`![asset](${assetPathA})`);
    expect(decode(entries[packingPath]!)).toContain(`![asset](${assetPathB})`);

    download.restore();
  }, 10000);
});

describe("DuplicatePageModal", () => {
  it("creates the page with the picked class", async () => {
    const client = await makeClient();
    const classId = await client.createClass("Company");
    // WORKAROUND(store applier): class.create's contentAst never lands in the
    // class node's content (the upsert's LWW update loses against the row its
    // own INSERT just wrote), so seed the title via object.update — the
    // later-HLC path that does persist. Remove once the applier is fixed.
    await client.updateObject(classId, { contentAst: [{ type: "text", text: "Company" }] });

    const onSuccess = vi.fn();
    render(
      <DuplicatePageModal
        isOpen={true}
        onClose={() => {}}
        pageName="Apple"
        conflictingClasses={["Fruit"]}
        originalClasses={["Fruit"]}
        parentId={null}
        client={client}
        onSuccess={onSuccess}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /company/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const created = onSuccess.mock.calls[0]![0] as { id: string; contentAst: unknown; classIds: string[] };
    // Title-is-content: the duplicate's title is its content.
    expect(created.contentAst).toEqual([{ type: "text", text: "Apple" }]);
    expect(created.classIds).toContain(classId);
    expect(deriveDisplayName(client.getNode(created.id)!)).toBe("Apple");
  });
});

describe("CreatePageWithUuidModal", () => {
  it("creates a node with the user-specified UUID", async () => {
    const client = await makeClient();
    const fixed = "550e8400-e29b-41d4-a716-446655440000";

    const onSuccess = vi.fn();
    render(<CreatePageWithUuidModal isOpen={true} onClose={() => {}} client={client} onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText(/page name/i), { target: { value: "Fixed id page" } });
    fireEvent.change(screen.getByLabelText(/^uuid$/i), {
      target: { value: fixed },
    });
    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));

    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
    // Title-is-content: the page's title is its text content.
    expect(client.getNode(fixed)?.contentAst).toEqual([{ type: "text", text: "Fixed id page" }]);
  });

  it("refuses a UUID that already exists", async () => {
    const client = await makeClient();
    const fixed = "550e8400-e29b-41d4-a716-446655440000";
    await client.createObject({ id: fixed, presentAsMain: true, name: "Taken" });

    render(<CreatePageWithUuidModal isOpen={true} onClose={() => {}} client={client} onSuccess={() => {}} />);

    fireEvent.change(screen.getByLabelText(/page name/i), { target: { value: "Again" } });
    fireEvent.change(screen.getByLabelText(/^uuid$/i), {
      target: { value: fixed },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });
});

describe("QuickAddModal", () => {
  it("captures blocks into the Inbox page", async () => {
    const client = await makeClient();
    const inboxId = await client.createObject({ presentAsMain: true, name: "Inbox" });

    render(<QuickAddModal isOpen={true} onClose={() => {}} client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /inbox/i }));
    fireEvent.change(screen.getByPlaceholderText("Type something..."), {
      target: { value: "Remember the milk" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await vi.waitFor(() => {
      const children = client.getChildren(inboxId);
      expect(children).toHaveLength(1);
      expect(children[0]!.contentAst).toEqual([{ type: "text", text: "Remember the milk" }]);
    });
  });

  it("keeps Send disabled when no Inbox page exists", async () => {
    const client = await makeClient();

    render(<QuickAddModal isOpen={true} onClose={() => {}} client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /inbox/i }));
    fireEvent.change(screen.getByPlaceholderText("Type something..."), {
      target: { value: "Nowhere to go" },
    });

    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });
});

describe("WorkspaceNameModal", () => {
  it("validates and submits the trimmed name", async () => {
    const onSubmit = vi.fn();
    render(
      <WorkspaceNameModal
        isOpen={true}
        onClose={() => {}}
        onSubmit={onSubmit}
        title="Rename workspace"
        submitLabel="Rename"
      />,
    );

    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: "  " } });
    // The submit button is disabled for too-short names; submitting the form
    // directly (the Enter-key path) still surfaces the validation message.
    expect(screen.getByRole("button", { name: /^rename$/i })).toBeDisabled();
    fireEvent.submit(document.querySelector("form")!);
    expect(screen.getByText(/please enter a workspace name/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: "  Garden  " } });
    fireEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    expect(onSubmit).toHaveBeenCalledWith("Garden");
  });
});

describe("BackendUnavailableOverlay", () => {
  it("renders nothing while healthy, a banner on error, and a lock after dismiss", () => {
    const { rerender } = render(<BackendUnavailableOverlay syncStatus={OK_STATUS} />);
    expect(screen.queryByText(/backend unreachable/i)).not.toBeInTheDocument();

    const errorStatus: SyncStatusSnapshot = { ...OK_STATUS, status: "error", error: "boom" };
    rerender(<BackendUnavailableOverlay syncStatus={errorStatus} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveClass("backend-unavailable-banner");
    expect(within(banner).getByText(/backend unreachable/i)).toBeInTheDocument();

    fireEvent.click(within(banner).getByRole("button", { name: /dismiss/i }));

    const lock = screen.getByLabelText(/backend is unavailable/i);
    expect(lock).toHaveClass("backend-unavailable-overlay");
    expect(within(lock).getByText(/unlock automatically/i)).toBeInTheDocument();

    // Recovery clears the lock again.
    rerender(<BackendUnavailableOverlay syncStatus={OK_STATUS} />);
    expect(screen.queryByLabelText(/backend is unavailable/i)).not.toBeInTheDocument();
  });
});

describe("LoadingSkeleton", () => {
  it("renders the configured shimmer rows", () => {
    const { container } = render(<LoadingSkeleton rows={4} showHeading showAvatar />);
    expect(container.querySelectorAll(".skeleton-row")).toHaveLength(4);
    expect(container.querySelector(".skeleton-group__heading")).not.toBeNull();
    expect(container.querySelectorAll(".skeleton-row__avatar")).toHaveLength(4);
    expect(screen.getByRole("status", { name: /loading/i })).toBeInTheDocument();
  });

  it("renders a standalone Skeleton with shape and width classes", () => {
    const { container } = render(<Skeleton shape="circle" width="half" />);
    const skeleton = container.querySelector(".skeleton");
    expect(skeleton).toHaveClass("skeleton--circle");
    expect(skeleton).toHaveClass("skeleton--half");
  });
});

describe("NotificationToaster", () => {
  it("shows and dismisses store notifications", async () => {
    render(<NotificationToaster />);

    act(() => {
      notificationStore.success("Saved", "All changes synced");
    });

    const toast = screen.getByRole("status");
    expect(toast).toHaveClass("notification-toast--success");
    expect(within(toast).getByText("Saved")).toBeInTheDocument();

    fireEvent.click(within(toast).getByRole("button", { name: /dismiss/i }));
    // Dismissed toasts stay mounted briefly so the exit transition can play.
    expect(screen.getByText("Saved").closest(".notification-toast")).toHaveClass(
      "notification-toast--exiting",
    );
    await waitFor(() => expect(screen.queryByText("Saved")).not.toBeInTheDocument());
  });
});
