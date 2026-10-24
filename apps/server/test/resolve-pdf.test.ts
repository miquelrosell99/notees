/**
 * The owner's PDF flow (POST /api/resolve/pdf) — source-library slices 3–6
 * task 4. fetch is stubbed globally per test (the repo's web-test idiom); no
 * real network here. The tests pin: the multipart intake + raw-bytes DOI
 * scan over a hand-built minimal PDF, the `?url=` mode (mocked fetch, the
 * pdf:{url} attach intent), the SSRF refusals, the 25MB cap on BOTH paths,
 * the no-DOI 422 no_identifier_found taxonomy code, first-hit-wins +
 * trailing-punctuation/percent-entity normalization, the publisher record
 * amendment (Crossref mock), and the pref gate running BEFORE any egress.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestServer,
  ingest,
  makeTestServer,
  testEnvelope,
  type TestServer,
} from "./helpers";

import { extractDoiFromPdfBytes, RESOLVE_PDF_MAX_BYTES } from "../src/resolve-source.js";

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

const CROSSREF_WORK = {
  DOI: "10.1000/xyz123",
  type: "journal-article",
  title: ["The Test Article"],
  author: [{ family: "Curie", given: "Marie" }],
  "container-title": ["Journal of Testing"],
  volume: "7",
  issue: "2",
  page: "123-145",
  ISSN: ["1234-5678"],
  publisher: "Test Press",
  URL: "https://doi.org/10.1000/xyz123",
  issued: { "date-parts": [[2023, 4, 1]] },
};

/**
 * A hand-built minimal PDF — no xref, no compression, only what the raw-bytes
 * scan needs: the `%PDF` wrapper and an UNCOMPRESSED text object carrying the
 * DOI (latin1 decode must find it verbatim).
 */
