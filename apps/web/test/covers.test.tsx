/**
 * Covers v2 (§34.56, owner directive 2026-10-04): the `cover` system class
 * extending `asset` — a node cover IS an asset with cover identity. The
 * class powers the "Cover" badge in card views, the asset class's
 * classed-nodes listing, and future cover logic. Classing rides EXPLICIT
 * ops from the web client's cover flows (the property value stays the
 * authority; every client converges on classIds).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";
import { NodeCollection } from "../src/ui/views/index.js";
import {
  clearNodeCover,
  COVER_CLASS_ID,
  coverAssetIdOf,
  ensureCoverFamily,
  setNodeCover,
} from "../src/ui/components/coverProperty.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
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

describe("covers v2 (§34.56)", () => {
  it("ensureCoverFamily authors the cover class extending asset + the schema + binding", async () => {
    const client = await seedClient();
    await ensureCoverFamily(client);
    await flushWrites();

    const cover = client.getNode(COVER_CLASS_ID);
    expect(cover?.isClass).toBe(true);
    expect(client.getClassParents(COVER_CLASS_ID)).toEqual([SYSTEM_CLASS_UUIDS.asset]);
    expect(
      client.listPropertySchemas().some((s) => s.id === SYSTEM_PROPERTY_UUIDS.cover),
    ).toBe(true);
    expect(
      client
        .getClassBindings(SYSTEM_CLASS_UUIDS.source)
        .some((b) => b.propertySchemaId === SYSTEM_PROPERTY_UUIDS.cover),
    ).toBe(true);

    // Idempotent: a second ensure authors nothing new.
    await ensureCoverFamily(client);
    await flushWrites();
    expect(client.getClassParents(COVER_CLASS_ID)).toEqual([SYSTEM_CLASS_UUIDS.asset]);
  });

  it("setNodeCover writes the value and classes the asset cover+asset (explicit ops)", async () => {
    const client = await seedClient();
    const [pageId, assetId] = await seedPageAndAsset(client);

    await setNodeCover(client, pageId, assetId);
    await flushWrites();

    expect(coverAssetIdOf(client, pageId)).toBe(assetId);
    const classIds = client.getNode(assetId)?.classIds ?? [];
    expect(classIds).toContain(COVER_CLASS_ID);
    expect(classIds).toContain(SYSTEM_CLASS_UUIDS.asset);
  });

  it("clearNodeCover removes the cover class only when no other node covers with the asset", async () => {
    const client = await seedClient();
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeCover(client, pageId, assetId);
    await flushWrites();

    // A second page covers with the SAME asset → clearing the first keeps
    // the cover class.
    const page2 = await client.createObject({ presentAsMain: true, name: "Also Covered" });
    await client.assignClass(page2, SYSTEM_CLASS_UUIDS.source);
    await setNodeCover(client, page2, assetId);
    await flushWrites();
    await clearNodeCover(client, pageId);
    await flushWrites();
    expect(coverAssetIdOf(client, pageId)).toBeNull();
    expect(client.getNode(assetId)?.classIds).toContain(COVER_CLASS_ID);

    // Clearing the last cover drops the class (the asset class stays).
    await clearNodeCover(client, page2);
    await flushWrites();
    const classIds = client.getNode(assetId)?.classIds ?? [];
    expect(classIds).not.toContain(COVER_CLASS_ID);
    expect(classIds).toContain(SYSTEM_CLASS_UUIDS.asset);
  });

  it("the asset class's Classed nodes lists cover assets (membership in asset)", async () => {
    const client = await seedClient();
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeCover(client, pageId, assetId);
    await flushWrites();

    const members = client.getClassMembers(SYSTEM_CLASS_UUIDS.asset);
    expect(members.map((m) => m.id)).toContain(assetId);
  });

  it("card views show the Cover badge on cover-classed assets", async () => {
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

  it("the banner toolbar offers Change cover and Remove cover", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,COVERS");
    const [pageId, assetId] = await seedPageAndAsset(client);
    await setNodeCover(client, pageId, assetId);
    await flushWrites();

    const { container } = render(<PageView client={client} pageId={pageId} />);
    await screen.findByRole("button", { name: "Collapse cover image" });
    const banner = container.querySelector(".nt-page-banner")!;
    expect(banner.querySelector('[aria-label="Change cover"]')).not.toBeNull();
    expect(banner.querySelector('[aria-label="Remove cover"]')).not.toBeNull();

    fireEvent.click(banner.querySelector('[aria-label="Remove cover"]')!);
    await flushWrites();
    expect(coverAssetIdOf(client, pageId)).toBeNull();
    expect(client.getNode(assetId)?.classIds).not.toContain(COVER_CLASS_ID);
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
    // The banner renders (bytes mocked)…
    await screen.findByRole("button", { name: "Collapse cover image" });
    // …but no cover property row anywhere in the metadata panel.
    expect(
      container.querySelector('[data-property-schema-id="00000000-0000-0000-0000-000000000005"]'),
    ).toBeNull();
  });

  it("an uncovered source page shows the Add cover strip; picking sets the cover", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,HEADER");
    await ensureCoverFamily(client);
    const [pageId, assetId] = await seedPageAndAsset(client);
    // The picker lists asset-classed nodes — class the fixture asset.
    await client.assignClass(assetId, SYSTEM_CLASS_UUIDS.asset);
    await flushWrites();

    const { container } = render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: "Add cover" }));
    fireEvent.change(screen.getByLabelText("Search assets…"), { target: { value: "cover" } });
    await flushWrites();
    fireEvent.click(
      document.querySelector(
        ".node-result-item:not(.node-result-item--create):not(.node-result-item--date)",
      )!,
    );
    await flushWrites();

    expect(coverAssetIdOf(client, pageId)).toBe(assetId);
    expect(client.getNode(assetId)?.classIds).toContain(COVER_CLASS_ID);
    // The banner chrome replaces the strip.
    await screen.findByRole("button", { name: "Collapse cover image" });
    expect(container.querySelector(".nt-add-cover")).toBeNull();
  });

  it("a page whose classes bind no cover schema shows no strip", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Plain" });

    const { container } = render(<PageView client={client} pageId={pageId} />);
    expect(screen.queryByRole("button", { name: "Add cover" })).toBeNull();
    expect(container.querySelector(".nt-add-cover")).toBeNull();
  });
});

describe("the global cover (owner bug 2026-10-04: any page, like v1)", () => {
  it("a NON-source page offers Add cover and the banner once set", async () => {
    const client = await seedClient();
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue("data:image/png;base64,GLOBAL");
    await ensureCoverFamily(client);
    const pageId = await client.createObject({ presentAsMain: true, name: "Wartortle" });
    const assetId = await client.createObject({ presentAsMain: true, name: "sprite.png" });
    await client.assignClass(assetId, SYSTEM_CLASS_UUIDS.asset);
    await flushWrites();

    const { container } = render(<PageView client={client} pageId={pageId} />);
    fireEvent.click(screen.getByRole("button", { name: "Add cover" }));
    fireEvent.change(screen.getByLabelText("Search assets…"), { target: { value: "sprite" } });
    await flushWrites();
    fireEvent.click(
      document.querySelector(
        ".node-result-item:not(.node-result-item--create):not(.node-result-item--date)",
      )!,
    );
    await flushWrites();

    // The value rides unbound (no class binds cover on this page) but the
    // banner renders — the cover is header chrome for EVERY page, like v1.
    expect(coverAssetIdOf(client, pageId)).toBe(assetId);
    await screen.findByRole("button", { name: "Collapse cover image" });
    expect(container.querySelector(".nt-page-banner")).not.toBeNull();
  });
});
