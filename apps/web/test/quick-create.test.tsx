/**
 * Quick-create tests: the class-driven create modal —
 * routeNewNodeClass's every-class routing (source subclass → the modal with
 * that class; bare source → book default; user classes → the modal; asset →
 * the upload flow), the staged-bindings resolution (extends-aware,
 * alphabetical, the staged-type filter — object/asset excluded), the staged
 * value expansion (multi text splits into one element per entry; the staged
 * date resolves through the date chain to `{ nodeId }`; numbers parse;
 * untouched booleans/options write nothing), the createClassedObject flush
 * (un-archive + create + property writes in ONE undo batch), auto-citekey
 * with the deterministic a/b/c collision suffix, the duplicate DOI/ISBN/
 * citekey warning, the archived-class auto-enable, the resolver prefill, and
 * the picker integration — every class-filtered NodeSelector create row
 * opens the modal with the typed query as the title (no subclass switch, no
 * agent toggle), an identifier-shaped query under a source filter still
 * reroutes to the add-source dialog, and a filter-less create stays plain.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, parseDateNodeId } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { NodeSelector } from "../src/features/pickers/NodeSelector.js";
import { QuickCreateModal } from "../src/features/modals/QuickCreateModal.js";
import {
  collectSelfAndAncestors,
  createClassedObject,
  ensureCitationFamily,
  existingCitekeys,
  expandStagedValues,
  findSourceByIdentifier,
  generateCitekey,
  initialStagedValue,
  parseStagedDateText,
  routeNewNodeClass,
  splitAuthorList,
  stagedBindingsOf,
} from "../src/features/modals/quickCreate.js";
import { deriveDisplayName } from "@notees/domain";
import { AddSourceHost } from "../src/features/sources/AddSourceHost.js";

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

/**
 * Author the source/agent family the way the server seed does, then run the
 * citation self-heal (the write-time schema/binding authoring the flush
 * composes) — mirrors a server-seeded workspace.
 */
async function seedFamilies(client: WorkspaceClient): Promise<void> {
  for (const name of ["source", "book", "journal_article", "agent", "person", "organization"] as const) {
    await client.createClass(name, { id: SYSTEM_CLASS_UUIDS[name] });
  }
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.book, [SYSTEM_CLASS_UUIDS.source]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.journal_article, [SYSTEM_CLASS_UUIDS.source]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.person, [SYSTEM_CLASS_UUIDS.agent]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.organization, [SYSTEM_CLASS_UUIDS.agent]);
  await ensureCitationFamily(client);
}

/** A book create input as staged rows (the modal's flush shape). */
async function stagedInput(
  client: WorkspaceClient,
  classId: string,
  seeds: Record<string, string>,
): Promise<Array<{ row: ReturnType<typeof stagedBindingsOf>[number]; value: ReturnType<typeof initialStagedValue> }>> {
  const rows = stagedBindingsOf(client, classId);
  return rows
    .filter((row) => seeds[row.binding.propertySchemaId] !== undefined)
    .map((row) => {
      const empty = initialStagedValue(row);
      const seed = seeds[row.binding.propertySchemaId]!;
      return {
        row,
        value:
          empty.kind === "text" || empty.kind === "number" || empty.kind === "date"
            ? { ...empty, text: seed }
            : empty,
      };
    });
}

