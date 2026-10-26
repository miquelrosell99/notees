/**
 * markdown-file flow specs — the v1 `POST /import/markdown` semantics
 * (spec §2): frontmatter grammar via @notees/export, title precedence
 * (frontmatter title → name → first `# ` heading → "Untitled"), the
 * frontmatter uuid honored through a client-supplied id with the
 * block | return_existing conflict modes, classes resolved by uuid or
 * case-insensitive name (unknown fails loud), the body appended as ONE
 * child block (markdown-inline parsed), and frontmatter properties
 * matched to schemas by name with typed coercion (unpreparable values
 * land in the warning list, never fatal).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { importMarkdownFile } from "../src/features/import/flows/markdown-file.js";

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

function textOf(client: WorkspaceClient, nodeId: string): string {
  const node = client.getNode(nodeId);
  if (node === undefined) throw new Error("node missing");
  return node.contentAst
    .map((token) => ("text" in token ? token.text : ""))
    .join("");
}

describe("importMarkdownFile", () => {
  it("creates the node with the frontmatter uuid and title precedence over name", async () => {
    const client = await seedClient();
    const id = "0192a000-0000-7000-8000-0000000000aa";
    const report = await importMarkdownFile(client, {
      content: [
        "---",
        "uuid: 0192a000-0000-7000-8000-0000000000aa",
        "name: Ignored name",
        "title: From Frontmatter",
        "---",
        "",
        "# A heading",
        "",
        "Body **text**.",
      ].join("\n"),
    });
    expect(report.created).toEqual([{ id, title: "From Frontmatter" }]);
    const node = client.getNode(id)!;
    expect(textOf(client, id)).toBe("From Frontmatter");
    // The body lands as ONE child block, markdown-inline parsed.
    expect(node.contentAst[0]).toEqual({ type: "text", text: "From Frontmatter" });
    const children = client.getChildren(id);
    expect(children).toHaveLength(1);
    expect(children[0]!.contentAst).toEqual([
      { type: "heading", children: [{ type: "text", text: "A heading" }] },
      { type: "text", text: "Body " },
      { type: "text", text: "text", marks: ["bold"] },
      { type: "text", text: "." },
    ]);
  });

  it("falls back to the first # heading, then Untitled", async () => {
    const client = await seedClient();
    const byHeading = await importMarkdownFile(client, {
      content: "  \n# My Heading\n\nSome text.\n",
    });
    expect(byHeading.created[0]!.title).toBe("My Heading");

    const untitled = await importMarkdownFile(client, {
      content: "Just a paragraph, no heading at all.\n",
    });
    expect(untitled.created[0]!.title).toBe("Untitled");
  });

  it("blocks on an existing uuid by default and reports it with return_existing", async () => {
    const client = await seedClient();
    const existing = await client.createObject({ name: "Already here" });
    const content = `---\nuuid: ${existing}\ntitle: Nope\n---\n\nBody\n`;
    await expect(importMarkdownFile(client, { content })).rejects.toThrow(/already exists/);

    const report = await importMarkdownFile(client, {
      content,
      uuidConflictMode: "return_existing",
    });
    expect(report.existing).toEqual([{ id: existing, title: "Already here" }]);
    expect(report.created).toHaveLength(0);
    // Nothing was overwritten.
    expect(textOf(client, existing)).toBe("Already here");
  });

  it("assigns classes by uuid or case-insensitive name; unknown fails loud", async () => {
    const client = await seedClient();
    const cls = await client.createClass("Book");
    const byName = await importMarkdownFile(client, {
      content: "---\nclasses:\n  - book\n---\n\nBody\n",
    });
    expect(client.getNode(byName.created[0]!.id)!.classIds).toContain(cls);

    const byUuid = await importMarkdownFile(client, {
      content: `---\nclasses:\n  - uuid: ${cls}\n---\n\nBody\n`,
    });
    expect(client.getNode(byUuid.created[0]!.id)!.classIds).toContain(cls);

    await expect(
      importMarkdownFile(client, { content: "---\nclasses:\n  - nope\n---\n\nBody\n" }),
    ).rejects.toThrow(/unknown class/i);
  });

  it("writes properties matched by name with typed coercion; unresolvable values warn", async () => {
    const client = await seedClient();
    const pages = await client.createPropertySchema({ name: "pages", type: "number" });
    const status = await client.createPropertySchema({
      name: "status",
      type: "select",
      options: [
        { id: "opt-backlog", label: "Backlog" },
        { id: "opt-done", label: "Done" },
      ],
    });
    const published = await client.createPropertySchema({
      name: "published",
      type: "datetime",
    });
    const count = await client.createPropertySchema({ name: "count", type: "number" });
    const ref = await client.createPropertySchema({ name: "ref", type: "object" });
    const target = await client.createObject({ name: "Target Page" });

    const report = await importMarkdownFile(client, {
      content: [
        "---",
        "properties:",
        "  pages: 120",
        "  status: Done",
        "  published: 2026-10-26",
        `  ref: ${target}`,
        "  count: abc",
        "  bogus: value",
        "---",
        "",
        "Body",
      ].join("\n"),
    });

    const id = report.created[0]!.id;
    const valueOf = (schemaId: string) =>
      client
        .getEffectiveProperties(id)
        .find((row) => row.propertySchemaId === schemaId && row.source === "authored")?.value;
    expect(valueOf(pages)).toBe(120);
    expect(valueOf(status)).toBe("opt-done");
    expect(valueOf(published)).toMatchObject({ nodeId: expect.any(String) });
    expect(valueOf(ref)).toEqual({ nodeId: target });
    // The bad number and the unknown schema name warn, never fatal.
    expect(report.warnings.some((w) => w.includes("count"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("bogus"))).toBe(true);
    expect(client.getNode(id)).not.toBeUndefined();
  });

  it("applies the icon and color node fields after create", async () => {
    const client = await seedClient();
    const report = await importMarkdownFile(client, {
      content: "---\nicon: mdi-book\ncolor: red\n---\n\nBody\n",
    });
    const node = client.getNode(report.created[0]!.id)!;
    expect(node.icon).toBe("mdi-book");
    expect(node.color).toBe("red");
  });

  it("fails loud on invalid frontmatter YAML", async () => {
    const client = await seedClient();
    await expect(
      importMarkdownFile(client, { content: "---\ntitle: [unclosed\n---\n\nBody\n" }),
    ).rejects.toThrow(/frontmatter/i);
  });
});
