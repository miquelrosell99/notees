/**
 * Properties panel tests (SCHEMA.md "Class properties"): Page/Block views
 * render the effective-properties panel — derived defaults dimmed with a
 * "default" hint, editing a default writes an authored property.set that
 * shadows it, multi-class conflicts show the first-applied winner, and
 * clearing the authored value lets the default resurface.
 * jsdom over the in-process WorkspaceClient.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { PageView } from "../src/ui/PageView.js";

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

/** Expand the page's "Properties N" section (collapsed by default in the note layout). */
function expandProperties(): void {
  const header = screen.queryByRole("button", { name: /^Properties / });
  if (header !== null && header.getAttribute("aria-expanded") === "false") {
    fireEvent.click(header);
  }
}

/** Seed priority-bound Task + Project classes (Task applied first by callers). */
async function seedPriorityClasses(client: WorkspaceClient) {
  const schemaId = await client.createPropertySchema({ name: "priority", type: "select" });
  const taskId = await client.createClass("Task");
  const projectId = await client.createClass("Project");
  // WORKAROUND(store applier): class.create's contentAst never lands in the
  // class node's content (the upsert's LWW update loses against the row its
  // own INSERT wrote); object.update's later-HLC path persists. Remove once
  // the applier is fixed.
  await client.updateObject(taskId, { contentAst: [{ type: "text", text: "Task" }] });
  await client.updateObject(projectId, { contentAst: [{ type: "text", text: "Project" }] });
  await client.setClassProperty(taskId, schemaId, { sequence: 0, defaultValue: "medium" });
  await client.setClassProperty(projectId, schemaId, { sequence: 0, defaultValue: "high" });
  return { schemaId, taskId, projectId };
}

describe("Properties panel (effective values)", () => {
  it("shows a derived default dimmed with a 'default' hint", async () => {
    const client = await seedClient();
    const { schemaId, taskId } = await seedPriorityClasses(client);
    const pageId = await client.createObject({ presentAsMain: true, name: "Ship it" });
    await client.assignClass(pageId, taskId);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    expandProperties();
    const row = container.querySelector(".nt-property")!;
    expect(row.className).toContain("nt-property-default");
    expect(row.textContent).toContain("priority");
    expect(row.textContent).toContain("default");
    const input = screen.getByLabelText("Property priority") as HTMLInputElement;
    expect(input.value).toBe("medium");
    // The read model agrees: derived, bound by Task, no authored row.
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: "medium", source: "default", boundBy: taskId }),
    ]);
  });

  it("still renders the section when the node has no effective properties (always-visible metadata)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Plain" });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    expect(container.querySelector(".nt-properties-panel")).not.toBeNull();
  });

  it("editing a default writes an authored value that shadows it", async () => {
    const client = await seedClient();
    const { schemaId, taskId } = await seedPriorityClasses(client);
    const pageId = await client.createObject({ presentAsMain: true, name: "Ship it" });
    await client.assignClass(pageId, taskId);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    fireEvent.blur(screen.getByLabelText("Property priority"), { target: { value: "urgent" } });
    await flushWrites();

    const effective = client.getEffectiveProperties(pageId);
    expect(effective).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: "urgent", source: "authored", boundBy: taskId }),
    ]);
    const row = container.querySelector(".nt-property")!;
    expect(row.className).not.toContain("nt-property-default");
    expect(row.textContent).not.toContain("default");

    // Clearing the authored value lets the derived default resurface.
    await act(async () => {
      await client.unsetProperty(pageId, schemaId);
    });
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ value: "medium", source: "default", boundBy: taskId }),
    ]);
  });

  it("multi-class conflict shows the first-applied class's value", async () => {
    const client = await seedClient();
    const { taskId, projectId } = await seedPriorityClasses(client);
    const pageId = await client.createObject({ presentAsMain: true, name: "Ship it" });
    // Task is assigned first: its 'medium' beats Project's 'high'.
    await client.assignClass(pageId, taskId);
    await client.assignClass(pageId, projectId);
    render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    const input = screen.getByLabelText("Property priority") as HTMLInputElement;
    expect(input.value).toBe("medium");
    expect(input.closest(".nt-property")!.textContent).toContain("default");

    // On a page where Project was applied first, Project's default wins.
    const otherId = await client.createObject({ presentAsMain: true, name: "Other" });
    await client.assignClass(otherId, projectId);
    await client.assignClass(otherId, taskId);
    expect(client.getEffectiveProperties(otherId)).toEqual([
      expect.objectContaining({ value: "high", source: "default", boundBy: projectId }),
    ]);
  });

  it("renders the node's classes as chips; the × unassigns — the default drops, an authored value survives unbound", async () => {
    const client = await seedClient();
    const { schemaId, taskId, projectId } = await seedPriorityClasses(client);
    // 'effort' is bound ONLY on Task: its authored value must survive the
    // unassign with boundBy null (no remaining class binds it).
    const effortSchemaId = await client.createPropertySchema({ name: "effort", type: "text" });
    await client.setClassProperty(taskId, effortSchemaId, { sequence: 1, defaultValue: "xs" });

    const pageId = await client.createObject({ presentAsMain: true, name: "Ship it" });
    await client.assignClass(pageId, taskId);
    await client.assignClass(pageId, projectId);
    await client.setProperty(pageId, effortSchemaId, "authored", 0);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    // Both classes render as pills, each with a remove affordance.
    expect(container.querySelectorAll(".nt-classes-row .pill:not(.pill--add)").length).toBe(2);
    expect(screen.getByRole("button", { name: "Remove class Task" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Remove class Project" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove class Task" }));
    await flushWrites();

    // class.unassign: membership tombstoned, class_ids recomputed.
    expect(client.getNode(pageId)?.classIds).toEqual([projectId]);
    // The panel re-renders: Task's pill is gone.
    expect(container.querySelectorAll(".nt-classes-row .pill:not(.pill--add)").length).toBe(1);
    expect(screen.queryByRole("button", { name: "Remove class Task" })).toBeNull();

    // The read model: Task's derived defaults are gone; Project's 'high'
    // resurfaces for priority (still bound), and the authored effort value
    // survives marked unbound (boundBy null).
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: "high", source: "default", boundBy: projectId }),
      expect.objectContaining({ propertySchemaId: effortSchemaId, value: "authored", source: "authored", boundBy: null }),
    ]);
    expect(screen.getByText("unbound")).not.toBeNull();
  });
});

