/**
 * Quick-create tests: resolveQuickCreate's family resolution
 * over the extends graph (source subclass → source flow with the subclass
 * preselected; bare source → book default; person/organization → agent
 * flow), splitPersonName's Zotero convention, the modal's citation writes
 * (authors become/reuse linked person nodes, year links the chain's year
 * node, DOI a text value; given/family for persons), and the picker
 * integration — a class-filtered NodeSelector create row opens the modal
 * with the typed query prefilled instead of silently creating a plain page.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, parseDateNodeId } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { NodeSelector } from "../src/ui/components/pickers/NodeSelector.js";
import {
  collectSelfAndAncestors,
  createAgentObject,
  createSourceObject,
  resolveQuickCreate,
  sourceSubclassOptions,
  splitPersonName,
} from "../src/ui/components/modals/quickCreate.js";
import { deriveDisplayName } from "@notees/domain";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
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

/** Author the source/agent family the way the server seed does. */
async function seedFamilies(client: WorkspaceClient): Promise<void> {
  for (const name of ["source", "book", "paper", "agent", "person", "organization"] as const) {
    await client.createClass(name, { id: SYSTEM_CLASS_UUIDS[name] });
  }
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.book, [SYSTEM_CLASS_UUIDS.source]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.paper, [SYSTEM_CLASS_UUIDS.source]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.person, [SYSTEM_CLASS_UUIDS.agent]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.organization, [SYSTEM_CLASS_UUIDS.agent]);
}

describe("resolveQuickCreate", () => {
  it("maps source subclasses to the source flow with the subclass preselected", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    expect(resolveQuickCreate(client, [SYSTEM_CLASS_UUIDS.book])).toEqual({
      kind: "source",
      defaultClassId: SYSTEM_CLASS_UUIDS.book,
    });
    expect(resolveQuickCreate(client, [SYSTEM_CLASS_UUIDS.paper])).toEqual({
      kind: "source",
      defaultClassId: SYSTEM_CLASS_UUIDS.paper,
    });
  });

  it("defaults a bare source filter to book; resolves the agent family", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    expect(resolveQuickCreate(client, [SYSTEM_CLASS_UUIDS.source])).toEqual({
      kind: "source",
      defaultClassId: SYSTEM_CLASS_UUIDS.book,
    });
    expect(resolveQuickCreate(client, [SYSTEM_CLASS_UUIDS.person])).toEqual({
      kind: "agent",
      defaultClassId: SYSTEM_CLASS_UUIDS.person,
    });
    expect(resolveQuickCreate(client, [SYSTEM_CLASS_UUIDS.organization])).toEqual({
      kind: "agent",
      defaultClassId: SYSTEM_CLASS_UUIDS.organization,
    });
    // Subclass of person resolves through the agent lineage.
    await client.createClass("scholar", { id: "0192a000-0000-7000-8000-000000000099" });
    await client.setClassExtends("0192a000-0000-7000-8000-000000000099", [
      SYSTEM_CLASS_UUIDS.person,
    ]);
    expect(
      resolveQuickCreate(client, ["0192a000-0000-7000-8000-000000000099"]),
    ).toEqual({ kind: "agent", defaultClassId: SYSTEM_CLASS_UUIDS.person });
  });

  it("returns null for unrelated filters and empty filters", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const tag = await client.createObject({ presentAsMain: true, name: "Some tag" });
    const tagClass = await client.createClass("taglike");
    await client.assignClass(tag, tagClass);
    expect(resolveQuickCreate(client, [tagClass])).toBeNull();
    expect(resolveQuickCreate(client, [])).toBeNull();
  });

  it("collectSelfAndAncestors falls back to the static system extends", async () => {
    const client = await seedClient();
    // No classes authored at all: the seeded extends map still resolves.
    const lineage = collectSelfAndAncestors(client, SYSTEM_CLASS_UUIDS.book);
    expect(lineage.has(SYSTEM_CLASS_UUIDS.source)).toBe(true);
  });

  it("sourceSubclassOptions covers every seeded source subclass", async () => {
    const options = sourceSubclassOptions();
    expect(options.map((option) => option.value).sort()).toEqual(
      [
        SYSTEM_CLASS_UUIDS.book,
        SYSTEM_CLASS_UUIDS.paper,
        SYSTEM_CLASS_UUIDS.article,
        SYSTEM_CLASS_UUIDS.thesis,
        SYSTEM_CLASS_UUIDS.document,
        SYSTEM_CLASS_UUIDS.movie,
        SYSTEM_CLASS_UUIDS.song,
        SYSTEM_CLASS_UUIDS.tv_series,
        SYSTEM_CLASS_UUIDS.conference,
        SYSTEM_CLASS_UUIDS.weblink,
      ].sort(),
    );
  });
});