describe("routeNewNodeClass — the New-popup class-pick routing", () => {
  it("EVERY class pick routes to the modal with that class (source family no longer special)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    expect(routeNewNodeClass(client, SYSTEM_CLASS_UUIDS.journal_article)).toEqual({
      kind: "quick-create",
      classId: SYSTEM_CLASS_UUIDS.journal_article,
    });
    expect(routeNewNodeClass(client, SYSTEM_CLASS_UUIDS.person)).toEqual({
      kind: "quick-create",
      classId: SYSTEM_CLASS_UUIDS.person,
    });
    expect(routeNewNodeClass(client, SYSTEM_CLASS_UUIDS.organization)).toEqual({
      kind: "quick-create",
      classId: SYSTEM_CLASS_UUIDS.organization,
    });
    // User classes route too — the modal is class-driven, not family-driven.
    const userClass = await client.createClass("project");
    expect(routeNewNodeClass(client, userClass)).toEqual({
      kind: "quick-create",
      classId: userClass,
    });
  });

  it("the bare source base resolves to its designed book default", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    expect(routeNewNodeClass(client, SYSTEM_CLASS_UUIDS.source)).toEqual({
      kind: "quick-create",
      classId: SYSTEM_CLASS_UUIDS.book,
    });
  });

  it("an asset pick routes to the asset upload", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    expect(routeNewNodeClass(client, SYSTEM_CLASS_UUIDS.asset)).toEqual({
      kind: "asset-upload",
      classId: SYSTEM_CLASS_UUIDS.asset,
    });
  });

  it("collectSelfAndAncestors falls back to the static system extends", async () => {
    const client = await seedClient();
    // No classes authored at all: the seeded extends map still resolves.
    const lineage = collectSelfAndAncestors(client, SYSTEM_CLASS_UUIDS.book);
    expect(lineage.has(SYSTEM_CLASS_UUIDS.source)).toBe(true);
  });
});

describe("stagedBindingsOf — the dynamic form's row resolution", () => {
  it("resolves the citation rows extends-aware and ALPHABETICAL, excluding object/asset types", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const rows = stagedBindingsOf(client, SYSTEM_CLASS_UUIDS.book);
    const labels = rows.map((row) => row.schema?.name ?? row.binding.name);
    // Alphabetical by property name (the read-time derivation law).
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    // The family base's bindings resolve through the extends chain…
    for (const name of ["Authors", "Citekey", "DOI", "Editors", "ISBN", "Publication date", "Publisher", "URL"]) {
      expect(labels).toContain(name);
    }
    // …and the object/asset-typed bindings never stage (settable later from
    // the metadata panel): linkedAuthors (object), attachments (asset).
    const ids = rows.map((row) => row.binding.propertySchemaId);
    expect(ids).not.toContain(SYSTEM_PROPERTY_UUIDS.linkedAuthors);
    expect(ids).not.toContain(SYSTEM_PROPERTY_UUIDS.attachments);
    // authors is the multi-text monoblock.
    const authors = rows.find((row) => row.binding.propertySchemaId === SYSTEM_PROPERTY_UUIDS.authors);
    expect(authors?.schema?.multi ?? authors?.binding.multi).toBe(true);
  });

  it("synthesizes the seed rows on a fresh workspace (pure read — nothing writes)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const opsBefore = client.undoDepth().undo + client.undoDepth().redo;
    const rows = stagedBindingsOf(client, SYSTEM_CLASS_UUIDS.book);
    expect(rows.length).toBeGreaterThan(0);
    expect(client.undoDepth().undo + client.undoDepth().redo).toBe(opsBefore);
  });

  it("a user class renders exactly its own bound properties", async () => {
    const client = await seedClient();
    const cls = await client.createClass("project");
    const schema = await client.createPropertySchema({ name: "Status", type: "text" });
    await client.setClassProperty(cls, schema, {});
    const rows = stagedBindingsOf(client, cls);
    expect(rows.map((row) => row.binding.propertySchemaId)).toEqual([schema]);
  });
});

