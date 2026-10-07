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

/**
 * The panelled main layout (the default) renders the properties OPEN in the
 * left side panel — there is no in-flow "Properties N" section to expand.
 * Kept as a seam for compact layouts (sidebar peeks, embedded renders),
 * where the collapsible section still hosts the table.
 */
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
    // The panelled main layout rides the left properties sidebar: the name
    // row carries the hints, the scalar value cell the editor.
    const sidebar = container.querySelector(".nt-props-sidebar")!;
    const nameRow = sidebar.querySelector(`[data-property-schema-id="${schemaId}"]`)!;
    expect(nameRow.textContent).toContain("priority");
    expect(nameRow.textContent).toContain("default");
    const input = sidebar.querySelector(`input[aria-label="Property priority"]`) as HTMLInputElement;
    expect(input.value).toBe("medium");
    // The read model agrees: derived, bound by Task, no authored row.
    expect(client.getEffectiveProperties(pageId)).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: "medium", source: "default", boundBy: taskId }),
    ]);
  });

  it("still renders the properties chrome when the node has no effective properties (always-visible metadata)", async () => {
    const client = await seedClient();
    const pageId = await client.createObject({ presentAsMain: true, name: "Plain" });
    const { container } = render(<PageView client={client} pageId={pageId} />);
    // The panelled main layout rides the left side panel (PropertiesSidebar,
    // name row + value row per property) — always rendered, even with zero
    // properties.
    const panel = container.querySelector(".nt-page-side-panel");
    expect(panel).not.toBeNull();
    expect(panel!.querySelector(".nt-props-sidebar")).not.toBeNull();
    // The column names itself: a muted "Properties" header row with the
    // effective count. A plain node carries no property rows — the retired
    // aliasOf carrier is gone (node aliases ride the aliasedNodeId wire
    // field, never a property row).
    const header = panel!.querySelector(".nt-props-sidebar__header")!;
    expect(header).not.toBeNull();
    expect(header.textContent).toContain("Properties");
    const rowCount = panel!.querySelectorAll(".nt-props-sidebar__prop").length;
    expect(header.querySelector(".nt-props-sidebar__count")!.textContent).toBe(String(rowCount));
    expect(rowCount).toBe(0);
    // The empty panel still hosts the "Add property" affordance.
    expect(screen.getByRole("button", { name: /Add property/ })).not.toBeNull();
  });

  it("editing a default writes an authored value that shadows it", async () => {
    const client = await seedClient();
    const { schemaId, taskId } = await seedPriorityClasses(client);
    const pageId = await client.createObject({ presentAsMain: true, name: "Ship it" });
    await client.assignClass(pageId, taskId);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    const sidebar = container.querySelector(".nt-props-sidebar")!;
    const input = sidebar.querySelector(`input[aria-label="Property priority"]`) as HTMLInputElement;
    fireEvent.blur(input, { target: { value: "urgent" } });
    await flushWrites();

    const effective = client.getEffectiveProperties(pageId);
    expect(effective).toEqual([
      expect.objectContaining({ propertySchemaId: schemaId, value: "urgent", source: "authored", boundBy: taskId }),
    ]);
    // The name row loses the "default" hint once the authored value wins.
    const nameRow = sidebar.querySelector(`[data-property-schema-id="${schemaId}"]`)!;
    expect(nameRow.textContent).not.toContain("default");

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
    const { schemaId, taskId, projectId } = await seedPriorityClasses(client);
    const pageId = await client.createObject({ presentAsMain: true, name: "Ship it" });
    // Task is assigned first: its 'medium' beats Project's 'high'.
    await client.assignClass(pageId, taskId);
    await client.assignClass(pageId, projectId);
    const { container } = render(<PageView client={client} pageId={pageId} />);
    expandProperties();

    const sidebar = container.querySelector(".nt-props-sidebar")!;
    const input = sidebar.querySelector(`input[aria-label="Property priority"]`) as HTMLInputElement;
    expect(input.value).toBe("medium");
    // The name row still carries the "default" hint (the value is derived).
    expect(sidebar.querySelector(`[data-property-schema-id="${schemaId}"]`)!.textContent).toContain("default");

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
    // The hint shows on the sidebar's name row (the reused value row's own
    // hint hides — the name row carries it).
    expect(screen.getAllByText("unbound").length).toBeGreaterThan(0);
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
    // PG6 cardinality: a second slot needs a multi schema.
    const schemaId = await client.createPropertySchema({ name: "notes", type: "text", multi: true });
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

describe("dead carrier in the value cell (owner bug 2026-10-04)", () => {
  it("a text property whose carrier was deleted renders EMPTY — never the raw uuid — and re-editing authors a fresh carrier", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Description", type: "text" });
    const owner = await client.createObject({ presentAsMain: true, name: "Inmunocal" });
    const carrier = await client.createObject({
      parentId: owner,
      contentAst: [{ type: "text", text: "described" }],
    });
    await client.setProperty(owner, schemaId, { nodeId: carrier }, 0);
    // Delete the carrier block (the value-cell content), like the owner did.
    await client.deleteObject(carrier);
    await flushWrites();

    render(<PageView client={client} pageId={owner} />);
    expandProperties();
    const input = screen.getByLabelText("Property Description") as HTMLInputElement;
    // The dangling ref does not surface as a uuid, here or after reload —
    // the cell is simply empty (the content is gone).
    expect(input.value).toBe("");
    expect(input.value).not.toContain(carrier);

    // Typing + blur authors a NEW carrier and re-points the value.
    fireEvent.blur(input, { target: { value: "fresh description" } });
    await flushWrites();
    const effective = client.getEffectiveProperties(owner);
    expect(effective).toHaveLength(1);
    const ref = (effective[0]!.value as { nodeId: string }).nodeId;
    expect(ref).not.toBe(carrier);
    expect(client.getNode(ref)?.contentAst).toEqual([{ type: "text", text: "fresh description" }]);
  });

  it("touching a dead-carrier cell empty unsets the dangling value", async () => {
    const client = await seedClient();
    const schemaId = await client.createPropertySchema({ name: "Description", type: "text" });
    const owner = await client.createObject({ presentAsMain: true, name: "Owner" });
    const carrier = await client.createObject({
      parentId: owner,
      contentAst: [{ type: "text", text: "gone" }],
    });
    await client.setProperty(owner, schemaId, { nodeId: carrier }, 0);
    await client.deleteObject(carrier);
    await flushWrites();

    render(<PageView client={client} pageId={owner} />);
    expandProperties();
    const input = screen.getByLabelText("Property Description");
    fireEvent.blur(input, { target: { value: "" } });
    await flushWrites();
    expect(client.getEffectiveProperties(owner)).toEqual([]);
  });
});

describe("default-mirror sweep on class removal (owner rule)", () => {
  it("unassigning a class removes authored values that merely mirror its defaults; differing values survive", async () => {
    const client = await seedClient();
    // A task-like class: status bound with defaultValue "pending".
    const statusSchema = await client.createPropertySchema({
      name: "status",
      type: "select",
      options: [
        { id: "opt-pending", label: "Pending" },
        { id: "opt-done", label: "Done" },
      ],
    });
    const taskClass = await client.createClass("taskish");
    await client.setClassProperty(taskClass, statusSchema, {
      sequence: 0,
      defaultValue: "opt-pending",
    });

    // Node A: authored value == the default (materialized legacy data).
    const nodeA = await client.createObject({ presentAsMain: true, name: "A" });
    await client.assignClass(nodeA, taskClass);
    await client.setProperty(nodeA, statusSchema, "opt-pending", 0);
    // Node B: the user actually chose Done.
    const nodeB = await client.createObject({ presentAsMain: true, name: "B" });
    await client.assignClass(nodeB, taskClass);
    await client.setProperty(nodeB, statusSchema, "opt-done", 0);

    await client.unassignClass(nodeA, taskClass);
    await client.unassignClass(nodeB, taskClass);
    await flushWrites();

    // A: the default-mirror is gone with the class (no dangling value).
    expect(client.getEffectiveProperties(nodeA)).toEqual([]);
    expect(client.getNode(nodeA)?.classIds).toEqual([]);
    // B: the authored non-default value survives, marked unbound.
    expect(client.getNode(nodeB)?.classIds).toEqual([]);
    expect(client.getEffectiveProperties(nodeB)).toEqual([
      expect.objectContaining({
        propertySchemaId: statusSchema,
        value: "opt-done",
        source: "authored",
        boundBy: null,
      }),
    ]);
  });

  it("bindings without a defaultValue never sweep", async () => {
    const client = await seedClient();
    const notes = await client.createPropertySchema({ name: "notes", type: "text" });
    const klass = await client.createClass("plainish");
    await client.setClassProperty(klass, notes, { sequence: 0 });
    const node = await client.createObject({ presentAsMain: true, name: "N" });
    await client.assignClass(node, klass);
    await client.setProperty(node, notes, "user wrote this", 0);

    await client.unassignClass(node, klass);
    await flushWrites();

    expect(client.getEffectiveProperties(node)).toEqual([
      expect.objectContaining({ value: "user wrote this", source: "authored", boundBy: null }),
    ]);
  });
});

describe("the provenance flag (owner directive)", () => {
  it('"user"-provenance values survive even when they equal the default; "system" values sweep even when they differ', async () => {
    const client = await seedClient();
    const statusSchema = await client.createPropertySchema({
      name: "status",
      type: "select",
      options: [
        { id: "opt-pending", label: "Pending" },
        { id: "opt-done", label: "Done" },
      ],
    });
    const klass = await client.createClass("taskish");
    await client.setClassProperty(klass, statusSchema, {
      sequence: 0,
      defaultValue: "opt-pending",
    });

    // Node U: the user EXPLICITLY chose the default — provenance "user" pins it.
    const nodeU = await client.createObject({ presentAsMain: true, name: "U" });
    await client.assignClass(nodeU, klass);
    await client.setProperty(nodeU, statusSchema, "opt-pending", 0, { provenance: "user" });
    // Node S: a system-materialized value that DIFFERS from the default.
    const nodeS = await client.createObject({ presentAsMain: true, name: "S" });
    await client.assignClass(nodeS, klass);
    await client.setProperty(nodeS, statusSchema, "opt-done", 0, { provenance: "system" });

    await client.unassignClass(nodeU, klass);
    await client.unassignClass(nodeS, klass);
    await flushWrites();

    // U keeps its explicit choice (unbound); S loses the system value.
    expect(client.getEffectiveProperties(nodeU)).toEqual([
      expect.objectContaining({ value: "opt-pending", source: "authored", boundBy: null }),
    ]);
    expect(client.getEffectiveProperties(nodeS)).toEqual([]);
  });
});

describe("weblink extends source — inherited bindings + own-first resolution", () => {
  it("a weblink-classed node inherits the source family (unset fields stay hidden); the own url binding beats an inherited one", async () => {
    const { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } = await import("@notees/domain");
    const client = await seedClient();
    // The server-seed shape an existing workspace carries: the source root
    // with its family, the weblink class with its own url binding — plus
    // the extends edge this ruling adds (materialized on live workspaces
    // by the web self-heal, ensureWeblinkExtendsSource).
    await client.createClass("Source", { id: SYSTEM_CLASS_UUIDS.source });
    await client.createClass("Web link", { id: SYSTEM_CLASS_UUIDS.weblink });
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.doi,
      name: "DOI",
      type: "text",
      scope: "class",
    });
    await client.createPropertySchema({
      id: SYSTEM_PROPERTY_UUIDS.url,
      name: "URL",
      type: "url",
      scope: "class",
    });
    await client.setClassProperty(SYSTEM_CLASS_UUIDS.source, SYSTEM_PROPERTY_UUIDS.doi, {
      sequence: 0,
    });
    await client.setClassProperty(SYSTEM_CLASS_UUIDS.weblink, SYSTEM_PROPERTY_UUIDS.url, {
      sequence: 0,
    });
    await client.setClassExtends(SYSTEM_CLASS_UUIDS.weblink, [SYSTEM_CLASS_UUIDS.source]);
    await flushWrites();

    const weblinkId = SYSTEM_CLASS_UUIDS.weblink;
    const sourceId = SYSTEM_CLASS_UUIDS.source;

    // Sharpening of the seeded reality for the resolution rule: source
    // ALSO binds url — a weblink node's own url row must still win
    // (binding resolution is own-first: distance 0 beats distance 1).
    await client.setClassProperty(sourceId, SYSTEM_PROPERTY_UUIDS.url, { sequence: 9 });

    const pageId = await client.createObject({ presentAsMain: true, name: "A bookmark" });
    await client.assignClass(pageId, weblinkId);
    await flushWrites();

    // Unset fields stay hidden — a fresh weblink node shows no effective
    // rows (the inherited DOI binding has no default; url neither).
    expect(client.getEffectiveProperties(pageId)).toEqual([]);

    // Authored values surface through the INHERITED source bindings…
    await client.setProperty(pageId, SYSTEM_PROPERTY_UUIDS.doi, "10.1000/example", 0);
    await client.setProperty(pageId, SYSTEM_PROPERTY_UUIDS.url, "https://example.com", 0);
    await flushWrites();
    const rows = client.getEffectiveProperties(pageId);
    expect(rows.find((r) => r.propertySchemaId === SYSTEM_PROPERTY_UUIDS.doi)).toMatchObject({
      source: "authored",
      boundBy: sourceId,
    });
    // …while the url winner is the class's OWN binding, not source's.
    expect(rows.find((r) => r.propertySchemaId === SYSTEM_PROPERTY_UUIDS.url)).toMatchObject({
      source: "authored",
      boundBy: weblinkId,
    });
  });
});
