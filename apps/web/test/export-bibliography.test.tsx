/**
 * Bibliography export (source-library slices 3–6 task 2): the export
 * modal's BibTeX + CSL JSON cards — node-set formats delivering ONE
 * document over the current selection (the JSON-archive convention, no
 * per-root zip), each collected node projected through the package's
 * nodeToCsl (the dual-track read contract). Harness: jsdom over the
 * in-process WorkspaceClient, same conventions as modals-overlays.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { parseBibtex } from "@notees/export";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { ExportPageModal } from "../src/features/export/ExportPageModal.js";

const WS = "0192a000-0000-7000-8000-0000000000c1";
const ACTOR = "0192a000-0000-7000-8000-0000000000c2";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
});

async function makeClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** Capture downloadBlob's anchor + blob (jsdom has no URL.createObjectURL). */
function stubDownload() {
  const captured: { blob: Blob | null; anchor: HTMLAnchorElement | null; restore: () => void } = {
    blob: null,
    anchor: null,
    restore: () => {},
  };
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn((blob: Blob) => {
      captured.blob = blob;
      return "blob:mock";
    }),
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      captured.anchor = this;
    });
  captured.restore = () => click.mockRestore();
  return captured;
}

/** Read a Blob as UTF-8 text in jsdom (whose Blob has no text()). */
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/**
 * A journal_article source with the full pool set: citekey, free-text
 * authors, a linked publication year, and the container fields through the
 * class's system bindings.
 */
async function seedJournalSource(client: WorkspaceClient, parentId?: string): Promise<string> {
  const sourceId = await client.createObject({
    isEmbedded: false,
    name: "A Study of Things",
    ...(parentId !== undefined ? { parentId } : {}),
    classIds: [SYSTEM_CLASS_UUIDS.journal_article],
  });
  await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.citekey, "curie2024", 0);
  await client.setProperty(
    sourceId,
    SYSTEM_PROPERTY_UUIDS.authors,
    ["Curie, Marie", "Sklodowska, Pierre"],
    0,
  );
  await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.publicationTitle, "Journal of Examples", 0);
  await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.volume, "7", 0);
  await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.issue, "2", 0);
  await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.pages, "1–12", 0);
  await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.doi, "10.1000/xyz", 0);
  await client.setDatetimeProperty(sourceId, SYSTEM_PROPERTY_UUIDS.publicationDate, {
    iso: "1962-01-01",
  });
  // A body block: content, not a source — it must never become an entry.
  await client.createObject({
    parentId: sourceId,
    contentAst: [{ type: "text", text: "Draft notes paragraph" }],
  });
  return sourceId;
}

