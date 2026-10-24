/**
 * The metadata resolver route (GET /api/resolve?doi=|?isbn=|?arxiv=) —
 * source-library slices 3–6 task 3. fetch is stubbed globally per test (the
 * repo's web-test idiom); the providers never see a real network here. The
 * tests pin: the exact unified record shape, the error mapping (404 / 502 /
 * timeout), the sources-settings pref gate (403), the 24 h cache (one fetch
 * for two calls), the exactly-one-identifier guard (400), and that the
 * pre-existing ?name= mode still works alongside the metadata branch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestServer,
  ingest,
  makeTestServer,
  testEnvelope,
  type TestServer,
} from "./helpers";

let server: TestServer | null = null;

function api(method: string, url: string) {
  return server!.app.inject({ method: method as "GET", url, headers: server!.authHeaders });
}

/** A fetch stub routing by URL prefix to a handler returning a Response. */
function stubFetch(routes: Record<string, (url: string, init?: RequestInit) => Promise<Response> | Response>) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler(url, init);
    }
    return new Response(`unexpected url: ${url}`, { status: 500 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CROSSREF_JOURNAL_WORK = {
  DOI: "10.1000/xyz123",
  type: "journal-article",
  title: ["The Test Article"],
  author: [
    { family: "Curie", given: "Marie" },
    { family: "Lovelace", given: "Ada" },
  ],
  "container-title": ["Journal of Testing"],
  volume: "7",
  issue: "2",
  page: "123-145",
  ISSN: ["1234-5678"],
  publisher: "Test Press",
  URL: "https://doi.org/10.1000/xyz123",
  issued: { "date-parts": [[2023, 4, 1]] },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("fetch called without a per-test stub", { status: 500 })),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (server !== null) {
    await closeTestServer(server);
    server = null;
  }
});

