/**
 * The object-property picker's class filter is extends-aware in SEARCH (the
 * owner's Linked authors case: the filter names a BASE class — Agent — and
 * the picker must find nodes classed with a SUBCLASS — persona). The browse
 * path (empty query, getClassMembers) always was extends-aware; the search
 * hit branch tested DIRECT class membership (`node.classIds.includes(filter)`),
 * so a subclass member matched the query yet vanished from the hits. The
 * membership test now walks the filter's extends-closure BOTH directions
 * (the schemaEligibility classClosureFrom walk): the closure of the filter
 * set reaches the node's own class, or the node's own classes reach a filter
 * id through their ancestors.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeSelector } from "../src/features/pickers/NodeSelector.js";

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

/** WORKAROUND(store applier): class.create's contentAst never lands in the
 * class node's content — seed titles through object.update instead. */
async function createTitledClass(client: WorkspaceClient, title: string): Promise<string> {
  const id = await client.createClass(title);
  await client.updateObject(id, { contentAst: [{ type: "text", text: title }] });
  return id;
}

describe("NodeSelector class filter is extends-aware in search", () => {
  it("a subclass member matches by name in SEARCH and BROWSE; an unrelated-class node stays excluded", async () => {
    const client = await seedClient();
    // The owner fixture: Agent base, Persona subclass, Mariano Sanz a persona.
    const agent = await createTitledClass(client, "Agent");
    const persona = await createTitledClass(client, "Persona");
    await client.setClassExtends(persona, [agent]);
    const mariano = await client.createObject({ isEmbedded: false, name: "Mariano Sanz" });
    await client.assignClass(mariano, persona);
    // An unrelated-class node: must never leak into the Agent-scoped picker.
    const fiction = await createTitledClass(client, "Fiction");
    const novel = await client.createObject({ isEmbedded: false, name: "Novel" });
    await client.assignClass(novel, fiction);

    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchMode="pages"
        classFilters={[agent]}
        searchPlaceholder="Search authors"
        onAdd={() => {}}
      />,
    );

    // BROWSE (empty query): the extends-aware member listing already showed
    // the subclass member — this half never regressed.
    expect(screen.getByText("Mariano Sanz")).not.toBeNull();
    expect(screen.queryByText("Novel")).toBeNull();

    // SEARCH by the correct name: the subclass member must ALSO hit. The
    // direct-membership check filtered it out (persona ∉ [Agent]) — the
    // owner's reported bug.
    fireEvent.change(screen.getByLabelText("Search authors"), { target: { value: "Mariano" } });
    expect(screen.getByText("Mariano Sanz")).not.toBeNull();

    // An unrelated-class node matching the query stays excluded (the closure
    // walk must not become a pass-through): "Novel" matches the Fiction node
    // by name, and Fiction's closure never reaches Agent.
    fireEvent.change(screen.getByLabelText("Search authors"), { target: { value: "Novel" } });
    expect(screen.queryByText("Novel")).toBeNull();
  });
});