describe("ExportPageModal bibliography cards", () => {
  it("lists the BibTeX and CSL JSON cards as available formats", async () => {
    const client = await makeClient();
    const pageId = await client.createObject({ isEmbedded: false, name: "Trip" });

    render(<ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={pageId} />);
    await screen.findByLabelText("markdown preview", undefined, { timeout: 2000 });

    expect(screen.getByRole("radio", { name: /bibtex/i })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("radio", { name: /csl json/i })).not.toHaveAttribute("aria-disabled");
  }, 10000);

  it("downloads ONE .bib over the batch selection — every source an entry, body blocks none", async () => {
    const client = await makeClient();
    const sourceA = await seedJournalSource(client);
    const sourceB = await client.createObject({
      isEmbedded: false,
      name: "A Long Book",
      classIds: [SYSTEM_CLASS_UUIDS.book],
    });
    await client.setProperty(sourceB, SYSTEM_PROPERTY_UUIDS.citekey, "doe2020", 0);
    await client.setProperty(sourceB, SYSTEM_PROPERTY_UUIDS.authors, ["Doe, Jane"], 0);
    await client.setProperty(sourceB, SYSTEM_PROPERTY_UUIDS.publisher, "Example Press", 0);

    const download = stubDownload();
    render(
      <ExportPageModal
        isOpen={true}
        onClose={() => {}}
        client={client}
        nodeUuids={[sourceA, sourceB]}
      />,
    );
    await screen.findByLabelText("markdown preview", undefined, { timeout: 2000 });

    fireEvent.click(screen.getByRole("radio", { name: /bibtex/i }));
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    await vi.waitFor(() => expect(download.anchor).not.toBeNull());
    // ONE document for the whole selection (the archive convention — no zip).
    expect(download.anchor!.getAttribute("download")).toMatch(
      /^A-Study-of-Things-\d{12}\.bib$/,
    );
    expect(download.blob!.type).toBe("application/x-bibtex");

    const text = await readBlobText(download.blob!);
    expect(text).toContain("@article{curie2024,");
    expect(text).toContain("@book{doe2020,");
    // Body blocks and unselected nodes never become entries.
    expect(text).not.toContain("Draft notes paragraph");

    const entries = parseBibtex(text);
    expect(entries.map((entry) => entry.citeKey)).toEqual(["curie2024", "doe2020"]);
    const article = entries[0]!;
    expect(article.fields.title).toBe("A Study of Things");
    expect(article.fields.author).toBe("Curie, Marie and Sklodowska, Pierre");
    expect(article.fields.journal).toBe("Journal of Examples");
    expect(article.fields.year).toBe("1962");
    expect(article.fields.volume).toBe("7");
    expect(article.fields.number).toBe("2");
    expect(article.fields.pages).toBe("1–12");
    expect(article.fields.doi).toBe("10.1000/xyz");
    expect(entries[1]!.fields.publisher).toBe("Example Press");

    download.restore();
  }, 10000);

  it("downloads the CSL-JSON item array when the CSL JSON card is selected", async () => {
    const client = await makeClient();
    const sourceId = await seedJournalSource(client);

    const download = stubDownload();
    render(
      <ExportPageModal
        isOpen={true}
        onClose={() => {}}
        client={client}
        nodeUuid={sourceId}
        nodeName="A Study of Things"
      />,
    );
    await screen.findByLabelText("markdown preview", undefined, { timeout: 2000 });

    fireEvent.click(screen.getByRole("radio", { name: /csl json/i }));
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    await vi.waitFor(() => expect(download.anchor).not.toBeNull());
    expect(download.anchor!.getAttribute("download")).toMatch(/^A-Study-of-Things-\d{12}\.json$/);
    expect(download.blob!.type).toBe("application/vnd.citationstyles.csl+json");

    const items = JSON.parse(await readBlobText(download.blob!)) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(
      expect.objectContaining({
        id: "curie2024",
        type: "article-journal",
        title: "A Study of Things",
        author: [
          { family: "Curie", given: "Marie" },
          { family: "Sklodowska", given: "Pierre" },
        ],
        "container-title": "Journal of Examples",
        volume: "7",
        issue: "2",
        page: "1–12",
        DOI: "10.1000/xyz",
        issued: { "date-parts": [[1962]] },
      }),
    );

    download.restore();
  }, 10000);

  it("derives author names from linkedAuthors agents when the authors property is empty", async () => {
    const client = await makeClient();
    const personId = await client.createObject({ isEmbedded: false, name: "Ada Lovelace" });
    await client.assignClass(personId, SYSTEM_CLASS_UUIDS.person);
    await client.setProperty(personId, SYSTEM_PROPERTY_UUIDS.givenName, "Ada", 0);
    await client.setProperty(personId, SYSTEM_PROPERTY_UUIDS.familyName, "Lovelace", 0);

    const sourceId = await client.createObject({
      isEmbedded: false,
      name: "Notes on the Analytical Engine",
      classIds: [SYSTEM_CLASS_UUIDS.book],
    });
    await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.citekey, "lovelace1843", 0);
    // No authors rows — the read contract falls back to the people graph.
    await client.setProperty(sourceId, SYSTEM_PROPERTY_UUIDS.linkedAuthors, [{ nodeId: personId }], 0);

    const download = stubDownload();
    render(
      <ExportPageModal
        isOpen={true}
        onClose={() => {}}
        client={client}
        nodeUuid={sourceId}
        nodeName="Notes on the Analytical Engine"
      />,
    );
    await screen.findByLabelText("markdown preview", undefined, { timeout: 2000 });

    fireEvent.click(screen.getByRole("radio", { name: /bibtex/i }));
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    await vi.waitFor(() => expect(download.anchor).not.toBeNull());
    const entries = parseBibtex(await readBlobText(download.blob!));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fields.author).toBe("Lovelace, Ada");
    // The agent node is a ref target, not a subtree node — no entry of its own.
    expect(entries[0]!.citeKey).toBe("lovelace1843");

    download.restore();
  }, 10000);

  it("honors Include child pages: child sources drop out when the subtree option is off", async () => {
    const client = await makeClient();
    const libraryId = await client.createObject({ isEmbedded: false, name: "Sources" });
    const childId = await seedJournalSource(client, libraryId);

    const download = stubDownload();
    render(
      <ExportPageModal isOpen={true} onClose={() => {}} client={client} nodeUuid={libraryId} nodeName="Sources" />,
    );
    await screen.findByLabelText("markdown preview", undefined, { timeout: 2000 });

    fireEvent.click(screen.getByRole("radio", { name: /bibtex/i }));
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    await vi.waitFor(() => expect(download.anchor).not.toBeNull());
    let entries = parseBibtex(await readBlobText(download.blob!));
    // The selected root is a node of the set too (the total nodeToCsl
    // contract — an unclassed node exports as @misc); the child source
    // rides with includeChildPages on.
    expect(entries.map((entry) => entry.entryType).sort()).toEqual(["article", "misc"]);

    download.anchor = null;
    fireEvent.click(screen.getByRole("checkbox", { name: /include child pages/i }));
    fireEvent.click(screen.getByRole("button", { name: /^export$/i }));

    await vi.waitFor(() => expect(download.anchor).not.toBeNull());
    entries = parseBibtex(await readBlobText(download.blob!));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entryType).toBe("misc");
    expect(entries[0]!.fields.title).toBe("Sources");
    expect(entries.some((entry) => entry.citeKey === "curie2024")).toBe(false);
    expect(childId).not.toBe(entries[0]!.citeKey);

    download.restore();
  }, 10000);
});
