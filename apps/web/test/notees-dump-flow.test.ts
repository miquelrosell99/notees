/**
 * notees-dump flow specs — the pure halves (no server in the loop):
 * `parseNoteesDump` validates the picked export (zip traversal guard,
 * dump.json at the root, the .json branch, bundled-asset counting) and
 * `composeDumpEnvelopes` replays the archive as op envelopes in a
 * deterministic order — schemas first, classes, then content nodes
 * parent-before-child with sibling afterId chains, values last.
 */

import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";

import type { JsonArchive, JsonArchiveNode } from "@notees/export";

import {
  composeDumpEnvelopes,
  parseNoteesDump,
} from "../src/features/import/flows/notees-dump.js";

function archiveFixture(): JsonArchive {
  const classNode: JsonArchiveNode = {
    id: "aaaaaaaa-0000-4000-8000-000000000c1a",
    isClass: true,
    isEmbedded: false,
    parentId: null,
    displayName: "Book",
    contentAst: [{ type: "text", text: "Book" }],
    classIds: [],
    properties: [],
    children: [],
    edges: [],
    coverAssetId: null,
    bannerAssetId: null,
    aliasedNodeId: null,
  };
  const parent: JsonArchiveNode = {
    id: "bbbbbbbb-0000-4000-8000-0000000000b1",
    isClass: false,
    isEmbedded: false,
    parentId: null,
    displayName: "Parent",
    contentAst: [{ type: "text", text: "Parent" }],
    classIds: [classNode.id],
    properties: [
      {
        schemaId: "cccccccc-0000-4000-8000-00000000000c",
        schemaName: "Pages",
        schemaType: "number",
        value: 42,
      },
    ],
    children: [
      "dddddddd-0000-4000-8000-0000000000d1",
      "eeeeeeee-0000-4000-8000-0000000000e2",
    ],
    edges: [],
    coverAssetId: null,
    bannerAssetId: null,
    aliasedNodeId: null,
  };
  const child1: JsonArchiveNode = {
    id: "dddddddd-0000-4000-8000-0000000000d1",
    isClass: false,
    isEmbedded: true,
    parentId: parent.id,
    displayName: "First",
    contentAst: [{ type: "text", text: "First" }],
    classIds: [],
    properties: [],
    children: [],
    edges: [],
    coverAssetId: null,
    bannerAssetId: null,
    aliasedNodeId: null,
  };
  const child2: JsonArchiveNode = {
    ...child1,
    id: "eeeeeeee-0000-4000-8000-0000000000e2",
    displayName: "Second",
    contentAst: [{ type: "text", text: "Second" }],
  };
  return {
    format: "notees-json-archive",
    version: 2,
    generatedAt: "2026-10-26T00:00:00.000Z",
    nodes: [classNode, parent, child1, child2],
  };
}

const ENVELOPE_CTX = {
  workspaceId: "00000000-0000-7000-8000-0000000000d1",
  actorId: "00000000-0000-7000-8000-0000000000d2",
  deviceId: "00000000-0000-7000-8000-0000000000d3",
  basePhysical: 1_000_000,
};