describe("splitPersonName", () => {
  it("splits on the last word; a single word is the family name", () => {
    expect(splitPersonName("Frank Herbert")).toEqual({ givenName: "Frank", familyName: "Herbert" });
    expect(splitPersonName("Ursula K. Le Guin")).toEqual({
      givenName: "Ursula K. Le",
      familyName: "Guin",
    });
    expect(splitPersonName("Prince")).toEqual({ givenName: "", familyName: "Prince" });
    expect(splitPersonName("  ")).toEqual({ givenName: "", familyName: "" });
  });
});

describe("creators", () => {
  it("creates a classed source with authors (person nodes), year link, and DOI", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const id = await createSourceObject(client, {
      title: "Dune",
      classId: SYSTEM_CLASS_UUIDS.book,
      authors: ["Frank Herbert", "Ada Lovelace"],
      doi: "10.1000/xyz",
      publicationYear: 1965,
    });

    const node = client.getNode(id);
    expect(node?.classIds).toContain(SYSTEM_CLASS_UUIDS.book);
    expect(deriveDisplayName(node!)).toBe("Dune");

    // Authors are linked person nodes, in order, with the name split.
    const authors = client
      .getEffectiveProperties(id)
      .filter((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.authors);
    expect(authors.length).toBe(2);
    const authorNodes = authors.map((row) =>
      client.getNode((row.value as { nodeId: string }).nodeId),
    );
    expect(authorNodes.map((author) => deriveDisplayName(author!))).toEqual([
      "Frank Herbert",
      "Ada Lovelace",
    ]);
    expect(authorNodes.every((author) => author!.classIds.includes(SYSTEM_CLASS_UUIDS.person))).toBe(
      true,
    );
    const family = client
      .getEffectiveProperties(authorNodes[0]!.id)
      .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.familyName);
    expect(family?.value).toBe("Herbert");

    // DOI is a text value; the year links the deterministic year node.
    const doi = client
      .getEffectiveProperties(id)
      .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.doi);
    expect(doi?.value).toBe("10.1000/xyz");
    const published = client
      .getEffectiveProperties(id)
      .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.publicationDate);
    const yearId = (published?.value as { nodeId: string }).nodeId;
    expect(parseDateNodeId(yearId)?.year).toBe(1965);
  });

  it("reuses an existing person with the same full name", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const first = await createSourceObject(client, {
      title: "One",
      classId: SYSTEM_CLASS_UUIDS.book,
      authors: ["Frank Herbert"],
    });
    const second = await createSourceObject(client, {
      title: "Two",
      classId: SYSTEM_CLASS_UUIDS.book,
      authors: ["frank herbert"],
    });
    const persons = client.getClassMembers(SYSTEM_CLASS_UUIDS.person);
    expect(persons.length).toBe(1);
    const firstAuthor = client
      .getEffectiveProperties(first)
      .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.authors);
    const secondAuthor = client
      .getEffectiveProperties(second)
      .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.authors);
    expect((firstAuthor!.value as { nodeId: string }).nodeId).toBe(
      (secondAuthor!.value as { nodeId: string }).nodeId,
    );
  });

  it("creates persons with given/family and organizations with a plain name", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const personId = await createAgentObject(client, {
      agentType: "person",
      givenName: "Frank",
      familyName: "Herbert",
    });
    expect(deriveDisplayName(client.getNode(personId)!)).toBe("Frank Herbert");
    const given = client
      .getEffectiveProperties(personId)
      .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.givenName);
    expect(given?.value).toBe("Frank");

    const orgId = await createAgentObject(client, {
      agentType: "organization",
      name: "Acme Press",
    });
    const org = client.getNode(orgId)!;
    expect(org.classIds).toContain(SYSTEM_CLASS_UUIDS.organization);
    expect(deriveDisplayName(org)).toBe("Acme Press");

    await expect(createAgentObject(client, { agentType: "person", givenName: "", familyName: " " })).rejects.toThrow();
  });
});

