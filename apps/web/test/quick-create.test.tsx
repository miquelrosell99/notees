/**
 * Quick-create tests: resolveQuickCreate's family resolution
 * over the extends graph (source subclass → source flow with the subclass
 * preselected; bare source → book default; person/organization → agent
 * flow), splitPersonName's Zotero convention, splitAuthorList's
 * plain-text split (";" or newline — a comma lives inside a "Family, Given"
 * name), the modal's citation writes (authors/editors as PLAIN TEXT
 * elements — no person find-or-create; year links the chain's year node;
 * DOI/ISBN/URL/publisher/citekey scalars; venue fields self-heal their
 * schemas), auto-citekey with the deterministic a/b/c collision suffix,
 * archived-type filtering + the same-batch un-archive/create gesture,
 * the duplicate-DOI warning, the add-source resolver prefill, and the
 * picker integration — a class-filtered NodeSelector create row opens the
 * modal with the typed query prefilled, and a DOI/URL-shaped query offers
 * the "Create source from link" row.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_EXTENDS, SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, parseDateNodeId } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeSelector } from "../src/features/pickers/NodeSelector.js";
import { QuickCreateModal } from "../src/features/modals/QuickCreateModal.js";
import {
  activeSourceSubclassOptions,
  collectSelfAndAncestors,
  createAgentObject,
  createSourceObject,
  existingCitekeys,
  findSourceByIdentifier,
  generateCitekey,
  resolveQuickCreate,
  sourceSubclassOptions,
  splitAuthorList,
  splitPersonName,
} from "../src/features/modals/quickCreate.js";
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
  for (const name of ["source", "book", "journal_article", "agent", "person", "organization"] as const) {
    await client.createClass(name, { id: SYSTEM_CLASS_UUIDS[name] });
  }
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.book, [SYSTEM_CLASS_UUIDS.source]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.journal_article, [SYSTEM_CLASS_UUIDS.source]);
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
    expect(resolveQuickCreate(client, [SYSTEM_CLASS_UUIDS.journal_article])).toEqual({
      kind: "source",
      defaultClassId: SYSTEM_CLASS_UUIDS.journal_article,
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
    const tag = await client.createObject({ isEmbedded: false, name: "Some tag" });
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
    // Derived expectation (the 2026-10-23 roster added 30 source subclasses):
    // every extends-source class in the seed manifest appears as an option —
    // same filter the production derivation (SOURCE_SUBCLASS_IDS) applies.
    const expected = (
      Object.entries(SYSTEM_CLASS_EXTENDS) as Array<[string, string[]]>
    )
      .filter(([, parents]) => parents.includes("source"))
      .map(([name]) => SYSTEM_CLASS_UUIDS[name as keyof typeof SYSTEM_CLASS_UUIDS]);
    expect(options.map((option) => option.value).sort()).toEqual(expected.sort());
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

describe("splitAuthorList", () => {
  it("splits on ';' and newline — a comma lives INSIDE a 'Family, Given' name", () => {
    expect(splitAuthorList("Herbert, Frank; Lovelace, Ada")).toEqual([
      "Herbert, Frank",
      "Lovelace, Ada",
    ]);
    expect(splitAuthorList("Herbert, Frank\nLovelace, Ada\nTuring, Alan")).toEqual([
      "Herbert, Frank",
      "Lovelace, Ada",
      "Turing, Alan",
    ]);
    expect(splitAuthorList("Herbert, Frank, Lovelace, Ada")).toEqual(["Herbert, Frank, Lovelace, Ada"]);
    expect(splitAuthorList("  ;  \n ")).toEqual([]);
  });
});

describe("generateCitekey", () => {
  const entry = { authors: ["Lovelace, Ada"], year: 1843, title: "Notes on the Analytical Engine" };

  it("renders the pattern without a suffix when no collision exists", () => {
    expect(generateCitekey("[auth:lower][year][title:lower:3]", entry, [])).toBe(
      "lovelace1843notesonthe",
    );
    expect(generateCitekey(undefined, entry, ["someotherkey"])).toBe("lovelace1843notesonthe");
  });

  it("appends the deterministic a/b/c suffix on a collision, case-insensitively", () => {
    expect(generateCitekey(undefined, entry, ["LOVELACE1843NOTESONTHE"])).toBe(
      "lovelace1843notesonthea",
    );
    expect(generateCitekey(undefined, entry, ["lovelace1843notesonthe", "lovelace1843notesonthea"])).toBe(
      "lovelace1843notesontheb",
    );
    expect(
      generateCitekey(undefined, entry, [
        "lovelace1843notesonthe",
        "lovelace1843notesonthea",
        "lovelace1843notesontheb",
      ]),
    ).toBe("lovelace1843notesonthec");
  });

  it("falls back to the default pattern when the stored one does not compile", () => {
    expect(generateCitekey("[bogus]", entry, [])).toBe("lovelace1843notesonthe");
  });

  it("renders empty when the pattern's tokens have no data (the caller skips the write)", () => {
    expect(generateCitekey("[year]", { authors: [], year: null, title: "X" }, [])).toBe("");
  });

  it("continues the suffix past 'z' with 'aa'", () => {
    const base = "lovelace1843notesonthe";
    const taken = [
      base,
      ..."abcdefghijklmnopqrstuvwxyz".split("").map((letter) => `${base}${letter}`),
    ];
    expect(generateCitekey(undefined, entry, taken)).toBe(`${base}aa`);
  });
});

describe("existingCitekeys + findSourceByIdentifier", () => {
  it("collects live citekeys and finds the duplicate doi/isbn source", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const id = await createSourceObject(client, {
      title: "Dune",
      classId: SYSTEM_CLASS_UUIDS.book,
      doi: "10.1000/XYZ",
      isbn: "978-0-123456-78-9",
      citekey: "Herbert1965Dune",
    });
    expect(existingCitekeys(client)).toEqual(["Herbert1965Dune"]);
    // DOI compare is case-insensitive; ISBN compare is digit/X-normalized.
    const byDoi = findSourceByIdentifier(client, { doi: "10.1000/xyz" });
    expect(byDoi?.id).toBe(id);
    const byIsbn = findSourceByIdentifier(client, { isbn: "9780123456789" });
    expect(byIsbn?.id).toBe(id);
    expect(findSourceByIdentifier(client, { doi: "10.9999/other" })).toBeNull();
    expect(findSourceByIdentifier(client, {})).toBeNull();
  });
});

describe("activeSourceSubclassOptions", () => {
  it("filters archived type-classes; unseeded classes stay listed", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const all = sourceSubclassOptions();
    const live = activeSourceSubclassOptions(client);
    // No class rows in the store yet: nothing can be archived — all listed.
    expect(live.map((option) => option.value)).toEqual(all.map((option) => option.value));
    // Archive the film type-class: it drops out of the modal's list.
    await client.createClass("film", { id: SYSTEM_CLASS_UUIDS.film });
    await client.setClassExtends(SYSTEM_CLASS_UUIDS.film, [SYSTEM_CLASS_UUIDS.source]);
    await client.setArchived(SYSTEM_CLASS_UUIDS.film, false);
    const after = activeSourceSubclassOptions(client);
    expect(after.some((option) => option.value === SYSTEM_CLASS_UUIDS.film)).toBe(false);
    expect(after.some((option) => option.value === SYSTEM_CLASS_UUIDS.book)).toBe(true);
  });
});

describe("creators", () => {
  it("creates a classed source with plain-text authors, year link, and DOI", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const id = await createSourceObject(client, {
      title: "Dune",
      classId: SYSTEM_CLASS_UUIDS.book,
      authors: ["Herbert, Frank", "Lovelace, Ada"],
      doi: "10.1000/xyz",
      publicationYear: 1965,
    });

    const node = client.getNode(id);
    expect(node?.classIds).toContain(SYSTEM_CLASS_UUIDS.book);
    expect(deriveDisplayName(node!)).toBe("Dune");

    // Authors are PLAIN TEXT elements ("Family, Given"), in order — NO
    // person find-or-create (the 2026-10-24 rewire).
    const authors = client
      .getEffectiveProperties(id)
      .filter((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.authors);
    expect(authors.map((row) => row.value)).toEqual(["Herbert, Frank", "Lovelace, Ada"]);
    // No person nodes materialized.
    expect(client.getClassMembers(SYSTEM_CLASS_UUIDS.person).length).toBe(0);

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

  it("writes editors, isbn, url, publisher, citekey, and venue fields as provided", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const id = await createSourceObject(client, {
      title: "An Essay",
      classId: SYSTEM_CLASS_UUIDS.journal_article,
      editors: ["Smith, Jane", "Doe, John"],
      isbn: "978-0-123456-78-9",
      url: "https://example.test/essay",
      publisher: "Acme Press",
      citekey: "smith2024essay",
      venueFields: { publicationTitle: "The Example Journal", volume: "12", issue: "3" },
    });

    const rows = client.getEffectiveProperties(id);
    const valueOf = (schemaId: string) =>
      rows.filter((row) => row.propertySchemaId === schemaId).map((row) => row.value);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.editors)).toEqual(["Smith, Jane", "Doe, John"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.isbn)).toEqual(["978-0-123456-78-9"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.url)).toEqual(["https://example.test/essay"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.publisher)).toEqual(["Acme Press"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.citekey)).toEqual(["smith2024essay"]);
    // The venue fields self-healed their schemas (fresh workspace) and wrote.
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.publicationTitle)).toEqual(["The Example Journal"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.volume)).toEqual(["12"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.issue)).toEqual(["3"]);
  });

  it("un-archive + create ride ONE undo batch (the archived-class gesture)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    // Archive the book type-class (the class-visibility flag).
    await client.setArchived(SYSTEM_CLASS_UUIDS.book, false);
    expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.book)?.isActive).toBe(false);
    const depthBefore = client.undoDepth().undo;

    const id = await createSourceObject(client, {
      title: "Archived Type Create",
      classId: SYSTEM_CLASS_UUIDS.book,
      unarchiveArchivedClass: true,
    });
    expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.book)?.isActive).toBe(true);
    expect(client.getNode(id)).not.toBeNull();

    // ONE journal entry for the whole gesture (un-archive + create): a
    // single undo archives the class back AND trashes the created source
    // (the create's inverse is the soft trash — the row survives inactive).
    expect(client.undoDepth().undo).toBe(depthBefore + 1);
    await client.undo();
    expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.book)?.isActive).toBe(false);
    expect(client.getNodeRaw(id)?.isActive).toBe(false);
  });

  it("does not un-archive a live class (the flag is a no-op there)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const depthBefore = client.undoDepth().undo;
    const id = await createSourceObject(client, {
      title: "Live Type Create",
      classId: SYSTEM_CLASS_UUIDS.book,
      unarchiveArchivedClass: true,
    });
    expect(client.getNode(id)).not.toBeNull();
    // A single journal entry (the create alone — no un-archive op).
    expect(client.undoDepth().undo).toBe(depthBefore + 1);
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

describe("the paste-URL source row", () => {
  it("a DOI-shaped query offers 'Create source from link' and routes the raw query", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const links: string[] = [];
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchMode="all"
        onAdd={() => {}}
        onCreateSourceFromLink={(raw) => links.push(raw)}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "10.1000/xyz" } });
    const row = await screen.findByText("Create source from link");
    fireEvent.click(row);
    expect(links).toEqual(["10.1000/xyz"]);
  });

  it("an arXiv URL and a plain URL offer the row; ordinary text does not", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const links: string[] = [];
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchMode="all"
        onAdd={() => {}}
        onCreateSourceFromLink={(raw) => links.push(raw)}
      />,
    );
    const search = screen.getByLabelText("Search...");
    fireEvent.change(search, { target: { value: "https://arxiv.org/abs/2401.12345" } });
    expect(await screen.findByText("Create source from link")).not.toBeNull();
    fireEvent.change(search, { target: { value: "https://example.test/paper.pdf" } });
    expect(await screen.findByText("Create source from link")).not.toBeNull();
    fireEvent.change(search, { target: { value: "ordinary meeting notes" } });
    await waitFor(() =>
      expect(screen.queryByText("Create source from link")).toBeNull(),
    );
    expect(links.length).toBe(0);
  });
});

describe("QuickCreateModal source rewiring", () => {
  it("auto-fills the citekey from the pattern when the setting is on and the field is empty", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await client.setFeatureSettings("sources", {
      autoCitekey: true,
      citekeyPattern: "[auth:lower][year]",
    });
    let createdId = "";
    render(
      <QuickCreateModal
        isOpen
        client={client}
        kind="source"
        defaultClassId={SYSTEM_CLASS_UUIDS.book}
        onClose={() => {}}
        onCreated={(id) => {
          createdId = id;
        }}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /new book/i });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Dune" } });
    fireEvent.change(within(dialog).getByLabelText("Authors"), {
      target: { value: "Herbert, Frank" },
    });
    fireEvent.change(within(dialog).getByLabelText("Year"), { target: { value: "1965" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(createdId).not.toBe(""));

    const citekey = client
      .getEffectiveProperties(createdId)
      .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.citekey);
    expect(citekey?.value).toBe("herbert1965");

    // A second identical source takes the deterministic collision suffix.
    let secondId = "";
    render(
      <QuickCreateModal
        isOpen
        client={client}
        kind="source"
        defaultClassId={SYSTEM_CLASS_UUIDS.book}
        onClose={() => {}}
        onCreated={(id) => {
          secondId = id;
        }}
      />,
    );
    const secondDialog = await screen.findByRole("dialog", { name: /new book/i });
    fireEvent.change(within(secondDialog).getByLabelText("Title"), { target: { value: "Dune" } });
    fireEvent.change(within(secondDialog).getByLabelText("Authors"), {
      target: { value: "Herbert, Frank" },
    });
    fireEvent.change(within(secondDialog).getByLabelText("Year"), { target: { value: "1965" } });
    fireEvent.click(within(secondDialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(secondId).not.toBe(""));
    const secondCitekey = client
      .getEffectiveProperties(secondId)
      .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.citekey);
    expect(secondCitekey?.value).toBe("herbert1965a");
  });

  it("does not auto-fill the citekey when the setting is off or the field holds a value", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    let createdId = "";
    render(
      <QuickCreateModal
        isOpen
        client={client}
        kind="source"
        defaultClassId={SYSTEM_CLASS_UUIDS.book}
        onClose={() => {}}
        onCreated={(id) => {
          createdId = id;
        }}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /new book/i });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Dune" } });
    fireEvent.change(within(dialog).getByLabelText("Authors"), {
      target: { value: "Herbert, Frank" },
    });
    fireEvent.change(within(dialog).getByLabelText("Year"), { target: { value: "1965" } });
    fireEvent.change(within(dialog).getByLabelText("Citekey"), { target: { value: "my-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(createdId).not.toBe(""));
    const citekey = client
      .getEffectiveProperties(createdId)
      .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.citekey);
    // Setting off AND a manual value: the manual value wins.
    expect(citekey?.value).toBe("my-key");
  });

  it("splits the authors input on ';' — each entry is one plain text element", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    let createdId = "";
    render(
      <QuickCreateModal
        isOpen
        client={client}
        kind="source"
        defaultClassId={SYSTEM_CLASS_UUIDS.book}
        onClose={() => {}}
        onCreated={(id) => {
          createdId = id;
        }}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /new book/i });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Dune" } });
    fireEvent.change(within(dialog).getByLabelText("Authors"), {
      target: { value: "Herbert, Frank; Lovelace, Ada" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(createdId).not.toBe(""));
    const authors = client
      .getEffectiveProperties(createdId)
      .filter((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.authors);
    expect(authors.map((row) => row.value)).toEqual(["Herbert, Frank", "Lovelace, Ada"]);
    expect(client.getClassMembers(SYSTEM_CLASS_UUIDS.person).length).toBe(0);
  });

  it("skips the citekey write when auto-citekey renders empty (pattern with no data)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    // A [year]-only pattern with no year renders EMPTY — nothing is written.
    await client.setFeatureSettings("sources", { autoCitekey: true, citekeyPattern: "[year]" });
    let createdId = "";
    render(
      <QuickCreateModal
        isOpen
        client={client}
        kind="source"
        defaultClassId={SYSTEM_CLASS_UUIDS.book}
        onClose={() => {}}
        onCreated={(id) => {
          createdId = id;
        }}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /new book/i });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Undated" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(createdId).not.toBe(""));
    const citekeyRows = client
      .getEffectiveProperties(createdId)
      .filter((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.citekey);
    // No AUTHORED citekey row — a default/bound virtual row may read empty.
    expect(citekeyRows.every((row) => row.source !== "authored")).toBe(true);
  });

  it("warns 'Already in your library' on a duplicate DOI but still creates on override", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await createSourceObject(client, {
      title: "Existing paper",
      classId: SYSTEM_CLASS_UUIDS.journal_article,
      doi: "10.1000/xyz",
    });

    const opened: string[] = [];
    let createdId = "";
    render(
      <QuickCreateModal
        isOpen
        client={client}
        kind="source"
        defaultClassId={SYSTEM_CLASS_UUIDS.journal_article}
        sourcePrefill={{
          classId: SYSTEM_CLASS_UUIDS.journal_article,
          title: "Duplicate import",
          authorsText: "Someone, Else",
          doi: "10.1000/xyz",
          fields: {},
        }}
        onClose={() => {}}
        onCreated={(id) => {
          createdId = id;
        }}
        onOpenExisting={(id) => opened.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /new journal_article/i });
    expect(within(dialog).getByText(/already in your library/i)).not.toBeNull();
    const existingLink = within(dialog).getByRole("button", { name: "Existing paper" });
    fireEvent.click(existingLink);
    expect(opened.length).toBe(1);

    // The explicit override: Create still works.
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(createdId).not.toBe(""));
    expect(createdId).not.toBe(opened[0]);
    const sources = client.getClassMembers(SYSTEM_CLASS_UUIDS.source);
    expect(sources.length).toBe(2);
  });

  it("prefills from a resolver record and auto-enables an archived class in the same batch", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    // Archive the journal_article type-class before the resolver-created prefill.
    await client.setArchived(SYSTEM_CLASS_UUIDS.journal_article, false);
    let createdId = "";
    render(
      <QuickCreateModal
        isOpen
        client={client}
        kind="source"
        defaultClassId={SYSTEM_CLASS_UUIDS.journal_article}
        sourcePrefill={{
          classId: SYSTEM_CLASS_UUIDS.journal_article,
          title: "Resolved paper",
          authorsText: "Lovelace, Ada; Turing, Alan",
          year: "1843",
          doi: "10.1000/resolved",
          fields: { publicationTitle: "The Example Journal", volume: "7" },
        }}
        onClose={() => {}}
        onCreated={(id) => {
          createdId = id;
        }}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /new journal_article/i });
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("Resolved paper");
    expect((within(dialog).getByLabelText("Authors") as HTMLInputElement).value).toBe(
      "Lovelace, Ada; Turing, Alan",
    );
    expect((within(dialog).getByLabelText("Publication title") as HTMLInputElement).value).toBe(
      "The Example Journal",
    );
    expect((within(dialog).getByLabelText("Volume") as HTMLInputElement).value).toBe("7");

    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(createdId).not.toBe(""));
    expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.journal_article)?.isActive).toBe(true);
    const node = client.getNode(createdId);
    expect(node?.classIds).toContain(SYSTEM_CLASS_UUIDS.journal_article);
    const authors = client
      .getEffectiveProperties(createdId)
      .filter((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.authors);
    expect(authors.map((row) => row.value)).toEqual(["Lovelace, Ada", "Turing, Alan"]);
  });
});