function makePdfWithText(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`);
    parts.push(chunk);
    offset += chunk.length;
  });
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n"));
  return Buffer.concat(parts);
}

function multipartBody(bytes: Buffer, filename = "paper.pdf"): { payload: Buffer; contentType: string } {
  const boundary = "----noteestestboundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

function uploadPdf(bytes: Buffer, filename?: string) {
  const { payload, contentType } = multipartBody(bytes, filename);
  return server!.app.inject({
    method: "POST",
    url: "/api/resolve/pdf",
    headers: { "content-type": contentType, ...server!.authHeaders },
    payload,
  });
}

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

describe("extractDoiFromPdfBytes — the raw-bytes scan", () => {
  it("finds a DOI in a hand-built PDF (latin1 decode, uncompressed text object)", () => {
    const pdf = makePdfWithText("doi:10.1000/xyz123");
    expect(extractDoiFromPdfBytes(pdf)).toBe("10.1000/xyz123");
  });

  it("strips trailing punctuation the regex char-class swallows", () => {
    const pdf = makePdfWithText("see 10.1000/xyz123).");
    expect(extractDoiFromPdfBytes(pdf)).toBe("10.1000/xyz123");
  });

  it("decodes percent-entities best-effort", () => {
    const pdf = makePdfWithText("href 10.1000%2Fxyz123");
    expect(extractDoiFromPdfBytes(pdf)).toBe("10.1000/xyz123");
  });

  it("first hit wins when the PDF carries several DOIs", () => {
    const pdf = makePdfWithText("10.1111/aaa and later 10.2222/bbb");
    expect(extractDoiFromPdfBytes(pdf)).toBe("10.1111/aaa");
  });

  it("returns null when no DOI is present", () => {
    const pdf = makePdfWithText("no identifiers here at all");
    expect(extractDoiFromPdfBytes(pdf)).toBeNull();
  });
});

describe("POST /api/resolve/pdf", () => {
  it("multipart upload: scans the bytes, resolves the DOI, answers the record (no pdf block)", async () => {
    server = await makeTestServer();
    const fetchMock = stubFetch({
      "https://api.crossref.org/works/": () => jsonResponse({ message: CROSSREF_WORK }),
    });

    const res = await uploadPdf(makePdfWithText("doi:10.1000/xyz123"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      classKey: "journal_article",
      title: "The Test Article",
      authors: ["Curie, Marie"],
      editors: [],
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
      publisher: "Test Press",
    });
    // The publisher amendment: Crossref `publisher` populates the top-level
    // record field (never a `fields` entry — it rides the source base).
    expect(res.json().publisher).toBe("Test Press");
    // Upload mode: no source URL, so no attach intent block.
    expect(res.json().pdf).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.crossref.org/works/10.1000%2Fxyz123");
  });

  it("?url= mode: the server fetches the PDF (mocked) and answers pdf:{url} for the task-6 attach", async () => {
    server = await makeTestServer();
    const pdfBytes = makePdfWithText("doi:10.1000/xyz123");
    const fetchMock = stubFetch({
      "https://example.org/paper.pdf": () =>
        new Response(pdfBytes, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-length": String(pdfBytes.length),
          },
        }),
      "https://api.crossref.org/works/": () => jsonResponse({ message: CROSSREF_WORK }),
    });

    const res = await api("POST", "/api/resolve/pdf?url=https%3A%2F%2Fexample.org%2Fpaper.pdf");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      doi: "10.1000/xyz123",
      title: "The Test Article",
      publisher: "Test Press",
      pdf: { url: "https://example.org/paper.pdf" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://example.org/paper.pdf");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.crossref.org/works/10.1000%2Fxyz123");
  });

  it("no DOI in the bytes → 422 no_identifier_found (and Crossref is never called)", async () => {
    server = await makeTestServer();
    const crossrefMock = vi.fn(async () => jsonResponse({ message: CROSSREF_WORK }));
    stubFetch({
      "https://example.org/clean.pdf": () =>
        new Response(makePdfWithText("nothing here"), { status: 200 }),
      "https://api.crossref.org/works/": crossrefMock,
    });

    const uploadRes = await uploadPdf(makePdfWithText("a paper about nothing identifiable"));
    expect(uploadRes.statusCode).toBe(422);
    expect(uploadRes.json().error.code).toBe("no_identifier_found");

    const urlRes = await api(
      "POST",
      "/api/resolve/pdf?url=https%3A%2F%2Fexample.org%2Fclean.pdf",
    );
    expect(urlRes.statusCode).toBe(422);
    expect(urlRes.json().error.code).toBe("no_identifier_found");
    expect(crossrefMock).not.toHaveBeenCalled();
  });

  it("SSRF refusals: file://, 127.0.0.1, 169.254.x answer 422 and never fetch", async () => {
    server = await makeTestServer();
    const fetchMock = vi.fn(async () => new Response("must not be called", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const url of [
      "file:///etc/passwd",
      "http://127.0.0.1:8080/paper.pdf",
      "http://169.254.169.254/latest/meta-data",
    ]) {
      const res = await api("POST", `/api/resolve/pdf?url=${encodeURIComponent(url)}`);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("validation_failed");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SSRF guard: IPv4-mapped IPv6 literals are unwrapped and refused (loopback/private tails)", async () => {
    server = await makeTestServer();
    const fetchMock = vi.fn(async () => new Response("must not be called", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const url of [
      "http://[::ffff:127.0.0.1]/paper.pdf",
      "http://[::ffff:7f00:1]/paper.pdf",
      "http://[::ffff:10.0.0.1]/paper.pdf",
    ]) {
      const res = await api("POST", `/api/resolve/pdf?url=${encodeURIComponent(url)}`);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("validation_failed");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SSRF guard: the whole fe80::/10 link-local range is refused, public IPv6 is allowed", async () => {
    server = await makeTestServer();
    const fetchMock = vi.fn(async () => new Response("must not be called", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const url of ["http://[fe80::1]/paper.pdf", "http://[fe90::1]/paper.pdf"]) {
      const res = await api("POST", `/api/resolve/pdf?url=${encodeURIComponent(url)}`);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("validation_failed");
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // A legit public IPv6 literal passes the guard and reaches the fetch stub.
    const pdfBytes = makePdfWithText("doi:10.1000/xyz123");
    stubFetch({
      "http://[2606:4700:4700::1111]/paper.pdf": () =>
        new Response(pdfBytes, { status: 200, headers: { "content-type": "application/pdf" } }),
      "https://api.crossref.org/works/": () => jsonResponse({ message: CROSSREF_WORK }),
    });
    const allowed = await api(
      "POST",
      `/api/resolve/pdf?url=${encodeURIComponent("http://[2606:4700:4700::1111]/paper.pdf")}`,
    );
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ doi: "10.1000/xyz123", title: "The Test Article" });
  });

  it("the 25MB cap applies to the multipart upload", async () => {
    server = await makeTestServer();
    const oversized = Buffer.alloc(RESOLVE_PDF_MAX_BYTES + 1, 0x20);
    // A DOI at the start so only the cap can reject it.
    makePdfWithText("doi:10.1000/xyz123").copy(oversized);

    const res = await uploadPdf(oversized);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("the 25MB cap applies to ?url= via the declared content-length (body never read)", async () => {
    server = await makeTestServer();
    const crossrefMock = vi.fn(async () => jsonResponse({ message: CROSSREF_WORK }));
    const fetchMock = stubFetch({
      "https://example.org/big.pdf": () => {
        // Poisoned body: had the server read past the declared length and
        // scanned these bytes, THIS doi would have driven a Crossref call.
        // The declared-length pre-check must refuse before any of that.
        const body = makePdfWithText("doi:10.9999/poison");
        return new Response(body, {
          status: 200,
          headers: { "content-length": String(RESOLVE_PDF_MAX_BYTES + 1) },
        });
      },
      "https://api.crossref.org/works/": crossrefMock,
    });

    const res = await api("POST", "/api/resolve/pdf?url=https%3A%2F%2Fexample.org%2Fbig.pdf");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
    // The PDF host was fetched exactly once; the poisoned body never
    // reached the scan (no Crossref call).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(crossrefMock).not.toHaveBeenCalled();
  });

  it("the sources settings hard-off answers 403 BEFORE any egress (url mode never fetches the PDF)", async () => {
    server = await makeTestServer();
    const fetchMock = vi.fn(async () => new Response("must not be called", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await ingest(server, [
      testEnvelope({
        workspaceId: server.ctx.defaultWorkspace,
        opType: "workspace.feature.set",
        payload: { feature: "sources", enabled: true, settings: { resolverEnabled: false } },
      }),
    ]);

    const res = await api("POST", "/api/resolve/pdf?url=https%3A%2F%2Fexample.org%2Fpaper.pdf");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("resolver_disabled");
    expect(fetchMock).not.toHaveBeenCalled();

    const uploadRes = await uploadPdf(makePdfWithText("doi:10.1000/xyz123"));
    expect(uploadRes.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("neither a file nor ?url= → 422 validation_failed", async () => {
    server = await makeTestServer();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/resolve/pdf",
      headers: { "content-type": "application/json", ...server.authHeaders },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("a PDF-host failure answers 502 resolver_unavailable", async () => {
    server = await makeTestServer();
    stubFetch({
      "https://example.org/down.pdf": () => new Response("boom", { status: 500 }),
    });

    const res = await api("POST", "/api/resolve/pdf?url=https%3A%2F%2Fexample.org%2Fdown.pdf");
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("resolver_unavailable");
  });
});