describe("QuickCreateModal via the picker create row", () => {
  it("a book-filtered picker create row opens the citation modal and links the result", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const added: string[] = [];
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchMode="all"
        classFilters={[SYSTEM_CLASS_UUIDS.book]}
        onAdd={(node) => added.push(node.id)}
      />,
    );

    // Type a query with no match; the create row answers it.
    const search = screen.getByLabelText("Search...");
    fireEvent.change(search, { target: { value: "Dune" } });
    fireEvent.click(screen.getByText('Create "Dune"'));

    // The modal opens with the title prefilled (NOT a silent plain create).
    const dialog = await screen.findByRole("dialog", { name: /new book/i });
    const titleField = within(dialog).getByLabelText("Title") as HTMLInputElement;
    expect(titleField.value).toBe("Dune");
    expect(within(dialog).getByLabelText("Authors")).not.toBeNull();
    expect(within(dialog).getByLabelText("Year")).not.toBeNull();
    expect(within(dialog).getByLabelText("DOI")).not.toBeNull();

    fireEvent.change(within(dialog).getByLabelText("Authors"), {
      target: { value: "Frank Herbert" },
    });
    fireEvent.change(within(dialog).getByLabelText("Year"), { target: { value: "1965" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));

    // The modal creates the node and hands it back through the picker's add
    // path (inline mode keeps no dialog role — assert the callback).
    await waitFor(() => expect(added.length).toBe(1));
    const created = client.getNode(added[0]!);
    expect(created?.classIds).toContain(SYSTEM_CLASS_UUIDS.book);
    expect(deriveDisplayName(created!)).toBe("Dune");
    // The picker's own plain-create path never ran (no plain page with the name).
    expect(
      client.listPages().filter((page) => deriveDisplayName(page) === "Dune").length,
    ).toBe(1);
  });

  it("a person-filtered picker opens the agent dialog with the name split", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchMode="all"
        classFilters={[SYSTEM_CLASS_UUIDS.person]}
        onAdd={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "Frank Herbert" } });
    fireEvent.click(screen.getByText('Create "Frank Herbert"'));

    const dialog = await screen.findByRole("dialog", { name: /new person/i });
    expect((within(dialog).getByLabelText("Given name") as HTMLInputElement).value).toBe("Frank");
    expect((within(dialog).getByLabelText("Family name") as HTMLInputElement).value).toBe("Herbert");
  });

  it("unrelated filters keep the plain create row", async () => {
    const client = await seedClient();
    const added: string[] = [];
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchMode="all"
        onAdd={(node) => added.push(node.id)}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "Plain page" } });
    fireEvent.click(screen.getByText('Create "Plain page"'));
    await waitFor(() => expect(added.length).toBe(1));
    expect(client.getNode(added[0]!)?.classIds.length).toBe(0);
    // No quick-create modal appeared.
    expect(screen.queryByLabelText("Title")).toBeNull();
  });
});
