/**
 * Add-source tests: the resolver client's input classification + request
 * plumbing (mocked fetch), the AddSourceDialog direct-create flow (inline
 * Fetch → preview → Create writes the source node straight to the workspace —
 * no form in between; the manual path keeps the QuickCreateModal), the inline
 * "Already in your library" duplicate pause (Create anyway / Cancel /
 * open-existing), the open-access PDF link row (removable; a picked file
 * supersedes it), the error paths (422 no_identifier_found, 403
 * resolver_disabled, 404, network), the PDF multipart path (mocked server +
 * the CAS upload attach), and the app-level host routing (a bare URL with the
 * resolver off creates a plain web_page weblink; an identifier opens the
 * dialog with the settings note).
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS, deriveDisplayName } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import {
  ResolverRequestError,
  classifySourceInput,
  resolvePdfFile,
  resolveSourceInput,
} from "../src/features/sources/resolver.js";
import { AddSourceDialog } from "../src/features/sources/AddSourceDialog.js";
import { AddSourceHost, requestAddSource } from "../src/features/sources/AddSourceHost.js";
import { ensureCitationFamily } from "../src/features/modals/quickCreate.js";

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
  vi.unstubAllGlobals();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
    serverUrl: "http://resolver.test",
    apiKey: "test-key",
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

/** Author the source/agent family the way the server seed does. */
async function seedFamilies(client: WorkspaceClient): Promise<void> {
  for (const name of ["source", "book", "journal_article", "agent", "person", "organization", "web_page"] as const) {
    await client.createClass(name, { id: SYSTEM_CLASS_UUIDS[name] });
  }
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.book, [SYSTEM_CLASS_UUIDS.source]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.journal_article, [SYSTEM_CLASS_UUIDS.source]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.web_page, [SYSTEM_CLASS_UUIDS.source]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.person, [SYSTEM_CLASS_UUIDS.agent]);
  await client.setClassExtends(SYSTEM_CLASS_UUIDS.organization, [SYSTEM_CLASS_UUIDS.agent]);
}

const DOI_RECORD = {
  classKey: "journal_article",
  title: "On the Analytical Engine",
  authors: ["Lovelace, Ada", "Turing, Alan"],
  editors: ["Babbage, Charles"],
  fields: { publicationTitle: "The Example Journal", volume: "7", issue: "3" },
  doi: "10.1000/xyz",
  url: "https://example.test/paper",
  year: 1843,
  publisher: "Acme Press",
};

const BOOK_RECORD = {
  classKey: "book",
  title: "An Example Book",
  authors: ["Author, Some"],
  editors: [],
  fields: { place: "London", numPages: "123" },
  isbn: "9780123456789",
  year: 2001,
  publisher: "Example Press",
};

const PMID_RECORD = {
  classKey: "journal_article",
  title: "A PubMed Article",
  authors: ["Curie, Marie"],
  editors: [],
  fields: { publicationTitle: "The Medical Journal" },
  pmid: "25495683",
  year: 2015,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch stub dispatching on the URL: resolve (query), resolve/pdf, assets. */
function stubFetch(routes: (url: string, init?: RequestInit) => Response | undefined): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const hit = routes(url, init);
    if (hit !== undefined) return hit;
    return jsonResponse(404, { error: { code: "not_found", message: `no stub for ${url}`, status: 404 } });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * Pick a PDF through the dialog's FileDropZone: the visible surface is the
 * drop-zone button (named "PDF file" by the dialog's section label through
 * aria-labelledby; the bare native "Browse…" input retired), the change
 * event fires on the zone's hidden input — the asset-upload-modal register.
 */
function pickPdf(dialog: HTMLElement, file: File): void {
  const zone = within(dialog).getByRole("button", { name: "PDF file" });
  const input = zone.parentElement?.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  fireEvent.change(input!, { target: { files: [file] } });
}

/**
 * The direct-create flow's first-step assertion: the successful fetch renders
 * the inline preview card (role="status"); the primary "Create" only enables
 * then.
 */
async function previewCardOf(dialog: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => {
    expect(dialog.querySelector(".add-source-dialog__preview--card")).not.toBeNull();
  });
  const card = dialog.querySelector(".add-source-dialog__preview--card") as HTMLElement;
  expect(card.getAttribute("role")).toBe("status");
  return card;
}

