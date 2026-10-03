/**
 * PDF export engine tests (§34.24 P1, jsdom).
 *
 * Two harnesses, per task P1's "pick the reliable one":
 *
 *  - The document component tree renders with testing-library: react-pdf's
 *    components mount as lowercase custom elements (<document>/<page>/<view>/
 *    <text>), so structure is assertable in the DOM (title block, properties,
 *    asset image vs placeholder, academic's two flex Views, numbered
 *    headings). The Page size prop is not reflected into the DOM, so the
 *    pageFormat mapping is asserted on the element tree directly.
 *  - `pdf()` itself is mocked (toBlob → a stub application/pdf Blob): the
 *    real renderer needs font fetches jsdom cannot serve. The mock captures
 *    the document element, so the specs assert the render pipeline end to
 *    end — IR build, getAssetDataUrl resolution, merged layout/pageFormat
 *    options, blob MIME, filenames — without the browser-only machinery.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { unzipSync } from "fflate";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";

import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { resolveExportOptions, type ExportDocument } from "@notees/export";

import { WorkspaceClient } from "../src/core/workspace-client.js";
import { ExportPdfDocument, pdfPageSize } from "../src/ui/export-pdf/pdfDocument.js";
import { renderSubtreePdf, renderSubtreePdfBatch } from "../src/ui/export-pdf/renderPdf.js";
import { PDF_THEMES } from "../src/ui/export-pdf/theme.js";
import { getExportFormat as getWebExportFormat } from "../src/ui/components/modals/registerExportFormats.js";
import { getExportFormat as getPackageExportFormat } from "@notees/export";

const pdfMock = vi.hoisted(() => ({ calls: [] as unknown[] }));

// The real renderer is kept for the component tree (components, Font,
// StyleSheet all work in jsdom); only the byte-producing entry is stubbed.
vi.mock("@react-pdf/renderer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@react-pdf/renderer")>();
  return {
    ...actual,
    pdf: (element: unknown) => {
      pdfMock.calls.push(element);
      return {
        toBlob: async () => new Blob(["%PDF-1.4 stub"], { type: "application/pdf" }),
      };
    },
  };
});

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
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

beforeEach(() => {
  pdfMock.calls.length = 0;
});

/** A hand-built IR exercising every block/span kind. */
function fixtureDocument(): ExportDocument {
  return {
    nodeId: "node-trip",
    title: "Trip",
    rendersDocumentChrome: true,
    isClass: false,
    presentAsMain: true,
    parentId: null,
    blocks: [
      {
        kind: "paragraph",
        spans: [
          { kind: "text", text: "Pack ", marks: [] },
          { kind: "text", text: "light", marks: ["bold", "italic"] },
          { kind: "mention", targetNodeId: "node-gear", name: "Gear" },
          { kind: "classChip", classId: "class-tag", name: "travel" },
          { kind: "typedLink", verb: "authored by", text: "Miquel", locator: "p. 2" },
          { kind: "externalLink", text: "docs", href: "https://example.com" },
          { kind: "math", expression: "e=mc^2" },
          { kind: "hardBreak" },
          { kind: "text", text: "second line", marks: ["code"] },
        ],
      },
      { kind: "quote", spans: [{ kind: "text", text: "Take the scenic route", marks: [] }] },
      { kind: "asset", assetId: "asset-boarding" },
      { kind: "embed", nodeId: "node-packing", inlined: null },
      {
        kind: "embed",
        nodeId: "node-inline",
        inlined: {
          nodeId: "node-inline",
          title: "Inline",
          rendersDocumentChrome: false,
          isClass: false,
          presentAsMain: false,
          parentId: "node-trip",
          blocks: [
            { kind: "paragraph", spans: [{ kind: "text", text: "inlined body", marks: [] }] },
          ],
          properties: [],
          classIds: [],
          classNames: [],
          children: [],
          assetRefs: [],
        },
      },
      { kind: "query", queryAst: { op: "and", args: [] } },
      { kind: "whiteboard", layout: { nodes: [] } },
    ],
    properties: [
      { schemaId: "schema-status", schemaName: "Status", value: "planned", display: "planned" },
      { schemaId: "schema-empty", schemaName: "Empty", value: "", display: "" },
    ],
    classIds: ["class-tag"],
    classNames: ["Tag"],
    children: [
      {
        id: "node-packing",
        title: "Packing",
        classIds: [],
        properties: [],
        blocks: [
          { kind: "paragraph", spans: [{ kind: "text", text: "Sunscreen", marks: [] }] },
        ],
        children: [
          {
            id: "node-sub",
            title: "Toiletries",
            classIds: [],
            properties: [],
            blocks: [],
            children: [],
          },
        ],
      },
    ],
    assetRefs: ["asset-boarding"],
  };
}

