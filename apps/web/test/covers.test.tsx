/**
 * Covers (§34.74, owner directive 2026-10-04): a cover IS an ordinary
 * asset-classed node — the dedicated `cover` system class (§34.56) was
 * withdrawn the same day it shipped: it duplicated the cover PROPERTY's
 * meaning. The property value is the only authority; the card-view "Cover"
 * badge DERIVES from it (isCoverAsset — no class to keep in sync).
 *
 * M33: the empty card's "Add cover" gesture opens the AssetUploadModal
 * directly (image-only, validated, preview + progress — the v1 flow); the
 * Change path keeps the CoverPicker (search existing assets, or "Upload new
 * cover…" which routes to the same modal).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { NodeCollection } from "../src/ui/views/index.js";
import {
  clearNodeCover,
  coverAssetIdOf,
  ensureCoverProperty,
  isCoverAsset,
  setNodeCover,
} from "../src/ui/components/coverProperty.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
/** The withdrawn cover class id (…0042 — minted §34.56, withdrawn §34.74). */
const WITHDRAWN_COVER_CLASS = "00000000-0000-0000-0001-000000000042";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

async function flushWrites(): Promise<void> {
  await act(async () => {});
}

/** A source-classed page plus a bare asset node; returns [pageId, assetId]. */
async function seedPageAndAsset(client: WorkspaceClient): Promise<[string, string]> {
  const asset = await client.createObject({
    presentAsMain: true,
    name: "cover.png",
  });
  const pageId = await client.createObject({ presentAsMain: true, name: "Covered" });
  await client.assignClass(pageId, SYSTEM_CLASS_UUIDS.source);
  return [pageId, asset];
}

