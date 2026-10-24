/**
 * Add-source tests: the resolver client's input classification + request
 * plumbing (mocked fetch), the AddSourceDialog flow (resolve → prefilled
 * QuickCreateModal → one create), the error paths (422 no_identifier_found,
 * 403 resolver_disabled, 404, network), the PDF multipart path (mocked
 * server + the CAS upload attach), and the app-level host routing (a bare
 * URL with the resolver off creates a plain web_page weblink; an identifier
 * opens the dialog with the settings note).
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
} from "../src/features/sources/resolver.js";
import { AddSourceDialog } from "../src/features/sources/AddSourceDialog.js";
import { AddSourceHost, requestAddSource } from "../src/features/sources/AddSourceHost.js";
import { createSourceObject } from "../src/features/modals/quickCreate.js";

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
  it("resolves a DOI and prefills the create form (all four field families)", async () => {
    const client = await seedClient();
    await seedFamilies(client);
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
    fireEvent.click(within(dialog).getByRole("button", { name: /^resolve$/i }));

    // The identifier route: GET /api/resolve?doi=…
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/resolve?doi="))).toBe(
        true,
      ),
    );

    // The prefilled modal: class from classKey, monoblock authors, venue
    // fields by display name, year, DOI, URL, publisher.
    const form = await screen.findByRole("dialog", { name: /new journal_article/i });
    expect((within(form).getByLabelText("Title") as HTMLInputElement).value).toBe(
      "On the Analytical Engine",
    );
    expect((within(form).getByLabelText("Authors") as HTMLInputElement).value).toBe(
      "Lovelace, Ada; Turing, Alan",
    );
    expect((within(form).getByLabelText("Editors") as HTMLInputElement).value).toBe("Babbage, Charles");
    expect((within(form).getByLabelText("Year") as HTMLInputElement).value).toBe("1843");
    expect((within(form).getByLabelText("DOI") as HTMLInputElement).value).toBe("10.1000/xyz");
    expect((within(form).getByLabelText("URL") as HTMLInputElement).value).toBe(
      "https://example.test/paper",
    );
    expect((within(form).getByLabelText("Publisher") as HTMLInputElement).value).toBe("Acme Press");
    expect((within(form).getByLabelText("Publication title") as HTMLInputElement).value).toBe(
      "The Example Journal",
    );
    expect((within(form).getByLabelText("Volume") as HTMLInputElement).value).toBe("7");
    expect((within(form).getByLabelText("Issue") as HTMLInputElement).value).toBe("3");

    fireEvent.click(within(form).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(created.length).toBe(1));
    const rows = client.getEffectiveProperties(created[0]!);
    const valueOf = (schemaId: string) =>
      rows.filter((row) => row.propertySchemaId === schemaId).map((row) => row.value);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.authors)).toEqual(["Lovelace, Ada", "Turing, Alan"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.editors)).toEqual(["Babbage, Charles"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.doi)).toEqual(["10.1000/xyz"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.publisher)).toEqual(["Acme Press"]);
    expect(valueOf(SYSTEM_PROPERTY_UUIDS.publicationTitle)).toEqual(["The Example Journal"]);
  });

  it("resolves an ISBN to the book flow and shows the duplicate warning for an existing ISBN", async () => {
    const client = await seedClient();
    await seedFamilies(client);
    // An existing source with the same ISBN: the duplicate warning appears.
    await createSourceObject(client, {
      title: "The same book",
      classId: SYSTEM_CLASS_UUIDS.book,
      isbn: "9780123456789",
    });
    stubFetch((url) => {
      if (url.includes("/api/resolve?isbn=")) return jsonResponse(200, BOOK_RECORD);
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
      target: { value: "978-0-123456-78-9" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^resolve$/i }));
    const form = await screen.findByRole("dialog", { name: /new book/i });
    expect(within(form).getByText(/already in your library/i)).not.toBeNull();
    expect((within(form).getByLabelText("ISBN") as HTMLInputElement).value).toBe("9780123456789");
    expect((within(form).getByLabelText("Number of pages") as HTMLInputElement).value).toBe("123");
  });

  it("resolves a plain URL through the ?url= PDF flow and links the direct PDF URL", async () => {
    const client = await seedClient();
    await seedFamilies(client);
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
    fireEvent.click(within(dialog).getByRole("button", { name: /^resolve$/i }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/resolve/pdf?url=")),
      ).toBe(true),
    );
    const form = await screen.findByRole("dialog", { name: /new journal_article/i });
    // The pdf:{url} intent is the honest full-text link.
    expect((within(form).getByLabelText("URL") as HTMLInputElement).value).toBe(
      "https://example.test/paper.pdf",
    );
    fireEvent.click(within(form).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(created.length).toBe(1));
    const rows = client.getEffectiveProperties(created[0]!);
    const url = rows.find((row) => row.propertySchemaId === SYSTEM_PROPERTY_UUIDS.url);
    expect(url?.value).toBe("https://example.test/paper.pdf");
  });

  it("uploads a picked PDF to the resolver, then attaches it to the created source via CAS", async () => {
    const client = await seedClient();
    await seedFamilies(client);
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
    fireEvent.change(within(dialog).getByLabelText("PDF file"), {
      target: { files: [file] },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^resolve$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /add source/i })).toBeNull());

    // The multipart resolve ran with the file's FormData.
    const resolveCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/resolve/pdf"),
    );
    expect(resolveCall).not.toBeUndefined();
    expect(resolveCall![1]?.body).toBeInstanceOf(FormData);

    const form = await screen.findByRole("dialog", { name: /new journal_article/i });
    fireEvent.click(within(form).getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(created.length).toBe(1));
    // The CAS upload (POST /api/assets) rides the create, then the
    // attachment links on the source (the asset.attach projection).
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
    fireEvent.change(within(dialog).getByLabelText("PDF file"), {
      target: { files: [file] },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^resolve$/i }));
    const form = await screen.findByRole("dialog", { name: /new journal_article/i });
    fireEvent.click(within(form).getByRole("button", { name: /^create$/i }));

    // The create reports the failure inline…
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
    fireEvent.click(within(dialog).getByRole("button", { name: /^resolve$/i }));
    await screen.findByText(/carried no extractable doi/i);
    // No half-create: the workspace gained nothing.
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
    fireEvent.click(within(dialog).getByRole("button", { name: /^resolve$/i }));
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
    fireEvent.click(within(dialog).getByRole("button", { name: /^resolve$/i }));
    await screen.findByText(/no metadata found/i);
    fireEvent.change(field, { target: { value: "10.5000/xyz" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^resolve$/i }));
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
    fireEvent.click(within(dialog).getByRole("button", { name: /^resolve$/i }));
    await screen.findByText(/not a doi, isbn, arxiv id, or url/i);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("the client-side resolver-off setting shows the note and disables the resolve", async () => {
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
    expect(
      (within(dialog).getByRole("button", { name: /^resolve$/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
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
});