/** The direct-create flow: Fetch resolves, the preview lands, Create writes the node. */
async function fetchAndCreate(dialog: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
  const card = await previewCardOf(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
  return card;
}

/** The footer primary (Create) — disabled until a fetch succeeded. */
function createButtonOf(host: HTMLElement): HTMLButtonElement {
  const footer = host.querySelector(".modal__footer");
  expect(footer).not.toBeNull();
  return within(footer as HTMLElement).getByRole("button", { name: /^create$/i }) as HTMLButtonElement;
}

describe("classifySourceInput", () => {
  it("classifies DOIs (bare and doi.org URLs)", () => {
    expect(classifySourceInput("10.1000/xyz")).toEqual({ kind: "doi", value: "10.1000/xyz" });
    expect(classifySourceInput("https://doi.org/10.1000/xyz")).toEqual({
      kind: "doi",
      value: "10.1000/xyz",
    });
    expect(classifySourceInput("10.1000/xyz.")).toEqual({ kind: "doi", value: "10.1000/xyz" });
  });

  it("classifies ISBNs (10/13, separators tolerated)", () => {
    expect(classifySourceInput("978-0-123456-78-9")).toEqual({
      kind: "isbn",
      value: "978-0-123456-78-9",
    });
    expect(classifySourceInput("0-123456-78-9")).toEqual({ kind: "isbn", value: "0-123456-78-9" });
  });

  it("classifies arXiv ids and URLs (version + .pdf suffix normalized)", () => {
    expect(classifySourceInput("arXiv:2401.12345")).toEqual({ kind: "arxiv", value: "2401.12345" });
    expect(classifySourceInput("https://arxiv.org/abs/2401.12345v2")).toEqual({
      kind: "arxiv",
      value: "2401.12345",
    });
    expect(classifySourceInput("https://arxiv.org/pdf/2401.12345.pdf")).toEqual({
      kind: "arxiv",
      value: "2401.12345",
    });
  });

  it("classifies PMIDs (explicit prefix, PubMed URL, legacy URL, bare digits)", () => {
    expect(classifySourceInput("PMID: 25495683")).toEqual({ kind: "pmid", value: "25495683" });
    expect(classifySourceInput("pmid 25495683")).toEqual({ kind: "pmid", value: "25495683" });
    expect(classifySourceInput("https://pubmed.ncbi.nlm.nih.gov/25495683")).toEqual({
      kind: "pmid",
      value: "25495683",
    });
    expect(classifySourceInput("https://ncbi.nlm.nih.gov/pubmed/25495683")).toEqual({
      kind: "pmid",
      value: "25495683",
    });
    expect(classifySourceInput("25495683")).toEqual({ kind: "pmid", value: "25495683" });
  });

  it("never confuses a bare 8-digit PMID with a 10/13-digit ISBN", () => {
    // An 8-digit number is never ISBN-shaped — bare short numbers are PMIDs.
    expect(classifySourceInput("25495683")).toEqual({ kind: "pmid", value: "25495683" });
    expect(classifySourceInput("9780123456")).toEqual({ kind: "isbn", value: "9780123456" });
    expect(classifySourceInput("9780123456789")).toEqual({ kind: "isbn", value: "9780123456789" });
  });

  it("classifies ADS bibcodes (bare 19-char and adsabs URLs); a non-bibcode 19-char string fails loud", () => {
    expect(classifySourceInput("2015JCliP..42S.158D")).toEqual({
      kind: "ads",
      value: "2015JCliP..42S.158D",
    });
    expect(classifySourceInput("https://ui.adsabs.harvard.edu/abs/2015JCliP..42S.158D")).toEqual({
      kind: "ads",
      value: "2015JCliP..42S.158D",
    });
    expect(
      classifySourceInput("https://adsabs.harvard.edu/link_gateway/2015JCliP..42S.158D"),
    ).toEqual({ kind: "ads", value: "2015JCliP..42S.158D" });
    // 19 chars but not the canonical bibcode shape — no silent ads match.
    expect(classifySourceInput("thisisnotabibcodexx")).toBeNull();
  });

  it("classifies plain http(s) URLs; rejects ordinary text and empties", () => {
    expect(classifySourceInput("https://example.test/paper.pdf")).toEqual({
      kind: "url",
      url: "https://example.test/paper.pdf",
    });
    expect(classifySourceInput("not an identifier")).toBeNull();
    expect(classifySourceInput("")).toBeNull();
    expect(classifySourceInput("   ")).toBeNull();
  });
});

describe("AddSourceDialog", () => {
  it("the PDF pick rides the fleet FileDropZone with the selected-file row (the bare native input retired)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    stubFetch(() => undefined);
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });

    // The drop-zone register replaces the bare "Examinar"-style file input:
    // the visible surface is the zone button (named by the dialog's section
    // label through aria-labelledby), the input is its hidden child.
    const zone = within(dialog).getByRole("button", { name: "PDF file" });
    expect(zone).toHaveAccessibleName("PDF file");
    const input = zone.parentElement?.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input!.accept).toBe("application/pdf,.pdf");

    // A pick swaps the zone for the selected row (filename + change/remove)
    // and fills the AssetUploadModal-register preview (name + category chip).
    const file = new File(["%PDF-fake"], "paper.pdf", { type: "application/pdf" });
    fireEvent.change(input!, { target: { files: [file] } });
    const preview = dialog.querySelector(".add-source-dialog__preview") as HTMLElement;
    expect(preview).not.toBeNull();
    expect(within(preview).getByText("paper.pdf")).toBeTruthy();
    expect(within(preview).getByText("Document")).toBeTruthy();
    within(dialog).getByRole("button", { name: /remove file/i });

    // …and the actions split: the footer carries Cancel · Create (Create
    // disabled until a fetch lands — no Fetch, no Next in the footer); Fetch
    // lives INLINE in the field's row, PRIMARY while no fetch is in hand.
    const create = createButtonOf(dialog);
    expect(create.disabled).toBe(true);
    const footer = dialog.querySelector(".modal__footer") as HTMLElement;
    expect(within(footer).queryByRole("button", { name: /^fetch$/i })).toBeNull();
    expect(within(footer).queryByRole("button", { name: /^next$/i })).toBeNull();
    const fetchRow = dialog.querySelector(".add-source-dialog__fetch-row") as HTMLElement;
    expect(fetchRow).not.toBeNull();
    const fetch = within(fetchRow).getByRole("button", { name: /^fetch$/i }) as HTMLButtonElement;
    expect(fetch.classList.contains("bg-primary")).toBe(true);
  });

  it("the resolved record's own classKey creates the node directly (the class lock retired, round 4)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    // The server-seeded state: the citation schemas exist, so the staged
    // entries carry the real types (publicationDate → the date chain).
    await ensureCitationFamily(client);
    stubFetch((url) => {
      if (url.includes("/api/resolve?doi=")) return jsonResponse(200, DOI_RECORD);
      return undefined;
    });
    const created: string[] = [];
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
        onCreated={(id) => created.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "10.1000/xyz" },
    });

    // Fetch resolves and the preview card lands (title, the authors · year ·
    // venue meta line, the DOI identifier line)…
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    const card = await previewCardOf(dialog);
    expect(within(card).getByText("On the Analytical Engine")).not.toBeNull();
    expect(
      within(card).getByText(/lovelace, ada, turing, alan · 1843 · the example journal/i),
    ).not.toBeNull();
    expect(within(card).getByText(/doi 10\.1000\/xyz/i)).not.toBeNull();

    // …and Create writes the node DIRECTLY — the record resolves to a
    // journal_article, no form in between (the resolver knows the type).
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(created.length).toBe(1));
    const node = client.getNode(created[0]!);
    expect(node?.classIds).toContain(SYSTEM_CLASS_UUIDS.journal_article);
    expect(deriveDisplayName(node!)).toBe("On the Analytical Engine");
  });

  it("creates the source directly on a FRESH workspace too (the flush re-derives the staged kinds after the citation self-heal)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    // NO ensureCitationFamily pre-call: the workspace carries no citation
    // property schemas yet — the direct create must self-heal them and the
    // staged publicationDate (text at stage time) must land as a DATE value.
    const fetchMock = stubFetch((url) => {
      if (url.includes("/api/resolve?doi=")) return jsonResponse(200, DOI_RECORD);
      return undefined;
    });
    const created: string[] = [];
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
        onCreated={(id) => created.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "10.1000/xyz" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await previewCardOf(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(created.length).toBe(1));
    expect(fetchMock).not.toBeNull();
    // The year landed as a DATE-chain reference, not a raw string (the
    // re-kind worked) — and the citation schemas self-healed on the way.
    const effective = client.getEffectiveProperties!(created[0]!);
    const yearRow = effective.find(
      (row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.publicationDate,
    );
    expect(yearRow).toBeDefined();
    expect(yearRow!.source).toBe("authored");
    expect(client.listPropertySchemas().some((s) => s.id === SYSTEM_PROPERTY_UUIDS.pmid)).toBe(true);
  });

  it("resolves a DOI and creates the source directly with all four field families", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    // Pre-author the citation schemas (the server-seeded state): the staged
    // entries then carry the real types (publicationDate → the date chain).
    await ensureCitationFamily(client);
    const fetchMock = stubFetch((url) => {
      if (url.includes("/api/resolve?doi=")) return jsonResponse(200, DOI_RECORD);
      return undefined;
    });
    const created: string[] = [];
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
        onCreated={(id) => created.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "10.1000/xyz" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));

    // The identifier route: GET /api/resolve?doi=…
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/resolve?doi="))).toBe(
        true,
      ),
    );
    await previewCardOf(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(created.length).toBe(1));

    // The direct create: class from classKey, monoblock authors, venue fields
    // by display name, year (the date chain), DOI, URL, publisher.
    const node = client.getNode(created[0]!);
    expect(node?.classIds).toContain(SYSTEM_CLASS_UUIDS.journal_article);
    const rows = client.getEffectiveProperties(created[0]!);
    const valueOf = (schemaId: string) =>
      rows.filter((row) => row.propertySchemaId === schemaId).map((row) => row.value);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.authors)).toEqual(["Lovelace, Ada", "Turing, Alan"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.editors)).toEqual(["Babbage, Charles"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.doi)).toEqual(["10.1000/xyz"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.url)).toEqual(["https://example.test/paper"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.publisher)).toEqual(["Acme Press"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.publicationTitle)).toEqual(["The Example Journal"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.volume)).toEqual(["7"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.issue)).toEqual(["3"]);
    // The year staged value resolves through the date chain to a node ref.
    const date = rows.find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.publicationDate);
    expect(date?.value).toHaveProperty("nodeId");
  });

  it("resolves an ISBN, pauses Create on the duplicate warning, and Create anyway writes the book", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    // An existing source with the same ISBN: Create pauses for one click.
    await ensureCitationFamily(client);
    const existing = await client.createObject({
      isEmbedded: false,
      name: "The same book",
      classIds: [SYSTEM_CLASS_UUIDS.book],
    });
    await client.setProperty(existing, SYSTEM_PROPERTY_UUIDS.isbn, "9780123456789", 0);
    stubFetch((url) => {
      if (url.includes("/api/resolve?isbn=")) return jsonResponse(200, BOOK_RECORD);
      return undefined;
    });
    const created: string[] = [];
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
        onCreated={(id) => created.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "978-0-123456-78-9" },
    });
    await fetchAndCreate(dialog);

    // The inline duplicate pause: the create did NOT run yet.
    const duplicate = dialog.querySelector(".add-source-dialog__duplicate") as HTMLElement;
    expect(duplicate).not.toBeNull();
    expect(duplicate.getAttribute("role")).toBe("alert");
    expect(within(duplicate).getByText(/already in your library/i)).not.toBeNull();
    expect(created.length).toBe(0);

    // Create anyway proceeds — the book lands with its ISBN + venue fields.
    fireEvent.click(within(duplicate).getByRole("button", { name: /create anyway/i }));
    await waitFor(() => expect(created.length).toBe(1));
    const node = client.getNode(created[0]!);
    expect(node?.classIds).toContain(SYSTEM_CLASS_UUIDS.book);
    const rows = client.getEffectiveProperties(created[0]!);
    const valueOf = (schemaId: string) =>
      rows.filter((row) => row.propertySchemaId === schemaId).map((row) => row.value);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.isbn)).toEqual(["9780123456789"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.numPages)).toEqual(["123"]);
  });

  it("resolves a plain URL through the ?url= PDF flow and links the direct PDF URL", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await ensureCitationFamily(client);
    const fetchMock = stubFetch((url, init) => {
      if (url.includes("/api/resolve/pdf?url=")) {
        expect(init?.method).toBe("POST");
        return jsonResponse(200, { ...DOI_RECORD, pdf: { url: "https://example.test/paper.pdf" } });
      }
      return undefined;
    });
    const created: string[] = [];
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
        onCreated={(id) => created.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "https://example.test/paper.pdf" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/resolve/pdf?url=")),
      ).toBe(true),
    );
    await previewCardOf(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(created.length).toBe(1));
    // The pdf:{url} intent is the honest full-text link — it lands on the
    // created source's URL property (never a CAS upload).
    const rows = client.getEffectiveProperties(created[0]!);
    const url = rows.find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.url);
    expect(url?.value).toBe("https://example.test/paper.pdf");
  });

  it("uploads a picked PDF to the resolver, then attaches it to the created source via CAS", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await ensureCitationFamily(client);
    const fetchMock = stubFetch((url) => {
      if (url.includes("/api/resolve/pdf") && !url.includes("?url=")) {
        return jsonResponse(200, DOI_RECORD);
      }
      if (url.includes("/api/assets")) {
        return jsonResponse(200, {
          assetId: "11111111-1111-7111-8000-111111111111",
          originalName: "paper.pdf",
          hash: "ab".repeat(32),
          mimeType: "application/pdf",
          size: 4,
        });
      }
      return undefined;
    });
    const created: string[] = [];
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
        onCreated={(id) => created.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    const file = new File(["%PDF-fake"], "paper.pdf", { type: "application/pdf" });
    pickPdf(dialog, file);
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await previewCardOf(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(created.length).toBe(1));

    // The multipart resolve ran with the file's FormData.
    const resolveCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/resolve/pdf"),
    );
    expect(resolveCall).not.toBeUndefined();
    expect(resolveCall![1]?.body).toBeInstanceOf(FormData);

    // The CAS upload (POST /api/assets) rode the create, then the attachment
    // linked on the source (the asset.attach projection).
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/assets"))).toBe(
        true,
      ),
    );
    const info = client.getAssetInfo(created[0]!);
    expect(info?.assetId).toBe("11111111-1111-7111-8000-111111111111");
    expect(info?.originalName).toBe("paper.pdf");
  });

  it("a failed CAS upload creates no half-source (the upload runs before the create)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await ensureCitationFamily(client);
    stubFetch((url) => {
      if (url.includes("/api/resolve/pdf") && !url.includes("?url=")) {
        return jsonResponse(200, DOI_RECORD);
      }
      if (url.includes("/api/assets")) {
        return jsonResponse(500, {
          error: { code: "internal", message: "asset store unreachable", status: 500 },
        });
      }
      return undefined;
    });
    const created: string[] = [];
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
        onCreated={(id) => created.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    const file = new File(["%PDF-fake"], "paper.pdf", { type: "application/pdf" });
    pickPdf(dialog, file);
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await previewCardOf(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));

    // The create reports the failure inline (the dialog stays open)…
    await screen.findByText(/failed to create/i);
    // …and NO half-source exists: the upload precedes the create.
    expect(created.length).toBe(0);
    expect(client.getClassMembers(SYSTEM_CLASS_UUIDS.source).length).toBe(0);
  });

  it("422 no_identifier_found surfaces the honest inline error; nothing creates", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    stubFetch((url) => {
      if (url.includes("/api/resolve/pdf?url=")) {
        return jsonResponse(422, {
          error: { code: "no_identifier_found", message: "the PDF carried no extractable DOI", status: 422 },
        });
      }
      return undefined;
    });
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "https://example.test/no-doi.pdf" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await screen.findByText(/carried no extractable doi/i);
    // No half-create: the workspace gained nothing (Create never enabled).
    expect(createButtonOf(dialog).disabled).toBe(true);
    expect(client.getClassMembers(SYSTEM_CLASS_UUIDS.source).length).toBe(0);
  });

  it("403 resolver_disabled points at the Sources settings", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    stubFetch((url) => {
      if (url.includes("/api/resolve?doi=")) {
        return jsonResponse(403, {
          error: {
            code: "resolver_disabled",
            message: "the metadata resolver is disabled (sources settings)",
            status: 403,
          },
        });
      }
      return undefined;
    });
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "10.1000/xyz" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await screen.findByText(/features → sources/i);
  });

  it("404 and network failures surface their honest messages", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    stubFetch((url) => {
      if (url.includes("/api/resolve?doi=10.4040")) {
        return jsonResponse(404, {
          error: { code: "not_found", message: "no metadata found for doi", status: 404 },
        });
      }
      if (url.includes("/api/resolve?doi=10.5000")) {
        return jsonResponse(502, {
          error: { code: "resolver_unavailable", message: "Crossref answered 500", status: 502 },
        });
      }
      return undefined;
    });
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    const field = within(dialog).getByLabelText("Identifier or link");
    fireEvent.change(field, { target: { value: "10.4040/xyz" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await screen.findByText(/no metadata found/i);
    fireEvent.change(field, { target: { value: "10.5000/xyz" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await screen.findByText(/crossref answered 500/i);
  });

  it("unrecognized input fails loud with guidance, no request fires", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    const fetchMock = stubFetch(() => undefined);
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "just some words" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await screen.findByText(/not a doi, isbn, pmid, ads bibcode, arxiv id, or url/i);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("the client-side resolver-off setting shows the note; Add still works and offers the manual form", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await client.setFeatureSettings("sources", { resolverEnabled: false });
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    expect(within(dialog).getByText(/resolver is turned off/i)).not.toBeNull();
    // Fetch is NOT resolver-gated (only empty-gated): with something to act
    // on, Fetch fails honestly and offers the manual form (Create stays off).
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "https://example.test/some-page" },
    });
    const fetchButton = within(dialog).getByRole("button", { name: /^fetch$/i }) as HTMLButtonElement;
    expect(fetchButton.disabled).toBe(false);
    fireEvent.click(fetchButton);
    expect(await within(dialog).findByRole("alert")).not.toBeNull();
    // The manual path: same dialog's citation form, the weblink convention.
    fireEvent.click(within(dialog).getByRole("button", { name: /add manually/i }));
    const form = await screen.findByRole("dialog", { name: /new web_page/i });
    expect((within(form).getByLabelText("URL") as HTMLInputElement).value).toBe(
      "https://example.test/some-page",
    );
  });

  it("a failed resolve offers Add manually with the DOI carried into the citation form", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    stubFetch((url) => {
      if (url.includes("/api/resolve?doi=")) return jsonResponse(404, { error: { code: "not_found", message: "nothing for that DOI", status: 404 } });
      return undefined;
    });
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "10.1000/xyz" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    expect(await within(dialog).findByRole("alert")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /add manually/i }));
    const form = await screen.findByRole("dialog", { name: /new book/i });
    expect((within(form).getByLabelText("DOI") as HTMLInputElement).value).toBe("10.1000/xyz");
  });

  it("Create stays disabled until a fetch succeeds, editing the input invalidates it, and Fetch demotes from primary to outline", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    stubFetch((url) => {
      if (url.includes("/api/resolve?doi=")) return jsonResponse(200, DOI_RECORD);
      return undefined;
    });
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    const field = within(dialog).getByLabelText("Identifier or link");
    const fetchRow = dialog.querySelector(".add-source-dialog__fetch-row") as HTMLElement;
    const fetchOf = () => within(fetchRow).getByRole("button", { name: /^fetch$/i }) as HTMLButtonElement;

    // No fetch in hand — Fetch is the PRIMARY action; Create is disabled.
    fireEvent.change(field, { target: { value: "10.1000/xyz" } });
    expect(fetchOf().classList.contains("bg-primary")).toBe(true);
    expect(createButtonOf(dialog).disabled).toBe(true);
    fireEvent.click(fetchOf());
    await previewCardOf(dialog);

    // Fetched — Fetch demotes to outline; Create takes the lead.
    expect(fetchOf().classList.contains("bg-surface-container-low")).toBe(true);
    expect(createButtonOf(dialog).disabled).toBe(false);

    // Any edit invalidates the fetched preview — Create greys out again.
    fireEvent.change(field, { target: { value: "10.1000/xyz edited" } });
    expect(dialog.querySelector(".add-source-dialog__preview--card")).toBeNull();
    expect(createButtonOf(dialog).disabled).toBe(true);

    // A fresh fetch re-enables it.
    fireEvent.change(field, { target: { value: "10.1000/xyz" } });
    fireEvent.click(fetchOf());
    await previewCardOf(dialog);
    expect(createButtonOf(dialog).disabled).toBe(false);
  });

  it("the Unpaywall open-access PDF link shows as a removable row; clearing it keeps the url off the created source", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await ensureCitationFamily(client);
    stubFetch((url) => {
      if (url.includes("/api/resolve?doi=")) {
        return jsonResponse(200, { ...DOI_RECORD, pdf: { url: "https://oa.test/paper.pdf" } });
      }
      return undefined;
    });
    const created: string[] = [];
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
        onCreated={(id) => created.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "10.1000/xyz" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await previewCardOf(dialog);

    // The OA link row: link icon, the "Open-access PDF" chip, a clear button.
    expect(within(dialog).getByText("Open-access PDF")).not.toBeNull();
    expect(within(dialog).getByText("https://oa.test/paper.pdf")).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /remove the fetched pdf link/i }));
    expect(within(dialog).queryByText("Open-access PDF")).toBeNull();

    // A dismissed chip keeps the OA link OFF the created source: the URL
    // property seeds from the provider's own url, never the OA pdf link.
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(created.length).toBe(1));
    const rows = client.getEffectiveProperties(created[0]!);
    expect(rows.find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.url)?.value).toBe(
      "https://example.test/paper",
    );
  });

  it("an uncleared OA link lands on the created source's URL property as the open-access PDF url", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await ensureCitationFamily(client);
    stubFetch((url) => {
      if (url.includes("/api/resolve?doi=")) {
        return jsonResponse(200, { ...DOI_RECORD, pdf: { url: "https://oa.test/paper.pdf" } });
      }
      return undefined;
    });
    const created: string[] = [];
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
        onCreated={(id) => created.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "10.1000/xyz" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await previewCardOf(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(created.length).toBe(1));
    const rows = client.getEffectiveProperties(created[0]!);
    expect(rows.find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.url)?.value).toBe(
      "https://oa.test/paper.pdf",
    );
  });

  it("a picked file supersedes the fetched OA link (the link row hides, the file rides the create)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await ensureCitationFamily(client);
    const fetchMock = stubFetch((url) => {
      if (url.includes("/api/resolve/pdf") && !url.includes("?url=")) {
        return jsonResponse(200, { ...DOI_RECORD, pdf: { url: "https://oa.test/paper.pdf" } });
      }
      if (url.includes("/api/assets")) {
        return jsonResponse(200, {
          assetId: "11111111-1111-7111-8000-111111111111",
          originalName: "paper.pdf",
          hash: "ab".repeat(32),
          mimeType: "application/pdf",
          size: 4,
        });
      }
      return undefined;
    });
    const created: string[] = [];
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
        onCreated={(id) => created.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    const file = new File(["%PDF-fake"], "paper.pdf", { type: "application/pdf" });
    pickPdf(dialog, file);
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await previewCardOf(dialog);

    // The picked file wins: no OA link row, the file row shows instead (the
    // filename renders twice — the drop zone's selected row + the dialog's
    // file preview — hence the *All* variant).
    expect(within(dialog).queryByText("Open-access PDF")).toBeNull();
    expect(within(dialog).getAllByText("paper.pdf").length).toBeGreaterThan(0);

    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(created.length).toBe(1));
    // The real bytes attach via CAS — the OA url was never the intent.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/assets"))).toBe(
        true,
      ),
    );
    expect(client.getAssetInfo(created[0]!)?.originalName).toBe("paper.pdf");
  });

  it("resolves a PMID and pauses Create on the inline 'Already in your library' alert; Create anyway writes the article", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await ensureCitationFamily(client);
    const existing = await client.createObject({
      isEmbedded: false,
      name: "The same article",
      classIds: [SYSTEM_CLASS_UUIDS.journal_article],
    });
    await client.setProperty(existing, SYSTEM_PROPERTY_UUIDS.pmid, "25495683", 0);
    stubFetch((url) => {
      if (url.includes("/api/resolve?pmid=")) return jsonResponse(200, PMID_RECORD);
      return undefined;
    });
    const created: string[] = [];
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {}}
        onCreated={(id) => created.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "PMID: 25495683" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    const card = await previewCardOf(dialog);
    expect(within(card).getByText(/pmid 25495683/i)).not.toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));

    // The inline pause: the alert names the match, nothing created yet.
    const duplicate = dialog.querySelector(".add-source-dialog__duplicate") as HTMLElement;
    expect(duplicate.getAttribute("role")).toBe("alert");
    expect(within(duplicate).getByText(/already in your library/i)).not.toBeNull();
    expect(created.length).toBe(0);

    // Create anyway proceeds — the article lands with its PMID.
    fireEvent.click(within(duplicate).getByRole("button", { name: /create anyway/i }));
    await waitFor(() => expect(created.length).toBe(1));
    const rows = client.getEffectiveProperties(created[0]!);
    expect(
      rows.find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.pmid)?.value,
    ).toBe("25495683");
  });

  it("the duplicate pause's Cancel dismisses without creating, and the open-existing link calls onOpenNode", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await ensureCitationFamily(client);
    const existing = await client.createObject({
      isEmbedded: false,
      name: "The same paper",
      classIds: [SYSTEM_CLASS_UUIDS.journal_article],
    });
    await client.setProperty(existing, SYSTEM_PROPERTY_UUIDS.doi, "10.1000/xyz", 0);
    stubFetch((url) => {
      if (url.includes("/api/resolve?doi=")) return jsonResponse(200, DOI_RECORD);
      return undefined;
    });
    const created: string[] = [];
    const opened: string[] = [];
    let closed = 0;
    render(
      <AddSourceDialog
        isOpen
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onClose={() => {
          closed += 1;
        }}
        onCreated={(id) => created.push(id)}
        onOpenNode={(id) => opened.push(id)}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    fireEvent.change(within(dialog).getByLabelText("Identifier or link"), {
      target: { value: "10.1000/xyz" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^fetch$/i }));
    await previewCardOf(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));

    // The pause names the existing source as an OPEN link (onOpenNode given)…
    const duplicate = dialog.querySelector(".add-source-dialog__duplicate") as HTMLElement;
    const openLink = within(duplicate).getByRole("button", { name: /the same paper/i });
    // …and Cancel dismisses the pause — no create, dialog stays open.
    fireEvent.click(within(duplicate).getByRole("button", { name: /^cancel$/i }));
    expect(dialog.querySelector(".add-source-dialog__duplicate")).toBeNull();
    expect(created.length).toBe(0);
    expect(closed).toBe(0);

    // A fresh Create re-pauses; the open link closes the dialog and routes
    // the existing node to onOpenNode.
    fireEvent.click(within(dialog).getByRole("button", { name: /^create$/i }));
    const repaused = dialog.querySelector(".add-source-dialog__duplicate") as HTMLElement;
    expect(repaused).not.toBeNull();
    fireEvent.click(within(repaused).getByRole("button", { name: /the same paper/i }));
    expect(closed).toBe(1);
    expect(opened).toEqual([existing]);
    expect(created.length).toBe(0);
  });
});