describe("covers (§34.74 — asset-classed, no cover class)", () => {
  it("ensureCoverProperty authors the schema + class roots, NO source binding, NO cover class (owner ruling 2026-10-05: a cover makes no sense on sources)", async () => {
    const client = await seedClient();
    await ensureCoverProperty(client);
    await flushWrites();

    expect(
      client.listPropertySchemas().some((s) => s.id === SYSTEM_PROPERTY_UUIDS.cover),
    ).toBe(true);
    // The cover→source binding row is removed from the seeds and must never
    // be re-authored here (scripts/migrate-system-names.mts clears it live).
    expect(
      client
        .getClassBindings(SYSTEM_CLASS_UUIDS.source)
        .some((b) => b.propertySchemaId === SYSTEM_PROPERTY_UUIDS.cover),
    ).toBe(false);
    // The withdrawn cover class is never authored (…0042 minted §34.56,
    // withdrawn §34.74 — a cover is a plain asset).
    expect(client.getNode(WITHDRAWN_COVER_CLASS)).toBeUndefined();

    // Idempotent: a second ensure authors nothing new.
    await ensureCoverProperty(client);
    await flushWrites();
    expect(client.getNode(WITHDRAWN_COVER_CLASS)).toBeUndefined();
  });

  it("setNodeCover writes the value and classes the asset (explicit ops)", async () => {
    const client = await seedClient();
    const [pageId, assetId] = await seedPageAndAsset(client);

    await setNodeCover(client, pageId, assetId);
    await flushWrites();

    expect(coverAssetIdOf(client, pageId)).toBe(assetId);
    const classIds = client.getNode(assetId)?.classIds ?? [];
    expect(classIds).toContain(SYSTEM_CLASS_UUIDS.asset);
    expect(classIds).not.toContain(WITHDRAWN_COVER_CLASS);
  });

  it("clearNodeCover unsets the value; the asset stays an asset", async () => {
    const client = await seedClient();
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeCover(client, pageId, assetId);
    await flushWrites();

    await clearNodeCover(client, pageId);
    await flushWrites();
    expect(coverAssetIdOf(client, pageId)).toBeNull();
    const classIds = client.getNode(assetId)?.classIds ?? [];
    expect(classIds).toContain(SYSTEM_CLASS_UUIDS.asset);
    expect(classIds).not.toContain(WITHDRAWN_COVER_CLASS);
  });

  it("the asset class's Classed nodes lists cover assets (membership in asset)", async () => {
    const client = await seedClient();
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeCover(client, pageId, assetId);
    await flushWrites();

    const members = client.getClassMembers(SYSTEM_CLASS_UUIDS.asset);
    expect(members.map((m) => m.id)).toContain(assetId);
  });

  it("isCoverAsset derives from the property: true while referenced, false once cleared", async () => {
    const client = await seedClient();
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeCover(client, pageId, assetId);
    await flushWrites();
    expect(isCoverAsset(client, assetId)).toBe(true);

    await clearNodeCover(client, pageId);
    await flushWrites();
    expect(isCoverAsset(client, assetId)).toBe(false);
  });

  it("card views show the Cover badge on assets referenced by a cover value", async () => {
    const client = await seedClient();
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeCover(client, pageId, assetId);
    await flushWrites();

    render(
      <NodeCollection
        viewMode="cards"
        client={client}
        items={[{ node: client.getNode(assetId)! }]}
      />,
    );
    const badge = screen.getByText("Cover");
    expect(badge.closest(".node-card__cover-badge")).not.toBeNull();
  });

  it("a bare (non-cover) asset shows no badge", async () => {
    const client = await seedClient();
    const asset = await client.createObject({ presentAsMain: true, name: "plain.png" });
    await client.assignClass(asset, SYSTEM_CLASS_UUIDS.asset);
    await flushWrites();

    render(
      <NodeCollection
        viewMode="cards"
        client={client}
        items={[{ node: client.getNode(asset)! }]}
      />,
    );
    expect(screen.queryByText("Cover")).toBeNull();
  });

  it("the expanded cover card offers Change cover and Remove cover", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,COVERS");
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeCover(client, pageId, assetId);
    await flushWrites();

    const { container } = render(<PageView client={client} pageId={pageId} />);
    // A set cover auto-expands the card (§34.72).
    await screen.findByRole("button", { name: "Collapse cover" });
    const card = container.querySelector(".nt-covercard")!;
    expect(card.querySelector('[aria-label="Change cover"]')).not.toBeNull();
    expect(card.querySelector('[aria-label="Remove cover"]')).not.toBeNull();

    fireEvent.click(card.querySelector('[aria-label="Remove cover"]')!);
    await flushWrites();
    expect(coverAssetIdOf(client, pageId)).toBeNull();
    expect(isCoverAsset(client, assetId)).toBe(false);
  });

  it("the collapsible element renders EVEN WHEN EMPTY — collapsed to the chevron, expanding to the Add cover card (v1)", async () => {
    const client = await seedClient();
    await ensureCoverProperty(client);
    const pageId = await client.createObject({ presentAsMain: true, name: "Empty Page" });
    await flushWrites();

    render(<PageView client={client} pageId={pageId} />);
    // The element is always there (no cover set)…
    const toggle = screen.getByRole("button", { name: "Expand cover" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // …and expanding reveals the dashed Add cover card.
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Add cover image" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Collapse cover" }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("the dedicated header element (§34.59)", () => {
  it("the cover is NOT a property row — the Properties panel suppresses it", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,HEADER");
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeCover(client, pageId, assetId);
    await flushWrites();

    const { container } = render(<PageView client={client} pageId={pageId} />);
    // The cover card renders (bytes mocked)…
    await screen.findByRole("button", { name: "Collapse cover" });
    // …but no cover property row anywhere in the metadata panel.
    expect(
      container.querySelector('[data-property-schema-id="00000000-0000-0000-0000-000000000005"]'),
    ).toBeNull();
  });

  it("an uncovered source page's Add cover strip opens the upload modal; uploading sets the cover (M33)", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,HEADER");
    await ensureCoverProperty(client);
    const [pageId] = await seedPageAndAsset(client);
    await flushWrites();

    const upload = vi.spyOn(client, "uploadAsset").mockResolvedValue({
      assetId: "asset-upload-1",
      hash: "hash-1",
      originalName: "uploaded.png",
      mimeType: "image/png",
      size: 10,
    });
    vi.spyOn(client, "attachAsset").mockResolvedValue(undefined);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    // Empty → collapsed; expand to the Add cover card; the v1 gesture opens
    // the upload modal directly (image-only).
    fireEvent.click(screen.getByRole("button", { name: "Expand cover" }));
    fireEvent.click(screen.getByRole("button", { name: "Add cover image" }));
    const dialog = await screen.findByRole("dialog", { name: "Upload image" });
    // The modal's picker is image-only (acceptedTypes), not the raw input.
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toContain("image/jpeg");
    expect(input.accept).not.toContain("pdf");

    fireEvent.change(input, { target: { files: [new File(["bytes"], "uploaded.png", { type: "image/png" })] } });
    await within(dialog).findAllByText("uploaded.png");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /upload/i }));
    });
    await flushWrites();

    expect(upload).toHaveBeenCalledTimes(1);
    // The uploaded node is an ordinary asset (no cover class — §34.74) and
    // the cover points at it.
    const coverAsset = coverAssetIdOf(client, pageId)!;
    expect(client.getNode(coverAsset)?.classIds).toContain(SYSTEM_CLASS_UUIDS.asset);
    expect(isCoverAsset(client, coverAsset)).toBe(true);
    // The set cover auto-expands the card (no empty affordance remains).
    await screen.findByRole("button", { name: "Collapse cover" });
    expect(container.querySelector(".nt-covercard__empty")).toBeNull();
  });

  it("a page whose classes bind no cover schema shows no strip", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Plain" });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    expect(screen.queryByRole("button", { name: "Expand cover" })).toBeNull();
    expect(container.querySelector(".nt-covercard")).toBeNull();
  });
});