/** Read the Page element out of the document tree. */
function pageElement(element: ReactElement): ReactElement {
  const page = (element.props as { children: ReactElement }).children;
  expect(page.type).toBeDefined();
  return page;
}

describe("ExportPdfDocument component tree", () => {
  it("maps pageFormat to the react-pdf page size", () => {
    const document = fixtureDocument();
    expect(pdfPageSize("a4")).toBe("A4");
    expect(pdfPageSize("letter")).toBe("LETTER");
    const a4 = ExportPdfDocument({ document, options: resolveExportOptions({ pageFormat: "a4" }) });
    const letter = ExportPdfDocument({ document, options: resolveExportOptions({ pageFormat: "letter" }) });
    expect((pageElement(a4).props as { size: string }).size).toBe("A4");
    expect((pageElement(letter).props as { size: string }).size).toBe("LETTER");
  });

  it("renders title, properties, spans, and asset figures for the Notes theme", () => {
    const document = fixtureDocument();
    const assetDataUrls = new Map([["asset-boarding", "data:image/png;base64,aGk="]]);
    const { container } = render(
      <ExportPdfDocument
        document={document}
        options={resolveExportOptions({})}
        assetDataUrls={assetDataUrls}
      />,
    );

    // Title block + properties table (empty values hidden by default).
    expect(screen.getByText("Trip")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("planned")).toBeInTheDocument();
    expect(screen.queryByText("Empty")).toBeNull();

    // Inline spans: marks, mention/chip pills, typed link, math as mono $…$.
    expect(screen.getByText("light")).toBeInTheDocument();
    expect(screen.getByText("Gear")).toBeInTheDocument();
    expect(screen.getByText("#travel")).toBeInTheDocument();
    expect(screen.getByText("authored by")).toBeInTheDocument();
    expect(screen.getByText("$e=mc^2$")).toBeInTheDocument();

    // Asset with a resolved data URL renders a real image; the quote and the
    // unresolved embed keep their reference conventions.
    expect(container.querySelector("image")).not.toBeNull();
    expect(screen.getByText("Take the scenic route")).toBeInTheDocument();
    expect(screen.getByText("![[node-packing]]")).toBeInTheDocument();
    // Inlined embed renders its target's blocks; query/whiteboard are
    // verbatim JSON boxes.
    expect(screen.getByText("inlined body")).toBeInTheDocument();
    expect(screen.getByText(/"op": "and"/)).toBeInTheDocument();
    expect(screen.getByText(/"nodes": \[\]/)).toBeInTheDocument();
  });

  it("renders the placeholder box when an asset has no data URL", () => {
    const document = fixtureDocument();
    const { container } = render(
      <ExportPdfDocument document={document} options={resolveExportOptions({})} />,
    );
    expect(container.querySelector("image")).toBeNull();
    expect(screen.getByText("asset · asset-bo")).toBeInTheDocument();
  });

  it("splits the body across two column views for Academic only", () => {
    const document = fixtureDocument();
    const academic = render(
      <ExportPdfDocument document={document} options={resolveExportOptions({ layout: "academic" })} />,
    );
    const rows = academic.container.querySelectorAll("view[style*='flex-direction: row']");
    // Property rows are also row-views; the columns row is the one whose
    // two children are the column views.
    const columns = [...rows].filter((row) => [...row.children].every((child) => child.tagName === "VIEW"));
    expect(columns).toHaveLength(1);
    expect(columns[0]!.children).toHaveLength(2);
    // Numbered headings: "1." for the top-level child, "1.1." for the nested one.
    expect(academic.container.textContent).toContain("1. Packing");
    expect(academic.container.textContent).toContain("1.1. Toiletries");
    academic.unmount();

    for (const layout of ["notes", "essay"] as const) {
      const single = render(
        <ExportPdfDocument document={document} options={resolveExportOptions({ layout })} />,
      );
      const singleRows = [...single.container.querySelectorAll("view[style*='flex-direction: row']")];
      expect(singleRows.filter((row) => [...row.children].every((child) => child.tagName === "VIEW"))).toHaveLength(0);
      expect(single.container.textContent).not.toContain("1. Packing");
      single.unmount();
    }
  });

  it("themes the page from the layout palette", () => {
    const document = fixtureDocument();
    const notes = render(<ExportPdfDocument document={document} options={resolveExportOptions({ layout: "notes" })} />);
    expect(notes.container.querySelector("page")!.getAttribute("style")).toContain("background-color");
    // Notes carries the warm-paper canvas; essay/academic are white.
    expect(PDF_THEMES.notes.colors.paper).toBe("#f5f3ef");
    expect(PDF_THEMES.essay.colors.paper).toBe("#ffffff");
    expect(PDF_THEMES.academic.twoColumnBody).toBe(true);
    notes.unmount();
  });
});

