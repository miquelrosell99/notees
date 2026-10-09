/**
 * PDF render entry — the lazily-imported engine behind the
 * export modal's PDF card. The modal reaches this module ONLY through
 * `await import("@/ui/export-pdf/renderPdf.js")`, so @react-pdf/renderer,
 * the font bundle, and this code live in their own async chunk and never
 * join the main bundle.
 *
 * The flow mirrors the package-serializer formats: ONE ExportDocument over
 * the root's whole subtree through the shared IR construction
 * (buildSubtreeDocument), then the react-pdf component tree renders it.
 * Assets resolve through the client's cached image read into data URLs
 * (concurrency-limited); a miss renders the placeholder box, exactly the
 * single-file conventions (no bytes leave the workspace otherwise).
 * Delivery: `pdf(<ExportPdfDocument/>).toBlob()` → one `<slug>.pdf`; a
 * batch renders every root and zips one `<slug>-<id8>.pdf` per root (the
 * task-W batch conventions: no manifest, named after the first root).
 */

import { pdf } from "@react-pdf/renderer";
import { zipSync } from "fflate";

import { exportFileName, type ResolvedExportOptions } from "@notees/export";

import { displayNameForSettings } from "../dateDisplay.js";

import {
  buildSubtreeDocument,
  claimUniquePath,
  exportFileSlugName,
  exportZipFileName,
  mapWithConcurrency,
  toExportNode,
  type ExportClient,
  type ExportSubtreeOptions,
} from "../components/modals/exportSubtree.js";

import { ExportPdfDocument, pdfPageSize } from "./pdfDocument.js";
import type { PdfLayout } from "./theme.js";

export interface RenderSubtreePdfOptions extends ExportSubtreeOptions {
  /** Layout theme (modelling decision 2); default notes. */
  layout?: PdfLayout;
  /** Page size; default a4. */
  pageFormat?: "a4" | "letter";
}

export interface RenderedPdfExport {
  blob: Blob;
  filename: string;
}

/** Layout/pageFormat are not part of the modal's boolean engine options —
 *  merge them over the IR defaults so the resolved bag reaches the document. */
function resolvedPdfOptions(options: RenderSubtreePdfOptions): Pick<ResolvedExportOptions, "layout" | "pageFormat"> {
  return {
    layout: options.layout ?? "notes",
    pageFormat: options.pageFormat ?? "a4",
  };
}

/** Data URLs in flight at once — the same small pool discipline as E7. */
const ASSET_DATA_URL_CONCURRENCY = 4;

/**
 * The mdi-<kebab-name> → SVG path d map, built from the app's sprite sheet
 * (`public/mdi-sprite.svg` — the SAME source the UI's Icon component draws
 * from, so a PDF mention chip and the on-screen row can never disagree).
 * Fetched once per session, cached module-level; any failure answers an
 * empty map — the chips fall back to name-only, never a failed export.
 */
let mdiSpritePromise: Promise<ReadonlyMap<string, string>> | null = null;

export function mdiIconPaths(): Promise<ReadonlyMap<string, string>> {
  mdiSpritePromise ??= (typeof fetch === "function"
    ? fetch("/mdi-sprite.svg").then((response) => {
        if (!response.ok) throw new Error(`mdi sprite: HTTP ${response.status}`);
        return response.text();
      })
    : Promise.reject(new Error("fetch unavailable"))
  )
    .then((text) => {
      const doc = new DOMParser().parseFromString(text, "image/svg+xml");
      const map = new Map<string, string>();
      for (const symbol of Array.from(doc.querySelectorAll("symbol"))) {
        const id = symbol.getAttribute("id");
        const path = symbol.querySelector("path")?.getAttribute("d");
        if (id !== null && id !== undefined && path !== null && path !== undefined) map.set(id, path);
      }
      return map;
    })
    .catch(() => new Map<string, string>());
  return mdiSpritePromise;
}

/** Blob → bytes, with a FileReader fallback for jsdom (whose Blob lacks arrayBuffer). */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Every asset_ref CAS id → image data URL through the client's cached read.
 * Non-image assets and fetch misses skip silently — the document renders
 * the bordered placeholder for them, and the export never goes fatal.
 */
async function fetchAssetDataUrls(
  client: ExportClient,
  assetRefIds: readonly string[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  await mapWithConcurrency(assetRefIds, ASSET_DATA_URL_CONCURRENCY, async (refId) => {
    try {
      const dataUrl = await client.getAssetDataUrl(refId);
      if (dataUrl !== null) urls.set(refId, dataUrl);
    } catch {
      // Unfetchable — the placeholder box stands in for the image.
    }
  });
  return urls;
}

/**
 * Render one node's subtree to a PDF blob: the shared IR over the whole
 * subtree, asset data URLs resolved, then the react-pdf render (fonts and
 * pagination handled by the renderer). The blob's type is the registry's
 * application/pdf delivery MIME.
 */
export async function renderSubtreePdf(
  client: ExportClient,
  rootId: string,
  options: RenderSubtreePdfOptions = {},
): Promise<RenderedPdfExport> {
  const root = client.getNode(rootId);
  if (root === undefined) throw new Error("renderSubtreePdf: node not found");
  const { document, resolved } = buildSubtreeDocument(client, rootId, options);
  const merged = { ...resolved, ...resolvedPdfOptions(options) };
  const assetDataUrls = await fetchAssetDataUrls(client, document.assetRefs);
  const iconPaths = await mdiIconPaths();
  const blob = await pdf(
    <ExportPdfDocument document={document} options={merged} assetDataUrls={assetDataUrls} iconPaths={iconPaths} />,
  ).toBlob();
  const filename = exportFileSlugName(displayNameForSettings(root).trim(), rootId, "pdf");
  return { blob, filename };
}

/**
 * Batch delivery (the task-W conventions for the paged format): ONE zip
 * carrying one rendered `<slug>-<id8>.pdf` per root, named after the first
 * root. No manifest (a markdown-bundle concept) — each file carries its
 * root's whole subtree.
 */
export async function renderSubtreePdfBatch(
  client: ExportClient,
  rootIds: readonly string[],
  options: RenderSubtreePdfOptions = {},
): Promise<RenderedPdfExport> {
  const entries: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const rootId of rootIds) {
    const node = toExportNode(client, rootId);
    if (node === undefined) continue;
    const rendered = await renderSubtreePdf(client, rootId, options);
    const bytes = await blobBytes(rendered.blob);
    const path = claimUniquePath(used, exportFileName(node, "slug").replace(/\.md$/, ".pdf"));
    entries[path] = bytes;
  }
  const blob = new Blob([new Uint8Array(zipSync(entries))], { type: "application/zip" });
  return { blob, filename: exportZipFileName(client, rootIds[0]!) };
}

/** The react-pdf pageSize tokens (re-exported for callers/tests). */
export { pdfPageSize };
