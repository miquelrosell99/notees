/**
 * logseq-folder flow specs — the v1 grammar round trip through the flow's
 * pure parts (folder walk, pageMap seeding + wiki-link stubs, block
 * content → mention/asset tokens, unresolved refs staying literal) and the
 * write phase against a MemoryTransport client with an injected asset
 * upload (no server in the loop).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import {
  blockContentToContentAst,
  buildPageMap,
  countLinkTokens,
  importLogseqFolder,
  parseLogseqFolderFiles,
  type ImportedAssetRef,
} from "../src/features/import/flows/logseq-folder.js";

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

/** A File carrying a webkitRelativePath (jsdom's File has none). */
function folderFile(relPath: string, content: string): File {
  const file = new File([content], relPath.split("/").pop()!);
  Object.defineProperty(file, "webkitRelativePath", { value: relPath });
  return file;
}

describe("parseLogseqFolderFiles", () => {
  it("walks pages/, journals/ and assets/ by webkitRelativePath", async () => {
    const parsed = await parseLogseqFolderFiles([
      folderFile("Graph/pages/alpha.md", "title:: x\n- A\n  - B\n- [[beta]]\n"),
      folderFile("Graph/journals/2026_10_26.md", "- Journal block\n"),
      folderFile("Graph/journals/not_a_date.md", "- ignored\n"),
      folderFile("Graph/assets/pic.png", "bytes"),
      folderFile("Graph/logseq/config.edn", "(ignored)"),
      new File(["loose"], "loose.md"),
    ]);
    expect(parsed.pages.map((p) => p.title)).toEqual(["alpha"]);
    expect(parsed.journals.map((p) => p.title)).toEqual(["2026_10_26"]);
    expect(parsed.journals[0]!.journalDate).toBe("2026-10-26");
    expect([...parsed.allLinks]).toEqual(["beta"]);
    expect([...parsed.assetFiles.keys()]).toEqual(["pic.png"]);
  });
});

describe("buildPageMap", () => {
  it("seeds explicit pages first, then wiki-link targets get stubs", () => {
    const parsed = {
      pages: [
        { title: "Alpha", properties: {}, blocks: [] },
        { title: "Beta", properties: {}, blocks: [] },
      ],
      journals: [],
      allLinks: new Set(["beta", "Gamma", " ALPHA "]),
    };
    let n = 0;
    const map = buildPageMap(parsed, () => `id-${n++}`);
    expect(map.get("alpha")).toBe("id-0");
    expect(map.get("beta")).toBe("id-1");
    // "beta" (lowercase) and "Gamma" were not pages → stubs.
    expect(map.get("gamma")).toBe("id-2");
    expect([...map.keys()].sort()).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("blockContentToContentAst", () => {
  const pageMap = new Map([["beta", "node-beta"]]);
  const assetMap = new Map<string, ImportedAssetRef>([["pic.png", { assetId: "asset-1" }]]);

  it("turns resolved [[links]] into mentions and keeps unresolved ones literal", () => {
    const ast = blockContentToContentAst("see [[beta]] and [[missing]]", pageMap, assetMap);
    expect(ast).toEqual([
      { type: "text", text: "see " },
      { type: "mention", targetNodeId: "node-beta" },
      { type: "text", text: " and " },
      { type: "text", text: "[[missing]]" },
    ]);
    expect(countLinkTokens(ast)).toBe(1);
  });

  it("turns pure-asset blocks and inline asset refs into asset_ref tokens", () => {
    expect(blockContentToContentAst("![p](../assets/pic.png){:width 100}", pageMap, assetMap)).toEqual([
      { type: "asset_ref", assetId: "asset-1" },
    ]);
    const inline = blockContentToContentAst("a ![i](../assets/pic.png) b", pageMap, assetMap);
    expect(inline).toEqual([
      { type: "text", text: "a " },
      { type: "asset_ref", assetId: "asset-1" },
      { type: "text", text: " b" },
    ]);
    // Unresolvable asset refs stay literal.
    expect(blockContentToContentAst("![x](../assets/nope.png)", pageMap, assetMap)).toEqual([
      { type: "text", text: "![x](../assets/nope.png)" },
    ]);
  });

  it("joins multi-line blocks with hard breaks", () => {
    const ast = blockContentToContentAst("first\nsecond", pageMap, assetMap);
    expect(ast).toEqual([
      { type: "text", text: "first" },
      { type: "hard_break" },
      { type: "text", text: "second" },
    ]);
  });
});

describe("importLogseqFolder", () => {
  it("writes pages, nested blocks, mentions, stubs and journal pages under the day chain", async () => {
    const client = await seedClient();
    const uploaded: Array<{ name: string }> = [];
    const parsed = await parseLogseqFolderFiles([
      folderFile("Graph/pages/alpha.md", "- A\n  - B [[beta]]\n"),
      folderFile("Graph/journals/2026_10_26.md", "- J1\n- J2\n"),
    ]);
    const report = await importLogseqFolder(client, parsed, {
      uploadAsset: async (file) => {
        uploaded.push({ name: file.name });
        return { assetId: `asset-${uploaded.length}` };
      },
    });
    expect(report.errors).toEqual([]);
    // alpha + beta(stub) + 2026_10_26 journal page.
    expect(report.pagesCreated).toBe(3);
    expect(report.blocksCreated).toBe(4);
    expect(report.linksCreated).toBe(1);

    const alpha = client.resolveNodeByName("alpha");
    expect(alpha).not.toBeNull();
    const beta = client.resolveNodeByName("beta");
    expect(beta).not.toBeNull();
    // Nested block with the mention token.
    const tree = client.getBlockTree(alpha!);
    const first = tree[0]!;
    expect(first.node.contentAst).toEqual([{ type: "text", text: "A" }]);
    const child = first.children[0]!;
    expect(child.node.contentAst).toContainEqual({ type: "mention", targetNodeId: beta });

    // Journal page under the deterministic 2026-10-26 day node.
    const journalPage = client.resolveNodeByName("2026_10_26");
    expect(journalPage).not.toBeNull();
    const journalNode = client.getNode(journalPage!)!;
    expect(journalNode.parentId).not.toBeNull();
    const parent = client.getNode(journalNode.parentId!)!;
    expect(parent.classIds.length).toBeGreaterThan(0);
    const dayChildren = client.getChildren(journalNode.parentId!);
    expect(dayChildren.some((c) => c.id === journalPage)).toBe(true);
  });

  it("reports a missing asset file without aborting the page writes", async () => {
    const client = await seedClient();
    const parsed = await parseLogseqFolderFiles([
      folderFile("Graph/pages/alpha.md", "- ![x](../assets/gone.png)\n"),
    ]);
    const report = await importLogseqFolder(client, parsed, {
      uploadAsset: async () => {
        throw new Error("should not be called");
      },
    });
    expect(report.assetsUploaded).toBe(0);
    expect(report.errors.some((e) => e.includes("gone.png"))).toBe(true);
    expect(report.pagesCreated).toBe(1);
    expect(report.blocksCreated).toBe(1);
  });
});