describe("renderSubtreePdf", () => {
  it("resolves asset data URLs and produces an application/pdf blob named <slug>.pdf", async () => {
    const client = await makeClient();
    const assetId = "0192a000-0000-7000-8000-0000000000a1";
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "asset_ref", assetId }],
    });

    const dataUrlSpy = vi
      .spyOn(client, "getAssetDataUrl")
      .mockResolvedValue("data:image/png;base64,aGk=");

    const exported = await renderSubtreePdf(client, pageId, { layout: "essay", pageFormat: "letter" });

    // The IR's asset ref reached the cached client read, and the document
    // element carries the resolved data URL + the merged engine options.
    expect(dataUrlSpy).toHaveBeenCalledWith(assetId);
    expect(pdfMock.calls).toHaveLength(1);
    const element = pdfMock.calls[0] as ReactElement<{
      document: ExportDocument;
      options: { layout: string; pageFormat: string };
      assetDataUrls: Map<string, string>;
    }>;
    expect(element.props.options.layout).toBe("essay");
    expect(element.props.options.pageFormat).toBe("letter");
    expect(element.props.assetDataUrls.get(assetId)).toBe("data:image/png;base64,aGk=");

    expect(exported.blob.type).toBe("application/pdf");
    expect(exported.filename).toBe("Trip.pdf");
  });

  it("keeps exporting when an asset data URL is unavailable", async () => {
    const client = await makeClient();
    const assetId = "0192a000-0000-7000-8000-0000000000a1";
    const pageId = await client.createObject({ presentAsMain: true, name: "Trip" });
    await client.createObject({
      parentId: pageId,
      contentAst: [{ type: "asset_ref", assetId }],
    });
    vi.spyOn(client, "getAssetDataUrl").mockResolvedValue(null);

    const exported = await renderSubtreePdf(client, pageId);
    expect(exported.blob.type).toBe("application/pdf");
    const element = pdfMock.calls[0] as ReactElement<{ assetDataUrls: Map<string, string> }>;
    expect(element.props.assetDataUrls.size).toBe(0);
  });

  it("throws loud for an unknown root, like the other engine entries", async () => {
    const client = await makeClient();
    await expect(renderSubtreePdf(client, "0192a000-0000-7000-8000-0000000000ff")).rejects.toThrow(
      /node not found/,
    );
  });
});

/** Read a Blob's bytes in jsdom (whose Blob has no arrayBuffer()). */
function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe("renderSubtreePdfBatch", () => {
  it("zips one <slug>-<id8>.pdf per root, named after the first root", async () => {
    const client = await makeClient();
    const tripId = await client.createObject({ presentAsMain: true, name: "Trip" });
    const packingId = await client.createObject({ presentAsMain: true, name: "Packing" });

    const exported = await renderSubtreePdfBatch(client, [tripId, packingId], { layout: "academic" });

    expect(exported.filename).toBe("Trip.zip");
    expect(exported.blob.type).toBe("application/zip");
    const entries = unzipSync(new Uint8Array(await readBlobBytes(exported.blob)));
    const names = Object.keys(entries);
    expect(names.some((name) => /^Trip-[0-9a-f]{8}\.pdf$/.test(name))).toBe(true);
    expect(names.some((name) => /^Packing-[0-9a-f]{8}\.pdf$/.test(name))).toBe(true);
    // The task-W conventions: no manifest, per-root files only.
    expect(names).not.toContain("notees-manifest.json");
    expect(names).toHaveLength(2);
    // Both renders ran through the academic layout.
    expect(pdfMock.calls).toHaveLength(2);
    for (const call of pdfMock.calls) {
      expect((call as ReactElement<{ options: { layout: string } }>).props.options.layout).toBe("academic");
    }
  });
});

describe("web registry pdf delivery", () => {
  it("marks pdf available with client-pdf delivery while the package skeleton stays unavailable", () => {
    const web = getWebExportFormat("pdf");
    expect(web).toBeDefined();
    expect(web!.availability.status).toBe("available");
    expect(web!.delivery).toBe("client-pdf");
    expect(web!.mimeType).toBe("application/pdf");
    expect(web!.extension).toBe("pdf");

    // The package serializer remains a throwing skeleton — a pure package
    // cannot pull react-pdf in; only the web client overrides availability.
    const packageFormat = getPackageExportFormat("pdf");
    expect(packageFormat!.availability.status).toBe("unavailable");
    expect(() => packageFormat!.serialize({} as ExportDocument)).toThrow(/task P1/);
  });
});