describe("carrier blocks vs the child block list", () => {
  it("getBlockTree excludes blocks referenced as property values (no duplicate)", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "notes", type: "object" });
    const owner = await client.createObject({ presentAsMain: true, name: "Owner" });
    const carrier = await client.createObject({
      parentId: owner,
      contentAst: [{ type: "text", text: "Carrier text" }],
    });
    await client.setProperty(owner, schemaId, { nodeId: carrier }, 0);
    const tree = client.getBlockTree(owner);
    expect(tree.map((entry) => entry.node.id)).not.toContain(carrier);
    // The block still exists and resolves (the property cell renders it).
    expect(client.getNode(carrier)?.contentAst).toEqual([{ type: "text", text: "Carrier text" }]);
  });

  it("text properties whose scalar value IS a carrier block uuid are excluded too", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "notas", type: "text" });
    const owner = await client.createObject({ presentAsMain: true, name: "Owner" });
    const carrier = await client.createObject({
      parentId: owner,
      contentAst: [{ type: "text", text: "Scalar carrier" }],
    });
    await client.setProperty(owner, schemaId, carrier, 0);
    expect(client.getBlockTree(owner).map((entry) => entry.node.id)).not.toContain(carrier);
  });
});

describe("PB3: per-subtree carrier exclusion", () => {
  it("a nested block's own carrier is excluded from the NESTED body", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "notes", type: "text" });
    const owner = await client.createObject({ presentAsMain: true, name: "Owner" });
    const outer = await client.createObject({
      parentId: owner,
      contentAst: [{ type: "text", text: "outer block" }],
    });
    const nestedCarrier = await client.createObject({
      parentId: outer,
      contentAst: [{ type: "text", text: "nested carrier" }],
    });
    await client.setProperty(outer, schemaId, { nodeId: nestedCarrier }, 0);
    // The outer block renders; its body excludes its own carrier (the
    // pre-fix page-level set leaked it back into the body at depth).
    const tree = client.getBlockTree(owner);
    expect(tree.map((entry) => entry.node.id)).toEqual([outer]);
    expect(tree[0]!.children.map((entry) => entry.node.id)).toEqual([]);
    // The carrier itself is untouched and resolves.
    expect(client.getNode(nestedCarrier)?.contentAst).toEqual([{ type: "text", text: "nested carrier" }]);
  });

  it("an excluded carrier's subtree is pruned with it", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "notes", type: "text" });
    const owner = await client.createObject({ presentAsMain: true, name: "Owner" });
    const carrier = await client.createObject({
      parentId: owner,
      contentAst: [{ type: "text", text: "carrier" }],
    });
    const carrierChild = await client.createObject({
      parentId: carrier,
      contentAst: [{ type: "text", text: "carrier child" }],
    });
    await client.setProperty(owner, schemaId, { nodeId: carrier }, 0);
    const ids = (entries: ReturnType<WorkspaceClient["getBlockTree"]>): string[] =>
      entries.flatMap((entry) => [entry.node.id, ...ids(entry.children)]);
    expect(ids(client.getBlockTree(owner))).not.toContain(carrier);
    expect(ids(client.getBlockTree(owner))).not.toContain(carrierChild);
  });

  it("carriers of different owners only exclude under their own subtree", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "notes", type: "text" });
    const ownerA = await client.createObject({ presentAsMain: true, name: "A" });
    const ownerB = await client.createObject({ presentAsMain: true, name: "B" });
    const carrierA = await client.createObject({ parentId: ownerA, contentAst: [{ type: "text", text: "carrier A" }] });
    const carrierB = await client.createObject({ parentId: ownerB, contentAst: [{ type: "text", text: "carrier B" }] });
    await client.setProperty(ownerA, schemaId, { nodeId: carrierA }, 0);
    await client.setProperty(ownerB, schemaId, { nodeId: carrierB }, 0);
    expect(client.getBlockTree(ownerA).map((entry) => entry.node.id)).not.toContain(carrierA);
    expect(client.getBlockTree(ownerB).map((entry) => entry.node.id)).not.toContain(carrierB);
  });
});