describe("GET /api/resolve — metadata branch", () => {
  it("Crossref journal-article maps to the exact unified record", async () => {
    server = await makeTestServer();
    const fetchMock = stubFetch({
      "https://api.crossref.org/works/": () => jsonResponse({ message: CROSSREF_JOURNAL_WORK }),
    });

    const res = await api("GET", "/api/resolve?doi=10.1000/xyz123");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      classKey: "journal_article",
      title: "The Test Article",
      authors: ["Curie, Marie", "Lovelace, Ada"],
      editors: [],
      // Only the class's OWN bindings survive — publisher rides the source
      // base (not in SYSTEM_SOURCE_CLASS_BINDINGS) and must NOT appear.
      fields: {
        issn: "1234-5678",
        issue: "2",
        pages: "123-145",
        publicationTitle: "Journal of Testing",
        volume: "7",
      },
      doi: "10.1000/xyz123",
      url: "https://doi.org/10.1000/xyz123",
      year: 2023,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.crossref.org/works/10.1000%2Fxyz123");
  });

  it("a provider 404 answers 404 not_found", async () => {
    server = await makeTestServer();
    stubFetch({
      "https://api.crossref.org/works/": () =>
        new Response("not found", { status: 404 }),
    });

    const res = await api("GET", "/api/resolve?doi=10.9999/nothing");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("a provider 500 answers 502 resolver_unavailable", async () => {
    server = await makeTestServer();
    stubFetch({
      "https://api.crossref.org/works/": () => new Response("boom", { status: 500 }),
    });

    const res = await api("GET", "/api/resolve?doi=10.1000/xyz123");
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("resolver_unavailable");
  });

  it("a provider timeout answers 502 resolver_unavailable", async () => {
    server = await makeTestServer({ resolverTimeoutMs: 50 });
    // A hanging provider: the request never settles unless aborted.
    stubFetch({
      "https://api.crossref.org/works/": (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    });

    const res = await api("GET", "/api/resolve?doi=10.1000/xyz123");
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("resolver_unavailable");
  });

  it("the sources settings hard-off answers 403 resolver_disabled (and never fetches)", async () => {
    server = await makeTestServer();
    const fetchMock = vi.fn(async () => new Response("must not be called", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    // The toggle is log state: a workspace.feature.set on the default
    // workspace (the web settings UI owns the same write in task 5).
    await ingest(server, [
      testEnvelope({
        workspaceId: server.ctx.defaultWorkspace,
        opType: "workspace.feature.set",
        payload: { feature: "sources", enabled: true, settings: { resolverEnabled: false } },
      }),
    ]);

    const res = await api("GET", "/api/resolve?doi=10.1000/xyz123");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("resolver_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the absent settings row defaults ON", async () => {
    server = await makeTestServer();
    stubFetch({
      "https://api.crossref.org/works/": () => jsonResponse({ message: CROSSREF_JOURNAL_WORK }),
    });

    const res = await api("GET", "/api/resolve?doi=10.1000/xyz123");
    expect(res.statusCode).toBe(200);
    expect(res.json().classKey).toBe("journal_article");
  });

  it("the cache serves the second call without a second fetch (normalized key)", async () => {
    server = await makeTestServer();
    const fetchMock = stubFetch({
      "https://api.crossref.org/works/": () => jsonResponse({ message: CROSSREF_JOURNAL_WORK }),
    });

    const first = await api("GET", "/api/resolve?doi=10.1000/xyz123");
    // Case-folded + a doi.org paste: the SAME normalized identifier.
    const second = await api("GET", "/api/resolve?doi=https%3A%2F%2Fdoi.org%2F10.1000%2FXYZ123");
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("OpenLibrary ISBN resolves a book (one author fetch, binding-filtered fields)", async () => {
    server = await makeTestServer();
    const fetchMock = stubFetch({
      "https://openlibrary.org/isbn/": () =>
        jsonResponse({
          title: "A Wizard of Earthsea",
          publish_date: "April 3 2019",
          publishers: ["Penguin"],
          publish_places: [{ name: "London" }],
          number_of_pages: 304,
          isbn_13: ["9780143127741"],
          authors: [{ key: "/authors/OL7353617A" }, { key: "/authors/OL9999999A" }],
        }),
      "https://openlibrary.org/authors/OL7353617A.json": () =>
        jsonResponse({ name: "Ursula K. Le Guin" }),
    });

    // Hyphens in the pasted ISBN normalize away.
    const res = await api("GET", "/api/resolve?isbn=978-0-14-312774-1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      classKey: "book",
      title: "A Wizard of Earthsea",
      // One extra fetch only (the egress budget): the FIRST author resolves,
      // the second key is not fetched. The name inversion is the documented
      // last-space best-effort ("Le Guin" is unrecoverable from a full name).
      authors: ["Guin, Ursula K. Le"],
      editors: [],
      fields: {
        numPages: "304",
        place: "London",
      },
      isbn: "9780143127741",
      url: "https://openlibrary.org/isbn/9780143127741",
      year: 2019,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("arXiv resolves a preprint from the Atom feed (DOM-less parse)", async () => {
    server = await makeTestServer();
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <updated>2024-01-02T00:00:00Z</updated>
    <published>2024-01-02T00:00:00Z</published>
    <title>  Attention Is All\n     You Need, Again  </title>
    <summary>We show that &amp; transformers still work.</summary>
    <author><name>Marie Curie</name></author>
    <author><name>Ada Lovelace</name></author>
    <arxiv:doi>10.48550/arXiv.2401.00001</arxiv:doi>
  </entry>
</feed>`;
    stubFetch({
      "http://export.arxiv.org/api/query": () =>
        new Response(xml, { status: 200, headers: { "content-type": "application/atom+xml" } }),
    });

    const res = await api("GET", "/api/resolve?arxiv=2401.00001");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      classKey: "preprint",
      title: "Attention Is All You Need, Again",
      authors: ["Curie, Marie", "Lovelace, Ada"],
      editors: [],
      fields: {
        abstract: "We show that & transformers still work.",
        repository: "arXiv",
      },
      doi: "10.48550/arXiv.2401.00001",
      url: "http://arxiv.org/abs/2401.00001v1",
      year: 2024,
    });
  });

  it("requires exactly one identifier (two → 400, none → the name-mode 422)", async () => {
    server = await makeTestServer();
    const fetchMock = vi.fn(async () => new Response("must not be called", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const both = await api("GET", "/api/resolve?doi=10.1%2Fx&isbn=123");
    expect(both.statusCode).toBe(400);
    expect(both.json().error.code).toBe("validation_failed");

    const neither = await api("GET", "/api/resolve");
    expect(neither.statusCode).toBe(422);

    const neitherFiltered = await api("GET", "/api/resolve?doi=&isbn=");
    expect(neitherFiltered.statusCode).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the name→id mode still works alongside the metadata branch", async () => {
    server = await makeTestServer();
    const created = await server.app.inject({
      method: "POST",
      url: "/api/objects",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: { isEmbedded: false, name: "Dune", contentAst: [{ type: "text", text: "Dune" }] },
    });
    expect(created.statusCode).toBe(201);

    const resolved = await api("GET", "/api/resolve?name=Dune");
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ name: "Dune", id: created.json().id });
  });
});
