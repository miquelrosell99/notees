/**
 * ScopeRemedy specs (the guided scope remedy, owner-approved Tier 3): the
 * pure missingScopeClasses/nearestRemedyClass derivation (transitive
 * ancestors satisfying the scope → no offer), the offer button per missing
 * scope class, the confirm submitting class.setExtends with the UNION
 * parent set, the schema becoming eligible once the edge lands, the
 * add-property picker's ineligible search matches showing the offer, and
 * the effective read's eligible:false row carrying it.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { AddPropertyRow } from "../src/features/metadata/AddPropertyRow.js";
import { PropertiesTable } from "../src/features/metadata/PropertiesTable.js";
import { ScopeRemedyButton } from "../src/features/metadata/ScopeRemedyButton.js";
import { isSchemaEligibleForNode } from "../src/features/metadata/schemaEligibility.js";
import { missingScopeClasses, nearestRemedyClass } from "../src/features/metadata/scopeRemedy.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  // Unmount subscribed renders BEFORE closing the client — a subscription
  // notification firing into a mounted component after close() re-renders
  // it against a closed database (the established web-test teardown order).
  cleanup();
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
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

interface RemedyFixture {
  nodeId: string;
  classX: string;
  classY: string;
  schemaId: string;
}

/** A node classed X only; a schema scoped to Y — the X-closure misses Y. */
async function seedRemedyWorkspace(client: WorkspaceClient): Promise<RemedyFixture> {
  const classX = await client.createClass("Task");
  const classY = await client.createClass("Project");
  const schemaId = await client.createPropertySchema({
    name: "Priority",
    type: "text",
    scopeClassIds: [classY],
  });
  const nodeId = await client.createObject({ isEmbedded: false, name: "Alpha" });
  await client.assignClass(nodeId, classX);
  return { nodeId, classX, classY, schemaId };
}

const schemaOf = (client: WorkspaceClient, schemaId: string) =>
  client.listPropertySchemas().find((s) => s.id === schemaId)!;

describe("scopeRemedy (pure logic)", () => {
  it("missingScopeClasses is empty for global and already-eligible schemas", async () => {
    const client = await seedClient();
    const { nodeId, classY } = await seedRemedyWorkspace(client);
    const node = client.getNode(nodeId)!;
    const global = { scopeClassIds: null };
    expect(missingScopeClasses(client, node.classIds, global)).toEqual([]);
    // The node's own class in the scope list — eligible, no missing edge.
    expect(missingScopeClasses(client, node.classIds, { scopeClassIds: [node.classIds[0]!] })).toEqual([]);
    // A dangling scope id the node does NOT carry is still missing (only a
    // scope id in the closure — own class or extends-ancestor — counts).
    expect(missingScopeClasses(client, node.classIds, { scopeClassIds: [classY, "missing"] })).toEqual([
      classY,
      "missing",
    ]);
  });

  it("a transitive extends-ancestor satisfying the scope yields no offer", async () => {
    const client = await seedClient();
    const { nodeId, classX, classY } = await seedRemedyWorkspace(client);
    const middle = await client.createClass("WorkItem");
    // X → middle → Y: the closure reaches Y without a direct X → Y edge.
    await client.setClassExtends(classX, [middle]);
    await client.setClassExtends(middle, [classY]);
    const node = client.getNode(nodeId)!;
    expect(missingScopeClasses(client, node.classIds, { scopeClassIds: [classY] })).toEqual([]);
  });

  it("nearestRemedyClass is the node's own first class, null when classless", async () => {
    const client = await seedClient();
    const { nodeId, classX } = await seedRemedyWorkspace(client);
    const node = client.getNode(nodeId)!;
    expect(nearestRemedyClass(client, node.classIds)).toBe(classX);
    const bareId = await client.createObject({ isEmbedded: false, name: "Bare" });
    expect(nearestRemedyClass(client, client.getNode(bareId)!.classIds)).toBeNull();
  });
});

