/**
 * S4 — the client-side eligibility surfaces: schemaEligibility's extends-aware closure walk, the add-property
 * candidate gating, and the panel's honest ineligible-row rendering
 * (dimmed + affordance, never hidden — the authored value survives).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { PageView } from "../src/ui/PageView.js";
import {
  classClosureOf,
  eligibleSchemasForNode,
  isSchemaEligibleForNode,
} from "../src/features/metadata/schemaEligibility.js";

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

/** Flush the microtasks a fireEvent-triggered async write runs on. */
async function flushWrites(): Promise<void> {
  await act(async () => {});
}

async function createTitledClass(client: WorkspaceClient, name: string): Promise<string> {
  const id = await client.createClass(name);
  await client.updateObject(id, { contentAst: [{ type: "text", text: name }] });
  return id;
}

describe("schemaEligibility — the extends-aware closure walk (R2)", () => {
  it("null scope (global) is eligible for every node", async () => {
    const client = await seedClient();
    const schema = { scopeClassIds: null };
    const page = await client.createObject({ isEmbedded: false, name: "Orphan" });
    const node = client.getNode(page)!;
    expect(isSchemaEligibleForNode(client, schema, node)).toBe(true);
    expect(classClosureOf(client, node)).toEqual(new Set());
  });

  it("a node's own class matches; an unrelated class does not", async () => {
    const client = await seedClient();
    const fiction = await createTitledClass(client, "Fiction");
    const poetry = await createTitledClass(client, "Poetry");
    const schema = { scopeClassIds: [fiction] };
    const member = await client.createObject({ isEmbedded: false, name: "Novel" });
    await client.assignClass(member, fiction);
    const stranger = await client.createObject({ isEmbedded: false, name: "Sonnets" });
    await client.assignClass(stranger, poetry);
    expect(isSchemaEligibleForNode(client, schema, client.getNode(member)!)).toBe(true);
    expect(isSchemaEligibleForNode(client, schema, client.getNode(stranger)!)).toBe(false);
  });

  it("extends-ancestors qualify: a subclass node is eligible for the ancestor's scoped schema", async () => {
    const client = await seedClient();
    const source = await createTitledClass(client, "Source");
    const weblink = await createTitledClass(client, "Web link");
    await client.setClassExtends(weblink, [source]);
    const schema = { scopeClassIds: [source] };
    const page = await client.createObject({ isEmbedded: false, name: "Article" });
    await client.assignClass(page, weblink);
    const node = client.getNode(page)!;
    // The closure walks the extends edge (and the seeded self-row).
    expect(classClosureOf(client, node)).toEqual(new Set([weblink, source]));
    expect(isSchemaEligibleForNode(client, schema, node)).toBe(true);
  });

  it("the closure is transitive (grandparent scopes match a grandchild node)", async () => {
    const client = await seedClient();
    const a = await createTitledClass(client, "Alpha");
    const b = await createTitledClass(client, "Beta");
    const c = await createTitledClass(client, "Gamma");
    await client.setClassExtends(b, [a]);
    await client.setClassExtends(c, [b]);
    const page = await client.createObject({ isEmbedded: false, name: "Deep" });
    await client.assignClass(page, c);
    const closure = classClosureOf(client, client.getNode(page)!);
    expect(closure.has(a)).toBe(true);
    expect(closure.has(b)).toBe(true);
    expect(closure.has(c)).toBe(true);
    expect(isSchemaEligibleForNode(client, { scopeClassIds: [a] }, client.getNode(page)!)).toBe(true);
  });

  it("eligibleSchemasForNode filters a mixed candidate list", async () => {
    const client = await seedClient();
    const fiction = await createTitledClass(client, "Fiction");
    await createTitledClass(client, "Poetry");
    const globalSchema = await client.createPropertySchema({ name: "Title", type: "text" });
    const localSchema = await client.createPropertySchema({
      name: "ISBN",
      type: "text",
      scopeClassIds: [fiction],
    });
    const member = await client.createObject({ isEmbedded: false, name: "Novel" });
    await client.assignClass(member, fiction);
    const stranger = await client.createObject({ isEmbedded: false, name: "Sonnets" });
    await client.assignClass(stranger, await createTitledClass(client, "Zine"));

    const all = client.listPropertySchemas().filter((s) => s.id === globalSchema || s.id === localSchema);
    const memberEligible = eligibleSchemasForNode(client, all, client.getNode(member)!);
    expect(memberEligible.map((s) => s.id).sort()).toEqual([globalSchema, localSchema].sort());
    const strangerEligible = eligibleSchemasForNode(client, all, client.getNode(stranger)!);
    expect(strangerEligible.map((s) => s.id)).toEqual([globalSchema]);
  });
});

describe("S4 picker gating — the add-property popup offers eligible schemas only", () => {
  it("a scope-excluded schema is not listed; the Create row still is", async () => {
    const client = await seedClient();
    const fiction = await createTitledClass(client, "Fiction");
    await client.createPropertySchema({ name: "ISBN", type: "text", scopeClassIds: [fiction] });
    await client.createPropertySchema({ name: "Mood", type: "text" });
    const plain = await client.createObject({ isEmbedded: false, name: "Diary" });

    render(<PageView client={client} pageId={plain} />);
    await flushWrites();
    fireEvent.click(screen.getByRole("button", { name: /add property/i }));
    const popup = screen.getByRole("dialog", { name: "Add property" });
    expect(popup.textContent).toContain("Mood");
    expect(popup.textContent).not.toContain("ISBN");
    // The create row rides (a new schema can be scoped to this node's classes).
    fireEvent.change(popup.querySelector("input")!, { target: { value: "Vibe" } });
    expect(popup.textContent).toContain('Create property "Vibe"');
  });
});

describe("S4 panel rendering — an eligible:false row renders honestly (R4)", () => {
  it("an authored value that outlived its class renders dimmed, never hidden", async () => {
    const client = await seedClient();
    const fiction = await createTitledClass(client, "Fiction");
    const schemaId = await client.createPropertySchema({
      name: "ISBN",
      type: "text",
      scopeClassIds: [fiction],
    });
    const page = await client.createObject({ isEmbedded: false, name: "Novel" });
    await client.assignClass(page, fiction);
    await client.setProperty(page, schemaId, "978-3-16-148410-0", 0);
    // Narrow the world: the class leaves, the authored value survives.
    await client.unassignClass(page, fiction);
    await flushWrites();

    const rows = client.getEffectiveProperties(page);
    expect(rows.some((row) => row.propertySchemaId === schemaId && row.eligible === false)).toBe(true);

    const { container } = render(<PageView client={client} pageId={page} />);
    await flushWrites();
    const ineligible = container.querySelectorAll(".nt-property-ineligible");
    expect(ineligible.length).toBeGreaterThan(0);
    expect(container.querySelector(`[data-property-schema-id="${schemaId}"]`)).not.toBeNull();
  });
});