describe("parseStagedDateText", () => {
  it("accepts year, month, and day granularities; validates ranges", () => {
    expect(parseStagedDateText("1965")).toEqual({ iso: "1965-01-01", granularity: "year" });
    expect(parseStagedDateText("1965-03")).toEqual({ iso: "1965-03-01", granularity: "month" });
    expect(parseStagedDateText("1965-03-04")).toEqual({ iso: "1965-03-04", granularity: "day" });
    expect(parseStagedDateText("1965-13")).toBeNull();
    expect(parseStagedDateText("1965-03-40")).toBeNull();
    expect(parseStagedDateText("March 1965")).toBeNull();
    expect(parseStagedDateText("")).toBeNull();
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
  it("collects live citekeys and finds the duplicate doi/isbn/citekey source", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const id = await createClassedObject(client, {
      title: "Dune",
      classId: SYSTEM_CLASS_UUIDS.book,
      values: await stagedInput(client, SYSTEM_CLASS_UUIDS.book, {
        [SYSTEM_PROPERTY_UUIDS.doi]: "10.1000/XYZ",
        [SYSTEM_PROPERTY_UUIDS.isbn]: "978-0-123456-78-9",
        [SYSTEM_PROPERTY_UUIDS.citekey]: "Herbert1965Dune",
      }),
    });
    expect(existingCitekeys(client)).toEqual(["Herbert1965Dune"]);
    // DOI compare is case-insensitive; ISBN is digit/X-normalized; citekey
    // compare is case-insensitive (the 2026-10-26 owner addition).
    expect(findSourceByIdentifier(client, { doi: "10.1000/xyz" })?.id).toBe(id);
    expect(findSourceByIdentifier(client, { isbn: "9780123456789" })?.id).toBe(id);
    expect(findSourceByIdentifier(client, { citekey: "herbert1965dune" })?.id).toBe(id);
    expect(findSourceByIdentifier(client, { citekey: "otherkey" })).toBeNull();
    expect(findSourceByIdentifier(client, { doi: "10.9999/other" })).toBeNull();
    expect(findSourceByIdentifier(client, {})).toBeNull();
  });
});

describe("creators — createClassedObject flush", () => {
  it("creates a classed source with plain-text authors, the year chain link, and DOI", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const id = await createClassedObject(client, {
      title: "Dune",
      classId: SYSTEM_CLASS_UUIDS.book,
      values: await stagedInput(client, SYSTEM_CLASS_UUIDS.book, {
        [SYSTEM_PROPERTY_UUIDS.authors]: "Herbert, Frank; Lovelace, Ada",
        [SYSTEM_PROPERTY_UUIDS.doi]: "10.1000/xyz",
        [SYSTEM_PROPERTY_UUIDS.publicationDate]: "1965",
      }),
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

  it("writes editors, isbn, url, publisher, citekey, and venue fields as staged", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    // The venue schemas + class-local bindings (the server seed's pool step).
    await ensureCitationFamily(client, ["publicationTitle", "volume", "issue"]);
    for (const name of ["publicationTitle", "volume", "issue"] as const) {
      await client.setClassProperty(SYSTEM_CLASS_UUIDS.journal_article, SYSTEM_PROPERTY_UUIDS[name], {});
    }
    const id = await createClassedObject(client, {
      title: "An Essay",
      classId: SYSTEM_CLASS_UUIDS.journal_article,
      values: await stagedInput(client, SYSTEM_CLASS_UUIDS.journal_article, {
        [SYSTEM_PROPERTY_UUIDS.editors]: "Smith, Jane; Doe, John",
        [SYSTEM_PROPERTY_UUIDS.isbn]: "978-0-123456-78-9",
        [SYSTEM_PROPERTY_UUIDS.url]: "https://example.test/essay",
        [SYSTEM_PROPERTY_UUIDS.publisher]: "Acme Press",
        [SYSTEM_PROPERTY_UUIDS.citekey]: "smith2024essay",
        [SYSTEM_PROPERTY_UUIDS.publicationTitle]: "The Example Journal",
        [SYSTEM_PROPERTY_UUIDS.volume]: "12",
        [SYSTEM_PROPERTY_UUIDS.issue]: "3",
      }),
    });

    const rows = client.getEffectiveProperties(id);
    const valueOf = (schemaId: string) =>
      rows.filter((row) => row.propertySchemaId === schemaId).map((row) => row.value);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.editors)).toEqual(["Smith, Jane", "Doe, John"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.isbn)).toEqual(["978-0-123456-78-9"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.url)).toEqual(["https://example.test/essay"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.publisher)).toEqual(["Acme Press"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.citekey)).toEqual(["smith2024essay"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.publicationTitle)).toEqual(["The Example Journal"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.volume)).toEqual(["12"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.issue)).toEqual(["3"]);
  });

  it("stages boolean, select, and number values into their wire shapes", async () => {
    const client = await seedClient();
    const cls = await client.createClass("reading");
    const done = await client.createPropertySchema({ name: "Done", type: "boolean" });
    const mood = await client.createPropertySchema({
      name: "Mood",
      type: "select",
      options: [
        { id: "00000000-0000-0000-0009-000000000001", label: "calm" },
        { id: "00000000-0000-0000-0009-000000000002", label: "tense" },
      ],
    });
    const pages = await client.createPropertySchema({ name: "Pages", type: "number" });
    await client.setClassProperty(cls, done, {});
    await client.setClassProperty(cls, mood, {});
    await client.setClassProperty(cls, pages, {});

    const rows = stagedBindingsOf(client, cls);
    const entries = rows.map((row) => {
      const id = row.binding.propertySchemaId;
      if (id === done) return { row, value: { kind: "boolean" as const, value: true } };
      if (id === mood) {
        return { row, value: { kind: "select" as const, optionIds: ["00000000-0000-0000-0009-000000000002"] } };
      }
      return { row, value: { kind: "number" as const, text: "42" } };
    });
    const id = await createClassedObject(client, { title: "A read", classId: cls, values: entries });

    const rowsOut = client.getEffectiveProperties(id);
    const valueOf = (schemaId: string) =>
      rowsOut.filter((row) => row.propertySchemaId === schemaId).map((row) => row.value);
    expect(valueOf(done)).toEqual([true]);
    expect(valueOf(mood)).toEqual(["00000000-0000-0000-0009-000000000002"]);
    expect(valueOf(pages)).toEqual([42]);
  });

  it("rejects an invalid staged date/number BEFORE anything writes", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const depthBefore = client.undoDepth().undo;
    await expect(
      createClassedObject(client, {
        title: "Broken",
        classId: SYSTEM_CLASS_UUIDS.book,
        values: await stagedInput(client, SYSTEM_CLASS_UUIDS.book, {
          [SYSTEM_PROPERTY_UUIDS.publicationDate]: "last march",
        }),
      }),
    ).rejects.toThrow();
    // Nothing created, nothing journaled.
    expect(client.listPages().length).toBe(0);
    expect(client.undoDepth().undo).toBe(depthBefore);
  });

  it("un-archive + create + property writes ride ONE undo batch (the archived-class gesture)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    // Archive the book type-class (the class-visibility flag).
    await client.setArchived(SYSTEM_CLASS_UUIDS.book, false);
    expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.book)?.isActive).toBe(false);
    const depthBefore = client.undoDepth().undo;

    const id = await createClassedObject(client, {
      title: "Archived Type Create",
      classId: SYSTEM_CLASS_UUIDS.book,
      values: await stagedInput(client, SYSTEM_CLASS_UUIDS.book, {
        [SYSTEM_PROPERTY_UUIDS.doi]: "10.1000/archived",
      }),
      unarchiveArchivedClass: true,
    });
    expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.book)?.isActive).toBe(true);
    expect(client.getNode(id)).not.toBeNull();

    // ONE journal entry for the whole gesture (un-archive + create +
    // property write): a single undo archives the class back AND trashes
    // the created source (the create's inverse is the soft trash — the row
    // survives inactive).
    expect(client.undoDepth().undo).toBe(depthBefore + 1);
    await client.undo();
    expect(client.getNodeRaw(SYSTEM_CLASS_UUIDS.book)?.isActive).toBe(false);
    expect(client.getNodeRaw(id)?.isActive).toBe(false);
  });

  it("does not un-archive a live class (the flag is a no-op there)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const depthBefore = client.undoDepth().undo;
    const id = await createClassedObject(client, {
      title: "Live Type Create",
      classId: SYSTEM_CLASS_UUIDS.book,
      values: [],
      unarchiveArchivedClass: true,
    });
    expect(client.getNode(id)).not.toBeNull();
    // A single journal entry (the create alone — no un-archive op).
    expect(client.undoDepth().undo).toBe(depthBefore + 1);
  });
});