describe("parseNoteesDump", () => {
  it("accepts a bare .json archive", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(archiveFixture()));
    const { archive, assetCount } = parseNoteesDump("dump.json", bytes);
    expect(archive.nodes).toHaveLength(4);
    expect(assetCount).toBe(0);
  });

  it("rejects a .json that is not a Notees archive", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ hello: 1 }));
    expect(() => parseNoteesDump("dump.json", bytes)).toThrow(/not a Notees workspace export/);
  });

  it("rejects an unsupported extension", () => {
    expect(() => parseNoteesDump("notes.txt", new TextEncoder().encode("x"))).toThrow(
      /Unsupported file type/,
    );
  });

  it("reads dump.json from a zip and counts the bundled assets", () => {
    const bytes = zipSync({
      "dump.json": new TextEncoder().encode(JSON.stringify(archiveFixture())),
      "assets/photo.png": new Uint8Array([1, 2, 3]),
      "assets/clip.mp3": new Uint8Array([4, 5]),
      "pages/notes.md": new TextEncoder().encode("# stray"),
    });
    const { archive, assetCount } = parseNoteesDump("export.zip", bytes);
    expect(archive.nodes).toHaveLength(4);
    expect(assetCount).toBe(2);
  });

  it("requires dump.json at the zip root", () => {
    const bytes = zipSync({ "assets/photo.png": new Uint8Array([1]) });
    expect(() => parseNoteesDump("export.zip", bytes)).toThrow(/no "dump\.json"/);
  });

  it("refuses path-traversal and absolute entries outright", () => {
    const good = new TextEncoder().encode(JSON.stringify(archiveFixture()));
    const traversal = zipSync({ "dump.json": good, "../evil.txt": new Uint8Array([1]) });
    expect(() => parseNoteesDump("export.zip", traversal)).toThrow(/unsafe path/);
    const absolute = zipSync({ "dump.json": good, "/etc/passwd": new TextEncoder().encode("x") });
    expect(() => parseNoteesDump("export.zip", absolute)).toThrow(/unsafe path/);
  });

  it("rejects archives newer than the app supports", () => {
    const future = { ...archiveFixture(), version: 99 };
    const bytes = new TextEncoder().encode(JSON.stringify(future));
    expect(() => parseNoteesDump("dump.json", bytes)).toThrow(/newer than this app/);
  });
});

describe("composeDumpEnvelopes", () => {
  it("replays schemas first, classes, then nodes parent-before-child, values with their node", () => {
    const envelopes = composeDumpEnvelopes(archiveFixture(), ENVELOPE_CTX);
    const opTypes = envelopes.map((e) => e.opType);
    // propertySchema.create precedes every object create; class.create
    // precedes the content nodes; the property.set rides after its node.
    const firstObjectCreate = opTypes.indexOf("object.create");
    expect(opTypes.indexOf("propertySchema.create")).toBeLessThan(firstObjectCreate);
    expect(opTypes.indexOf("class.create")).toBeLessThan(firstObjectCreate);
    const setIdx = opTypes.indexOf("property.set");
    expect(setIdx).toBeGreaterThan(firstObjectCreate);

    // Parent before child.
    const creates = envelopes.filter((e) => e.opType === "object.create");
    const payloadOf = (e: (typeof envelopes)[number]): Record<string, unknown> =>
      e.payload as Record<string, unknown>;
    const ids = creates.map((e) => payloadOf(e).objectId as string);
    expect(ids.indexOf("bbbbbbbb-0000-4000-8000-0000000000b1")).toBeLessThan(
      ids.indexOf("dddddddd-0000-4000-8000-0000000000d1"),
    );
  });

  it("anchors siblings with afterId from the archive's children order", () => {
    const envelopes = composeDumpEnvelopes(archiveFixture(), ENVELOPE_CTX);
    const creates = envelopes.filter((e) => e.opType === "object.create");
    const byId = new Map(
      creates.map((e) => {
        const p = e.payload as Record<string, unknown>;
        return [p.objectId as string, p as { afterId?: string }];
      }),
    );
    expect(byId.get("dddddddd-0000-4000-8000-0000000000d1")?.afterId).toBeUndefined();
    expect(byId.get("eeeeeeee-0000-4000-8000-0000000000e2")?.afterId).toBe(
      "dddddddd-0000-4000-8000-0000000000d1",
    );
  });

  it("carries classIds only for classes declared in the archive, on a stable rising clock", () => {
    const envelopes = composeDumpEnvelopes(archiveFixture(), ENVELOPE_CTX);
    const creates = envelopes.filter((e) => e.opType === "object.create");
    const parent = creates.find(
      (e) => (e.payload as Record<string, unknown>).objectId === "bbbbbbbb-0000-4000-8000-0000000000b1",
    )!;
    expect((parent.payload as Record<string, unknown>).classIds).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000c1a",
    ]);
    const physicals = envelopes.map((e) => e.hlc.physical);
    expect([...physicals].sort((a, b) => a - b)).toEqual(physicals);
    expect(new Set(physicals).size).toBe(physicals.length);
  });
});