describe("AddSourceHost routing", () => {
  it("a bare URL with the resolver OFF creates a plain web_page weblink (no dialog)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await client.setFeatureSettings("sources", { resolverEnabled: false });
    const created: string[] = [];
    render(
      <AddSourceHost
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onCreated={(id) => created.push(id)}
        onOpenNode={() => {}}
      />,
    );
    requestAddSource({ initialInput: "https://example.test/some-page" });
    await waitFor(() => expect(created.length).toBe(1));
    const node = client.getNode(created[0]!);
    expect(node?.classIds).toContain(SYSTEM_CLASS_UUIDS.web_page);
    expect(deriveDisplayName(node!)).toBe("https://example.test/some-page");
    // No dialog ever opened.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an identifier with the resolver OFF opens the dialog with the settings note", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    await client.setFeatureSettings("sources", { resolverEnabled: false });
    render(
      <AddSourceHost
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onCreated={() => {}}
        onOpenNode={() => {}}
      />,
    );
    requestAddSource({ initialInput: "10.1000/xyz" });
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    expect(within(dialog).getByText(/resolver is turned off/i)).not.toBeNull();
    expect((within(dialog).getByLabelText("Identifier or link") as HTMLInputElement).value).toBe(
      "10.1000/xyz",
    );
  });

  it("a URL with the resolver ON opens the dialog (the ?url= PDF flow decides)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    render(
      <AddSourceHost
        client={client}
        serverUrl="http://resolver.test"
        credential="test-key"
        onCreated={() => {}}
        onOpenNode={() => {}}
      />,
    );
    requestAddSource({ initialInput: "https://example.test/paper.pdf" });
    const dialog = await screen.findByRole("dialog", { name: /add source/i });
    expect((within(dialog).getByLabelText("Identifier or link") as HTMLInputElement).value).toBe(
      "https://example.test/paper.pdf",
    );
  });
});