describe("QuickCreateModal via the picker create row", () => {
  it("a book-filtered picker create row opens the class modal and links the result", async () => {
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
    expect(within(dialog).getByLabelText("Publication date")).not.toBeNull();
    expect(within(dialog).getByLabelText("DOI")).not.toBeNull();
    // The retired source subclass switch is gone.
    expect(within(dialog).queryByLabelText("Type")).toBeNull();

    fireEvent.change(within(dialog).getByLabelText("Authors"), {
      target: { value: "Frank Herbert" },
    });
    fireEvent.change(within(dialog).getByLabelText("Publication date"), {
      target: { value: "1965" },
    });
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

  it("cancel leaves ZERO log entries — nothing created, nothing journaled", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const pagesBefore = client.listPages().length;
    const depthBefore = client.undoDepth().undo;
    render(
      <QuickCreateModal
        isOpen
        client={client}
        classId={SYSTEM_CLASS_UUIDS.book}
        initialName="Dune"
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /new book/i });
    fireEvent.change(within(dialog).getByLabelText("Authors"), {
      target: { value: "Herbert, Frank" },
    });
    fireEvent.change(within(dialog).getByLabelText("Publication date"), {
      target: { value: "1965" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    expect(client.listPages().length).toBe(pagesBefore);
    expect(client.undoDepth().undo).toBe(depthBefore);
  });

  it("a person-filtered picker opens the person modal — no agent toggle, title seeded", async () => {
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
    // The retired person/organization toggle is gone; the given/family rows
    // render from the person's bound properties, the typed query seeds the
    // TITLE (title-is-content — no name splitting).
    expect(within(dialog).queryByLabelText("Type")).toBeNull();
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("Frank Herbert");
    expect(within(dialog).getByLabelText("Given name")).not.toBeNull();
    expect(within(dialog).getByLabelText("Family name")).not.toBeNull();
  });

  it("a user-class filter opens the modal with that class", async () => {
    const client = await seedClient();
    const cls = await client.createClass("project");
    const schema = await client.createPropertySchema({ name: "Status", type: "text" });
    await client.setClassProperty(cls, schema, {});
    render(
      <NodeSelector
        client={client}
        trigger="inline"
        searchMode="all"
        classFilters={[cls]}
        onAdd={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "Fleet revamp" } });
    fireEvent.click(screen.getByText('Create "Fleet revamp"'));
    const dialog = await screen.findByRole("dialog", { name: /new project/i });
    expect(within(dialog).getByLabelText("Status")).not.toBeNull();
  });

  it("a source-filtered create row with an identifier-shaped query opens the add-source dialog", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    render(
      <>
        <NodeSelector
          client={client}
          trigger="inline"
          searchMode="all"
          classFilters={[SYSTEM_CLASS_UUIDS.book]}
          onAdd={() => {}}
        />
        <AddSourceHost
          client={client}
          serverUrl="http://resolver.test"
          credential="test-key"
          onCreated={() => {}}
          onOpenNode={() => {}}
        />
      </>,
    );

    // The typed identifier rides the create row into the resolver dialog;
    // the resolved record's own type picks the prefill (the class lock was
    // retired with round 4 — resolution asserts the prefill mapping).
    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "10.1000/xyz" } });
    fireEvent.click(screen.getByText('Create "10.1000/xyz"'));
    const dialog = await screen.findByRole("dialog", { name: "Add source" });
    expect(
      (within(dialog).getByLabelText("Identifier or link") as HTMLInputElement).value,
    ).toBe("10.1000/xyz");
    // The bare QuickCreateModal is NOT the create-row destination anymore.
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("the same create row opens the dialog with the honest resolver-off note when the resolver is off", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    // The resolver gate read: only an explicit false disables.
    await client.setFeatureSettings("sources", { resolverEnabled: false });
    render(
      <>
        <NodeSelector
          client={client}
          trigger="inline"
          searchMode="all"
          classFilters={[SYSTEM_CLASS_UUIDS.book]}
          onAdd={() => {}}
        />
        <AddSourceHost
          client={client}
          serverUrl="http://resolver.test"
          credential="test-key"
          onCreated={() => {}}
          onOpenNode={() => {}}
        />
      </>,
    );

    fireEvent.change(screen.getByLabelText("Search..."), { target: { value: "10.1000/xyz" } });
    fireEvent.click(screen.getByText('Create "10.1000/xyz"'));

    // An IDENTIFIER (not a bare URL) opens the dialog itself, honest about
    // the disabled resolver (the note), the typed input prefilled. No
    // dead-end, no silent fallback.
    const dialog = await screen.findByRole("dialog", { name: "Add source" });
    expect(within(dialog).getByText(/resolver is turned off/i)).not.toBeNull();
    expect(
      (within(dialog).getByLabelText("Identifier or link") as HTMLInputElement).value,
    ).toBe("10.1000/xyz");
  });

  it("no class filter keeps the plain create row", async () => {
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

describe("QuickCreateModal citation behaviors", () => {
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
        classId={SYSTEM_CLASS_UUIDS.book}
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
    fireEvent.change(within(dialog).getByLabelText("Publication date"), {
      target: { value: "1965" },
    });
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
        classId={SYSTEM_CLASS_UUIDS.book}
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
    fireEvent.change(within(secondDialog).getByLabelText("Publication date"), {
      target: { value: "1965" },
    });
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
        classId={SYSTEM_CLASS_UUIDS.book}
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
    fireEvent.change(within(dialog).getByLabelText("Publication date"), {
      target: { value: "1965" },
    });
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
        classId={SYSTEM_CLASS_UUIDS.book}
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
        classId={SYSTEM_CLASS_UUIDS.book}
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
    await createClassedObject(client, {
      title: "Existing paper",
      classId: SYSTEM_CLASS_UUIDS.journal_article,
      values: await stagedInput(client, SYSTEM_CLASS_UUIDS.journal_article, {
        [SYSTEM_PROPERTY_UUIDS.doi]: "10.1000/xyz",
      }),
    });

    const opened: string[] = [];
    let createdId = "";
    render(
      <QuickCreateModal
        isOpen
        client={client}
        classId={SYSTEM_CLASS_UUIDS.journal_article}
        prefill={{
          title: "Duplicate import",
          values: {
            [SYSTEM_PROPERTY_UUIDS.authors]: "Someone, Else",
            [SYSTEM_PROPERTY_UUIDS.doi]: "10.1000/xyz",
          },
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

  it("warns on an exact title match (same class) with the open-existing affordance; a near-match does not", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const existingId = await createClassedObject(client, {
      title: "Dune",
      classId: SYSTEM_CLASS_UUIDS.book,
      values: [],
    });

    const opened: string[] = [];
    let createdId = "";
    render(
      <QuickCreateModal
        isOpen
        client={client}
        classId={SYSTEM_CLASS_UUIDS.book}
        onClose={() => {}}
        onCreated={(id) => {
          createdId = id;
        }}
        onOpenExisting={(id) => opened.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /new book/i });

    // The exact title (whitespace tolerated) warns — live, as the title
    // changes — and offers the existing node.
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "  Dune  " } });
    expect(
      within(dialog).getByText(/titled "Dune" already exists/i),
    ).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Dune" }));
    expect(opened).toEqual([existingId]);

    // A near-match (case differs — the compare is exact) does NOT warn, and
    // Create proceeds.
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "dune" } });
    expect(within(dialog).queryByText(/already exists/i)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Title"), {
      target: { value: "Dune Messiah" },
    });
    expect(within(dialog).queryByText(/already exists/i)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(createdId).not.toBe(""));
    expect(createdId).not.toBe(existingId);
  });

  it("warns on a duplicate ISBN and on a duplicate CITEKEY", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await createClassedObject(client, {
      title: "Existing book",
      classId: SYSTEM_CLASS_UUIDS.book,
      values: await stagedInput(client, SYSTEM_CLASS_UUIDS.book, {
        [SYSTEM_PROPERTY_UUIDS.isbn]: "9780123456789",
        [SYSTEM_PROPERTY_UUIDS.citekey]: "herbert1965dune",
      }),
    });

    // Duplicate ISBN (digit-normalized compare).
    const { unmount: unmountIsbn } = render(
      <QuickCreateModal
        isOpen
        client={client}
        classId={SYSTEM_CLASS_UUIDS.book}
        initialName="Another copy"
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );
    const isbnDialog = await screen.findByRole("dialog", { name: /new book/i });
    fireEvent.change(within(isbnDialog).getByLabelText("ISBN"), {
      target: { value: "978-0-123456-78-9" },
    });
    expect(within(isbnDialog).getByText(/already in your library/i)).not.toBeNull();
    unmountIsbn();

    // Duplicate citekey (case-insensitive compare) on a manual value — the
    // auto-generator would have suffixed, so the warning is the typed key's.
    render(
      <QuickCreateModal
        isOpen
        client={client}
        classId={SYSTEM_CLASS_UUIDS.book}
        initialName="A different edition"
        onClose={() => {}}
        onCreated={() => {}}
      />,
    );
    const citekeyDialog = await screen.findByRole("dialog", { name: /new book/i });
    fireEvent.change(within(citekeyDialog).getByLabelText("Citekey"), {
      target: { value: "HERBERT1965DUNE" },
    });
    expect(within(citekeyDialog).getByText(/already in your library/i)).not.toBeNull();
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
        classId={SYSTEM_CLASS_UUIDS.journal_article}
        prefill={{
          title: "Resolved paper",
          values: {
            [SYSTEM_PROPERTY_UUIDS.authors]: "Lovelace, Ada; Turing, Alan",
            [SYSTEM_PROPERTY_UUIDS.publicationDate]: "1843",
            [SYSTEM_PROPERTY_UUIDS.doi]: "10.1000/resolved",
            [SYSTEM_PROPERTY_UUIDS.publicationTitle]: "The Example Journal",
            [SYSTEM_PROPERTY_UUIDS.volume]: "7",
          },
        }}
        onClose={() => {}}
        onCreated={(id) => {
          createdId = id;
        }}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /new journal_article/i });
    // The prefill's venue fields render as staged rows (synthesized off the
    // prefill on a fresh workspace) and carry the seeded values.
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
    // The venue values flushed too (the flush-time self-heal authored the
    // schemas + class-local bindings before the property writes).
    const venue = client
      .getEffectiveProperties(createdId)
      .find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.publicationTitle);
    expect(venue?.value).toBe("The Example Journal");
  });
});

describe("expandStagedValues", () => {
  it("writes nothing for untouched rows (empty text, unselected, untouched boolean)", async () => {
    const client = await seedClient();
    const cls = await client.createClass("bare");
    const flag = await client.createPropertySchema({ name: "Flag", type: "boolean" });
    const note = await client.createPropertySchema({ name: "Note", type: "text" });
    await client.setClassProperty(cls, flag, {});
    await client.setClassProperty(cls, note, {});
    const rows = stagedBindingsOf(client, cls);
    const writes = await expandStagedValues(
      client,
      rows.map((row) => ({ row, value: initialStagedValue(row) })),
    );
    expect(writes).toEqual([]);
  });
});