describe("PB2: carrier lifecycle at the client level", () => {
  it("unsetting a node-backed text property trashes the carrier", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "notes", type: "text" });
    const owner = await client.createObject({ presentAsMain: true, name: "Owner" });
    const carrier = await client.createObject({
      parentId: owner,
      contentAst: [{ type: "text", text: "carrier prose" }],
    });
    await client.setProperty(owner, schemaId, { nodeId: carrier }, 0);
    await client.unsetProperty(owner, schemaId, 0);
    expect(client.getEffectiveProperties(owner)).toEqual([]);
    // Trash + retention (SCHEMA.md): soft-deleted, recoverable via restore.
    expect(client.getNodeRaw(carrier)?.isActive).toBe(false);
    expect(client.getBlockTree(owner).map((entry) => entry.node.id)).not.toContain(carrier);
  });

  it("promotePropertyCarrier detaches the value and surfaces the carrier in the body", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "notes", type: "text" });
    const owner = await client.createObject({ presentAsMain: true, name: "Owner" });
    const carrier = await client.createObject({
      parentId: owner,
      contentAst: [{ type: "text", text: "promote me" }],
    });
    await client.setProperty(owner, schemaId, { nodeId: carrier }, 0);
    expect(client.getBlockTree(owner).map((entry) => entry.node.id)).not.toContain(carrier);
    await client.promotePropertyCarrier(owner, schemaId, 0);
    // Value detached, carrier alive, and now rendering in the body.
    expect(client.getEffectiveProperties(owner)).toEqual([]);
    expect(client.getNode(carrier)?.isActive).toBe(true);
    expect(client.getBlockTree(owner).map((entry) => entry.node.id)).toContain(carrier);
  });

  it("promotePropertyCarrier fails loud on scalar values and empty slots", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "citekey", type: "text" });
    const owner = await client.createObject({ presentAsMain: true, name: "Owner" });
    await client.setProperty(owner, schemaId, "kuhn1962", 0);
    await expect(client.promotePropertyCarrier(owner, schemaId, 0)).rejects.toThrow(
      /not a node-backed carrier reference/,
    );
    await expect(client.promotePropertyCarrier(owner, schemaId, 3)).rejects.toThrow(
      /no authored value/,
    );
    // The scalar value survived the failed promotes.
    expect(client.getEffectiveProperties(owner)).toEqual([
      expect.objectContaining({ value: "kuhn1962", source: "authored" }),
    ]);
  });

  it("promote with a second slot still referencing the carrier keeps it excluded", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "notes", type: "text" });
    const owner = await client.createObject({ presentAsMain: true, name: "Owner" });
    const carrier = await client.createObject({
      parentId: owner,
      contentAst: [{ type: "text", text: "shared carrier" }],
    });
    await client.setProperty(owner, schemaId, { nodeId: carrier }, 0);
    await client.setProperty(owner, schemaId, { nodeId: carrier }, 1);
    await client.promotePropertyCarrier(owner, schemaId, 0);
    // idx 0 detached; idx 1 still holds the carrier — it stays excluded.
    expect(client.getNode(carrier)?.isActive).toBe(true);
    expect(client.getBlockTree(owner).map((entry) => entry.node.id)).not.toContain(carrier);
    await client.promotePropertyCarrier(owner, schemaId, 1);
    expect(client.getBlockTree(owner).map((entry) => entry.node.id)).toContain(carrier);
  });
});