describe("ScopeRemedyButton", () => {
  it("renders one offer per missing scope class, nothing for a classless node", async () => {
    const client = await seedClient();
    const { nodeId, classY, schemaId } = await seedRemedyWorkspace(client);
    // A second scope class the closure also misses — a second offer.
    const classZ = await client.createClass("Area");
    await client.updatePropertySchema(schemaId, { scopeClassIds: [classY, classZ] });
    const schema = schemaOf(client, schemaId);

    render(<ScopeRemedyButton client={client} nodeId={nodeId} schema={schema} />);
    expect(screen.getByRole("button", { name: "Let Task extend Project?" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Let Task extend Area?" })).not.toBeNull();

    // A classless node has no extends receiver — the offer renders nothing.
    const bareId = await client.createObject({ isEmbedded: false, name: "Bare" });
    const bare = render(<ScopeRemedyButton client={client} nodeId={bareId} schema={schema} />);
    expect(bare.container.firstChild).toBeNull();
  });

  it("confirm submits class.setExtends with the UNION parent set and makes the schema eligible", async () => {
    const client = await seedClient();
    const { nodeId, classX, classY, schemaId } = await seedRemedyWorkspace(client);
    // A pre-existing parent W — the confirm must keep it (union, not replace).
    const classW = await client.createClass("Record");
    await client.setClassExtends(classX, [classW]);
    const schema = schemaOf(client, schemaId);
    expect(isSchemaEligibleForNode(client, schema, client.getNode(nodeId)!)).toBe(false);

    render(<ScopeRemedyButton client={client} nodeId={nodeId} schema={schema} />);
    fireEvent.click(screen.getByRole("button", { name: "Let Task extend Project?" }));
    // The modal states the consequence before the write.
    expect(await screen.findByText(/Task and all its members become eligible/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Extend" }));

    await waitFor(() => {
      // UNION — the pre-existing parent W is kept alongside the new edge
      // (the store's parent order is its own; both must be present).
      expect(client.getClassParents(classX)).toHaveLength(2);
      expect(client.getClassParents(classX)).toContain(classW);
      expect(client.getClassParents(classX)).toContain(classY);
    });
    await waitFor(() => {
      expect(isSchemaEligibleForNode(client, schema, client.getNode(nodeId)!)).toBe(true);
    });
    // The schema is eligible now — the offer renders nothing.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Let Task extend Project?" })).toBeNull();
    });
  });
});

describe("the picker surface (AddPropertyRow)", () => {
  it("an ineligible search match stays visible, disabled, with the remedy offer", async () => {
    const client = await seedClient();
    const { nodeId } = await seedRemedyWorkspace(client);
    render(<AddPropertyRow client={client} nodeId={nodeId} />);
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    // The empty query does not surface ineligible schemas — search first.
    expect(screen.queryByText("not eligible")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Search or create property…"), {
      target: { value: "prio" },
    });
    const disabledRow = screen.getByText("not eligible").closest("button")!;
    expect(disabledRow.disabled).toBe(true);
    expect(disabledRow.textContent).toContain("Priority");
    // The remedy offer rides beneath the disabled row.
    expect(screen.getByRole("button", { name: "Let Task extend Project?" })).not.toBeNull();
    // Confirming through the picker applies the edge and dissolves the offer.
    fireEvent.click(screen.getByRole("button", { name: "Let Task extend Project?" }));
    fireEvent.click(await screen.findByRole("button", { name: "Extend" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Let Task extend Project?" })).toBeNull();
    });
    // …and the schema moved into the eligible list (still matching "prio").
    const eligibleRow = screen.getByText("Priority").closest("button")!;
    expect(eligibleRow.disabled).toBe(false);
  });
});

describe("the eligible:false row surface (PropertiesTable)", () => {
  it("the dimmed row carries the remedy offer; the offer fixes the row", async () => {
    const client = await seedClient();
    const { nodeId, classX, schemaId } = await seedRemedyWorkspace(client);
    // Author a value while eligible (the node carries the scope class)…
    const classY = client.listPropertySchemas().find((s) => s.id === schemaId)!.scopeClassIds![0]!;
    await client.assignClass(nodeId, classY);
    await client.setProperty(nodeId, schemaId, "high", 0);
    // …then drop the scope class — R4: the authored row SURVIVES tagged
    // eligible:false (never retroactive), dimmed, previously a dead end.
    await client.unassignClass(nodeId, classY);
    const row = client.getEffectiveProperties(nodeId).find((r) => r.propertySchemaId === schemaId)!;
    expect(row.eligible).toBe(false);

    render(<PropertiesTable client={client} nodeId={nodeId} />);
    const offer = screen.getByRole("button", { name: "Let Task extend Project?" });
    // The grouped text row dims (the ineligible register) and the remedy
    // rides its own li beneath it.
    expect(document.querySelector("li.nt-property-ineligible")).not.toBeNull();
    expect(offer.closest("li")!.className).toContain("nt-property-remedy-row");
    fireEvent.click(offer);
    fireEvent.click(await screen.findByRole("button", { name: "Extend" }));
    // The edge lands: X's closure reaches Y and the row is eligible again —
    // the dimming AND the offer are gone.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Let Task extend Project?" })).toBeNull();
    });
    expect(
      client.getEffectiveProperties(nodeId).find((r) => r.propertySchemaId === schemaId)!.eligible,
    ).not.toBe(false);
    expect(client.getClassParents(classX)).toContain(classY);
  });
});