describe("resolver client plumbing", () => {
  it("ResolverRequestError carries the taxonomy code", async () => {
    stubFetch(() =>
      jsonResponse(422, {
        error: { code: "no_identifier_found", message: "the PDF carried no extractable DOI", status: 422 },
      }),
    );
    const error = await resolvePdfFile("http://resolver.test", "k", new File(["x"], "x.pdf"), "x.pdf").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ResolverRequestError);
    expect((error as ResolverRequestError).code).toBe("no_identifier_found");
    expect((error as ResolverRequestError).message).toContain("no extractable DOI");
  });

  it("routes pmid inputs to GET /api/resolve?pmid= and ads inputs to GET /api/resolve?ads=", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes("/api/resolve?")) {
        return jsonResponse(200, {
          classKey: "journal_article",
          title: "Routed",
          authors: [],
          editors: [],
          fields: {},
        });
      }
      return undefined;
    });
    await resolveSourceInput("http://resolver.test", "k", "PMID: 25495683");
    await expect(fetchMock.mock.calls.some((call) =>
      String(call[0]).includes("/api/resolve?pmid=25495683"),
    )).toBe(true);
    await resolveSourceInput("http://resolver.test", "k", "2015JCliP..42S.158D");
    await expect(fetchMock.mock.calls.some((call) =>
      String(call[0]).includes(
        `/api/resolve?ads=${encodeURIComponent("2015JCliP..42S.158D")}`,
      ),
    )).toBe(true);
  });
});