describe("the global cover (owner bug 2026-10-04: any page, like v1)", () => {
  it("a NON-source page offers Add cover (modal) and the banner once set", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,GLOBAL");
    await ensureCoverProperty(client);
    const pageId = await client.createObject({ presentAsMain: true, name: "Wartortle" });
    await flushWrites();

    vi.spyOn(client, "uploadAsset").mockResolvedValue({
      assetId: "asset-global-1",
      hash: "hash-g",
      originalName: "sprite.png",
      mimeType: "image/png",
      size: 10,
    });
    vi.spyOn(client, "attachAsset").mockResolvedValue(undefined);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand cover" }));
    fireEvent.click(screen.getByRole("button", { name: "Add cover image" }));
    const dialog = await screen.findByRole("dialog", { name: "Upload image" });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(["bytes"], "sprite.png", { type: "image/png" })] },
    });
    await within(dialog).findAllByText("sprite.png");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /upload/i }));
    });
    await flushWrites();

    // The value rides unbound (no class binds cover on this page) but the
    // card renders — the cover is header chrome for EVERY page, like v1.
    const coverAsset = coverAssetIdOf(client, pageId)!;
    expect(coverAsset).not.toBeNull();
    expect(client.getNode(coverAsset)?.classIds).toContain(SYSTEM_CLASS_UUIDS.asset);
    await screen.findByRole("button", { name: "Collapse cover" });
    expect(container.querySelector(".nt-covercard")).not.toBeNull();
  });

  it("the Change path keeps the pick-existing flow (the CoverPicker)", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,CHANGE");
    await ensureCoverProperty(client);
    const [pageId, firstAsset] = await seedPageAndAsset(client);
    const secondAsset = await client.createObject({ presentAsMain: true, name: "other.png" });
    await client.assignClass(firstAsset, SYSTEM_CLASS_UUIDS.asset);
    await client.assignClass(secondAsset, SYSTEM_CLASS_UUIDS.asset);
    await setNodeCover(client, pageId, firstAsset);
    await flushWrites();

    render(<PageView client={client} pageId={pageId} />);
    await screen.findByRole("button", { name: "Collapse cover" });
    fireEvent.click(screen.getByRole("button", { name: "Change cover" }));
    fireEvent.change(screen.getByLabelText("Search assets…"), { target: { value: "other" } });
    await flushWrites();
    fireEvent.click(
      document.querySelector(
        ".node-result-item:not(.node-result-item--create):not(.node-result-item--date)",
      )!,
    );
    await flushWrites();

    expect(coverAssetIdOf(client, pageId)).toBe(secondAsset);
    expect(isCoverAsset(client, secondAsset)).toBe(true);
  });
});

describe("the v1-parity cover (§34.72: placeholder shell + drag-and-drop)", () => {
  it("a cover whose asset has NO image bytes renders the dashed shell naming the asset — never a silent void (the Wartortle case)", async () => {
    const client = await seedClient();
    // getAssetDataUrl resolves null: no node_asset bytes for this node.
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeCover(client, pageId, assetId);
    await flushWrites();

    const { container } = render(<PageView client={client} pageId={pageId} />);
    // The card renders with the asset's name + the toolbar…
    expect(container.querySelector(".nt-covercard")).not.toBeNull();
    expect(container.querySelector(".nt-covercard__placeholder")).not.toBeNull();
    expect(container.querySelector(".nt-covercard__placeholder-name")?.textContent).toBe(
      "cover.png",
    );
    // …and the cover is still changeable/removable, not invisible.
    expect(screen.getByRole("button", { name: "Change cover" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Remove cover" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove cover" }));
    await flushWrites();
    expect(coverAssetIdOf(client, pageId)).toBeNull();
  });

  it("dropping an image file on the Add cover strip uploads and sets the cover (the v1 drag-and-drop)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Drop Target" });
    await ensureCoverProperty(client);
    await flushWrites();

    const upload = vi.spyOn(client, "uploadAsset").mockResolvedValue({
      assetId: "asset-1",
      hash: "hash-1",
      originalName: "dropped.png",
      mimeType: "image/png",
      size: 10,
    });
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,DROP");
    const attach = vi.spyOn(client, "attachAsset").mockResolvedValue(undefined);

    const { container } = render(<PageView client={client} pageId={pageId} />);
    const card = container.querySelector(".nt-covercard")!;
    const file = new File(["bytes"], "dropped.png", { type: "image/png" });
    fireEvent.drop(card, { dataTransfer: { files: [file], types: ["Files"] } });
    await flushWrites();

    expect(upload).toHaveBeenCalledWith(file, "dropped.png");
    expect(attach).toHaveBeenCalled();
    // The uploaded node is an ordinary asset (no cover class — §34.74).
    const coverAsset = coverAssetIdOf(client, pageId)!;
    expect(client.getNode(coverAsset)?.classIds).toContain(SYSTEM_CLASS_UUIDS.asset);
    // The set cover auto-expands the card with the image.
    await screen.findByRole("button", { name: "Collapse cover" });
    expect(container.querySelector(".nt-covercard__img")).not.toBeNull();
  });
});
