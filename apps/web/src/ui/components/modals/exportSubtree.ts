/**
 * Full-subtree Markdown export — the web client's export engine.
 *
 * Built on @notees/export: the page and every descendant (blocks and child
 * pages, depth-first) become one Markdown document. Block children render as
 * nested bullets under their node (the exporter's `childrenOf`); child pages
 * become their own sections separated by thematic breaks (concatBundle).
 * Names for mentions / chips / class ids resolve through the client's live
 * display-name read (rename-free: the CURRENT name renders).
 *
 * Single-node delivery keeps the concatenated-document shape (preview +
 * one `.md` download). Batch delivery (§34.24 E3) builds one bundle over
 * every selected root's subtree and zips it the E5 way: `<slug>-<uuid8>.md`
 * filenames, sidecar whiteboards, and `notees-manifest.json` — relative
 * link rewriting between pages is deliberately not applied (single-workspace
 * zips from the modal keep the `[[name]]` conventions).
 *
 * Include-assets delivery (§34.24 E7): the exported subtrees are scanned
 * for `asset_ref` tokens, the bytes are fetched concurrency-limited through
 * the client's REST read, and the bundle is zipped with the assets under
 * `assets/<name-slug>-<hash8>.<ext>` — the same naming the server-side
 * workspace zip (E5) uses. The `assetPath` hook then rewrites each Markdown
 * asset ref to its relative path; assets with missing metadata or
 * unfetchable bytes keep the raw uuid reference and add no file.
 *
 * Format-routed delivery (§34.24 task W): the modal's format cards select a
 * registry format, and the export dispatches on it — markdown keeps the
 * historical paths above; html/latex/docx build ONE ExportDocument over the
 * root's whole subtree (child pages ride the outline — these formats deliver
 * a single file, so there is no per-child-page filing like markdown's
 * concat) and render through the package serializers. MIME type and
 * extension come from the web registry's delivery table, never hardcoded
 * per format. Batch delivery for those formats is one zip of per-root
 * rendered files (see exportSubtreeBatchFile).
 */

import { zipSync } from "fflate";

import {
  buildExportDocument,
  bundleMarkdown,
  concatBundleMarkdown,
  exportFileName,
  renderExportDocumentToDocx,
  renderExportDocumentToHtml,
  renderExportDocumentToLatex,
  resolveExportOptions,
  type ExportBundle,
  type ExportContext,
  type ExportDocument,
  type ExportFile,
  type ExportFormatId,
  type ExportNode,
  type ExportOptions,
  type ExportPropertyValue,
  type ResolvedExportOptions,
} from "@notees/export";
import { rendersAsInlineBlock } from "@notees/domain";

import { displayNameForSettings, displayNameFromClient } from "../../dateDisplay.js";

import { getExportFormat as getWebExportFormat } from "./registerExportFormats.js";

import type { WorkspaceClient } from "@/core/workspace-client.js";
import type { WorkerClient } from "@/core/worker-client.js";

export type ExportClient = WorkspaceClient | WorkerClient;

/** Map a client node to the exporter's shape, with its effective properties. */
export function toExportNode(client: ExportClient, id: string): ExportNode | undefined {
  const node = client.getNode(id);
  if (node === undefined) return undefined;
  const properties: ExportPropertyValue[] = client
    .getEffectiveProperties(id)
    .map((property) => ({
      schemaId: property.propertySchemaId,
      schemaName: property.schema?.name ?? property.propertySchemaId,
      value: property.value,
      ...(property.metadata !== null ? { metadata: property.metadata } : {}),
    }));
  return {
    id: node.id,
    isClass: node.isClass ? 1 : 0,
    presentAsMain: node.presentAsMain ? 1 : 0,
    parentId: node.parentId,
    // Export DTO name = the node's resolved display name (title-is-content:
    // derived from its content, rename-free).
    name: displayNameForSettings(node) || null,
    contentAst: node.contentAst,
    classIds: node.classIds,
    properties,
  };
}

/** Inline-body children only — the nested-bullet read (child pages are files). */
function blockChildrenOf(client: ExportClient, id: string): ExportNode[] {
  const nodes: ExportNode[] = [];
  for (const child of client.getChildren(id)) {
    if (!rendersAsInlineBlock(child)) continue;
    const mapped = toExportNode(client, child.id);
    if (mapped !== undefined) nodes.push(mapped);
  }
  return nodes;
}

function makeExportContext(
  client: ExportClient,
  hooks?: { assetPath?: ((assetId: string) => string | undefined) | undefined },
): ExportContext {
  return {
    nameOf: (id) => displayNameFromClient(client, id) ?? undefined,
    childrenOf: (id) => blockChildrenOf(client, id),
    ...(hooks?.assetPath !== undefined ? { assetPath: hooks.assetPath } : {}),
  };
}

/** Depth-first node list for one root: the root, then each child-page subtree. */
function collectSubtree(client: ExportClient, rootId: string, includeChildPages: boolean): ExportNode[] {
  const visited = new Set<string>();
  const ordered: ExportNode[] = [];
  const collect = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = toExportNode(client, id);
    if (node === undefined) return;
    ordered.push(node);
    if (!includeChildPages) return;
    // Child pages = the main-children zone (present-as-main children of any
    // node type); inline body blocks stay inside their node's file.
    for (const child of client.getChildren(id)) {
      if (!child.isClass && child.presentAsMain) collect(child.id);
    }
  };
  collect(rootId);
  return ordered;
}

export interface SubtreeExport {
  /** The concatenated Markdown document (frontmatter per node, `---` breaks). */
  markdown: string;
  /** Suggested download filename (`<title>.md`). */
  filename: string;
}

export interface ExportSubtreeOptions {
  /** false → only the root node (its block tree still renders as bullets). */
  includeChildPages?: boolean;
  /** Engine bag pass-through — see @notees/export's ExportOptions. */
  includeEmbedded?: boolean;
  includeOutline?: boolean;
  hideEmptyProperties?: boolean;
  showTypeLabels?: boolean;
}

/** The engine options the modal's checkbox rows reach. */
function engineOptions(options: ExportSubtreeOptions): ExportOptions {
  return {
    includeEmbedded: options.includeEmbedded,
    includeOutline: options.includeOutline,
    hideEmptyProperties: options.hideEmptyProperties,
    showTypeLabels: options.showTypeLabels,
  };
}

/**
 * Render the subtree rooted at `rootId` into one Markdown document.
 * Depth-first: the root first, then each child-page subtree in child order.
 */
export function exportSubtreeMarkdown(
  client: ExportClient,
  rootId: string,
  options: ExportSubtreeOptions = {},
): SubtreeExport {
  const root = client.getNode(rootId);
  if (root === undefined) throw new Error("exportSubtreeMarkdown: node not found");

  const ordered = collectSubtree(client, rootId, options.includeChildPages ?? true);
  const bundle = bundleMarkdown(ordered, makeExportContext(client), engineOptions(options));
  const title = displayNameForSettings(root).trim();
  const filename = `${title.length > 0 ? title.replace(/[\\/:*?"<>|]/g, "-") : root.id}.md`;
  return { markdown: concatBundleMarkdown(bundle), filename };
}

export interface ExportSubtreeBundleOptions extends ExportSubtreeOptions {
  /** Bundle naming; batch zip delivery uses "slug" (the E5 convention). */
  filenamePolicy?: "uuid" | "slug";
  /** Whiteboard projection; batch zip delivery uses "sidecar" (the E5 convention). */
  whiteboardMode?: "inline" | "sidecar";
  /**
   * asset_ref CAS id → bundle-relative path of its bytes (include-assets
   * delivery, E7). Passed through to the exporter's `assetPath` hook so the
   * Markdown refs rewrite relative; misses keep the raw uuid reference.
   */
  assetPath?: (assetId: string) => string | undefined;
}

/**
 * Build one bundle over every selected root's subtree — the batch-zip
 * delivery: one `<slug>-<uuid8>.md` per node plus sidecar whiteboards and
 * the v2 manifest, mirroring the E5 server zip conventions.
 */
export function exportSubtreeBundle(
  client: ExportClient,
  rootIds: readonly string[],
  options: ExportSubtreeBundleOptions = {},
): ExportBundle {
  const includeChildPages = options.includeChildPages ?? true;
  const ordered = rootIds.flatMap((id) => collectSubtree(client, id, includeChildPages));
  return bundleMarkdown(ordered, makeExportContext(client, { assetPath: options.assetPath }), {
    ...engineOptions(options),
    filenamePolicy: options.filenamePolicy ?? "slug",
    whiteboardMode: options.whiteboardMode ?? "sidecar",
  });
}

/**
 * Claim a bundle/zip path against the in-use set — a later collision gains
 * `-2`, `-3`, … before the extension, mirroring the server zip's path
 * assignment. Shared by the markdown bundle de-duplication, the
 * format-routed batch zip (task W), and the P1 PDF batch zip.
 * Exported for the P1 PDF engine.
 */
export function claimUniquePath(used: Set<string>, path: string): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const match = /^(.*?)(\.[^.]+)$/.exec(path);
  const stem = match?.[1] ?? path;
  const ext = match?.[2] ?? "";
  let candidate = path;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${stem}-${counter}${ext}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Make bundle file paths unique — a later collision gains `-2`, `-3`, …
 * before the extension, mirroring the server zip's path assignment — and
 * keep the manifest paths in agreement. The bundle emits one file per node
 * in manifest order followed by that node's sidecars, so the node files are
 * exactly the files matching the next manifest entry's path.
 */
function dedupeBundlePaths(bundle: ExportBundle): ExportBundle {
  const used = new Set<string>();
  const files: ExportFile[] = [];
  const nodes = bundle.manifest.nodes.map((node) => ({ ...node }));
  let nodeIndex = 0;
  let changed = false;
  for (const file of bundle.files) {
    const entry = nodes[nodeIndex];
    const nodeFile = entry !== undefined && file.path === entry.path;
    const path = claimUniquePath(used, file.path);
    if (path !== file.path) {
      changed = true;
      files.push({ ...file, path });
      if (nodeFile) nodes[nodeIndex] = { ...entry, path };
    } else {
      files.push(file);
    }
    if (nodeFile) nodeIndex += 1;
  }
  if (!changed) return bundle;
  return { files, manifest: { ...bundle.manifest, nodes } };
}

/**
 * Zip a bundle the E5 way: files at their (de-duplicated) bundle paths,
 * asset bytes under `assets/` when included, plus `notees-manifest.json`
 * (the bundle manifest, version 2).
 */
export function zipExportBundle(
  bundle: ExportBundle,
  assets?: ReadonlyMap<string, SubtreeAssetFile>,
): Uint8Array<ArrayBuffer> {
  const unique = dedupeBundlePaths(bundle);
  const entries: Record<string, Uint8Array> = {};
  for (const file of unique.files) {
    entries[file.path] = new TextEncoder().encode(file.content);
  }
  if (assets !== undefined) {
    // The map may hold several ref ids pointing at one file (same
    // name+hash); emit each path once.
    const emitted = new Set<string>();
    for (const asset of assets.values()) {
      if (emitted.has(asset.path)) continue;
      emitted.add(asset.path);
      entries[asset.path] = asset.bytes;
    }
  }
  entries["notees-manifest.json"] = new TextEncoder().encode(
    `${JSON.stringify(unique.manifest, null, 2)}\n`,
  );
  // Copy into a fresh ArrayBuffer-backed array: fflate types its result as
  // Uint8Array<ArrayBufferLike>, which Blob's constructor rejects.
  return new Uint8Array(zipSync(entries));
}

/** Batch-zip download name: the first root's title slug (E5's `<slug>.zip`). */
export function exportZipFileName(client: ExportClient, firstRootId: string): string {
  const root = client.getNode(firstRootId);
  const title = root === undefined ? "" : displayNameForSettings(root).trim();
  const slug = title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return `${slug.length > 0 ? slug : "export"}.zip`;
}

// --- format-routed delivery (§34.24 task W) -----------------------------------

/**
 * Every non-class child joins the outline — the one-file formats (html/docx/
 * latex) deliver the root's WHOLE subtree inside one document, so child pages
 * are outline entries here instead of files of their own (markdown files
 * them separately and concatenates, see blockChildrenOf). With
 * `includeChildPages` off the outline keeps to inline blocks, mirroring the
 * markdown single-node read.
 */
function subtreeChildrenOf(client: ExportClient, id: string, includeChildPages: boolean): ExportNode[] {
  const nodes: ExportNode[] = [];
  for (const child of client.getChildren(id)) {
    if (child.isClass) continue;
    if (!includeChildPages && child.presentAsMain) continue;
    const mapped = toExportNode(client, child.id);
    if (mapped !== undefined) nodes.push(mapped);
  }
  return nodes;
}

/**
 * Build the single-file IR for the routed formats: ONE ExportDocument over
 * the root's whole subtree, resolved once (names, outline tree, embed
 * inlining) — the package serializers stay ctx-free projections over it.
 * This is the shared IR construction the format switch below reuses.
 *
 * Exported for the P1 PDF engine (ui/export-pdf): it consumes the same IR
 * through the single shared construction instead of re-deriving it.
 */
export function buildSubtreeDocument(
  client: ExportClient,
  rootId: string,
  options: ExportSubtreeOptions,
): { document: ExportDocument; resolved: ResolvedExportOptions } {
  const node = toExportNode(client, rootId);
  if (node === undefined) throw new Error("exportSubtree: node not found");
  const resolved = resolveExportOptions(engineOptions(options));
  const includeChildPages = options.includeChildPages ?? true;
  const ctx: ExportContext = {
    nameOf: (id) => displayNameFromClient(client, id) ?? undefined,
    childrenOf: (id) => subtreeChildrenOf(client, id, includeChildPages),
  };
  return { document: buildExportDocument(node, ctx, resolved), resolved };
}

/** Single-file download name: `<title-slug>.<ext>`, falling back to the node
 *  id for empty titles (the markdown path's own naming stays untouched in
 *  exportSubtreeMarkdown). Exported for the P1 PDF engine's download names. */
export function exportFileSlugName(rootName: string, rootId: string, extension: string): string {
  const slug = rootName.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return `${slug.length > 0 ? slug : rootId}.${extension}`;
}

export interface ExportSubtreeFileOptions extends ExportSubtreeOptions {
  /** The selected registry format card — routes the built IR to its serializer. */
  format: ExportFormatId;
}

export interface SubtreeFileExport {
  blob: Blob;
  filename: string;
}

/**
 * Format-routed single-node delivery (task W): markdown keeps the historical
 * concatenated-document path (exportSubtreeMarkdown — behavior untouched);
 * html and latex render the built document to text, docx resolves its OOXML
 * package bytes. MIME type and extension always come from the web registry's
 * delivery table for the selected format — never hardcoded per format.
 *
 * Assets (E7): only markdown has an asset-bytes path today; for the other
 * formats `includeAssets` is accepted but ignored — the package serializers
 * render placeholder refs and there is nothing to zip alongside. The modal
 * only surfaces the option on the markdown card, so this never surprises.
 */
export async function exportSubtreeFile(
  client: ExportClient,
  rootId: string,
  options: ExportSubtreeFileOptions,
): Promise<SubtreeFileExport> {
  const delivery = getWebExportFormat(options.format);
  if (delivery === undefined) {
    throw new Error(`exportSubtreeFile: "${options.format}" has no web delivery metadata`);
  }
  if (options.format === "markdown") {
    const exported = exportSubtreeMarkdown(client, rootId, options);
    return { blob: new Blob([exported.markdown], { type: delivery.mimeType }), filename: exported.filename };
  }
  const root = client.getNode(rootId);
  if (root === undefined) throw new Error("exportSubtreeFile: node not found");
  const { document, resolved } = buildSubtreeDocument(client, rootId, options);
  const filename = exportFileSlugName(displayNameForSettings(root).trim(), rootId, delivery.extension);
  switch (options.format) {
    case "html":
      return {
        blob: new Blob([renderExportDocumentToHtml(document, resolved)], { type: delivery.mimeType }),
        filename,
      };
    case "latex":
      return {
        blob: new Blob([renderExportDocumentToLatex(document, resolved)], { type: delivery.mimeType }),
        // LaTeX ships as application/x-latex (the registry's delivery table);
        // the .tex extension is what a TeX toolchain keys off, so the mime
        // needs no text/plain fallback.
        filename,
      };
    case "docx": {
      const bytes = await renderExportDocumentToDocx(document, resolved);
      // Copy into a fresh ArrayBuffer-backed array: the packer types its
      // result as Uint8Array<ArrayBufferLike>, which Blob's constructor rejects.
      return { blob: new Blob([new Uint8Array(bytes)], { type: delivery.mimeType }), filename };
    }
    default:
      // pdf: rendered by the lazily imported client-side engine (task P1,
      // ui/export-pdf) — routing it here is a programmer error, so fail
      // loud like the package registry does.
      throw new Error(`${options.format} export must route through the client-side PDF engine (ui/export-pdf)`);
  }
}

/**
 * Batch delivery for the non-markdown formats (task W): ONE zip carrying
 * each root's rendered file, named by the E3 slug policy
 * (`<slug>-<id8>.<ext>` — the bundle's exportFileName with the registry
 * extension swapped for the markdown suffix).
 *
 * Two deliberate v1 simplifications, documented choices:
 *  - NO `notees-manifest.json` — the manifest is a markdown-bundle concept
 *    (a uuid↔name↔path map over per-NODE files); these zips hold one file
 *    per ROOT with each root's whole subtree inside its file.
 *  - NO asset bytes — the package serializers have no bytes path (asset
 *    blocks stay placeholder refs), so there is nothing to zip under
 *    assets/; the modal's include-assets toggle is markdown-only.
 *
 * markdown is NOT routed here — its batch delivery is the E3/E7 bundle zip
 * (exportSubtreeBundle + zipExportBundle, include-assets orchestration and
 * all), which the modal drives directly; passing it is a programmer error.
 * pdf is NOT routed here either — its batch delivery is the client-side PDF
 * engine's zip (ui/export-pdf renderSubtreePdfBatch, task P1).
 */
export async function exportSubtreeBatchFile(
  client: ExportClient,
  rootIds: readonly string[],
  options: ExportSubtreeFileOptions,
): Promise<SubtreeFileExport> {
  const delivery = getWebExportFormat(options.format);
  if (options.format === "markdown" || delivery === undefined) {
    throw new Error("exportSubtreeBatchFile: route markdown batch delivery through exportSubtreeBundle (E3/E7)");
  }
  if (options.format === "pdf") {
    throw new Error("exportSubtreeBatchFile: route pdf batch delivery through the client-side PDF engine (task P1)");
  }
  const encode = new TextEncoder();
  const entries: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const rootId of rootIds) {
    const node = toExportNode(client, rootId);
    if (node === undefined) continue;
    const { document, resolved } = buildSubtreeDocument(client, rootId, options);
    let bytes: Uint8Array;
    if (options.format === "docx") {
      bytes = new Uint8Array(await renderExportDocumentToDocx(document, resolved));
    } else {
      const text =
        options.format === "html"
          ? renderExportDocumentToHtml(document, resolved)
          : renderExportDocumentToLatex(document, resolved);
      bytes = encode.encode(text);
    }
    const path = claimUniquePath(
      used,
      exportFileName(node, "slug").replace(/\.md$/, `.${delivery.extension}`),
    );
    entries[path] = bytes;
  }
  // Copy into a fresh ArrayBuffer-backed array: fflate types its result as
  // Uint8Array<ArrayBufferLike>, which Blob's constructor rejects.
  const blob = new Blob([new Uint8Array(zipSync(entries))], { type: "application/zip" });
  return { blob, filename: exportZipFileName(client, rootIds[0]!) };
}

// --- include-assets delivery (§34.24 E7) -------------------------------------

/**
 * Every `asset_ref` CAS id across the exported subtrees — the root's own
 * stream, its inline-body descendants, and (with `includeChildPages`) every
 * child page's subtree in child order. Mirrors the E5 server-side walk so
 * client and server zips bundle the same asset set.
 */
export function collectSubtreeAssetRefIds(
  client: ExportClient,
  rootIds: readonly string[],
  includeChildPages: boolean,
): string[] {
  const refs = new Set<string>();
  const visit = (id: string, visited: Set<string>): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = client.getNode(id);
    if (node === undefined) return;
    for (const token of node.contentAst) {
      if (token.type === "asset_ref") refs.add(token.assetId);
    }
    for (const child of client.getChildren(id)) {
      if (child.isClass) continue;
      // Inline blocks belong to this node's file (always scanned); child
      // pages ride along only when the subtree option includes them.
      if (child.presentAsMain) {
        if (includeChildPages) visit(child.id, visited);
      } else {
        visit(child.id, visited);
      }
    }
  };
  for (const rootId of rootIds) visit(rootId, new Set());
  return [...refs];
}

export interface SubtreeAssetFile {
  /** Bundle-relative zip path: `assets/<name-slug>-<hash8>.<ext>` (the E5 convention). */
  path: string;
  bytes: Uint8Array;
}

/** Extension fallback for asset filenames without a usable original one. */
const ASSET_MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "application/epub+zip": "epub",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
};

/**
 * Zip file naming for one asset — the same policy the E5 server zip uses
 * (`routes-auth.ts`): the original name slug (extension stripped) plus the
 * content hash's first 8 hex chars, so identical names from different bytes
 * stay unique. The extension prefers the upload's original name (sanitized
 * to a short alphanumeric token), then the sniffed mime mapping, then `bin`.
 * The content hash is already in the local node_asset row, so no extra
 * digest is computed client-side.
 */
function assetZipFileName(originalName: string, hash: string, mimeType: string): string {
  const slug = originalName
    .replace(/\.[A-Za-z0-9]{1,8}$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const dot = originalName.lastIndexOf(".");
  const rawExt = dot > 0 ? originalName.slice(dot + 1).toLowerCase() : "";
  const ext = /^[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : (ASSET_MIME_EXTENSIONS[mimeType] ?? "bin");
  return `${slug.length > 0 ? `${slug}-` : ""}${hash.slice(0, 8)}.${ext}`;
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
 * Order-preserving concurrency-limited map: at most `limit` tasks run at
 * once. Asset fetches are N+1 REST reads; a small pool keeps the tab
 * responsive on subtrees heavy with assets. Rejections propagate.
 * Exported for the P1 PDF engine's data-URL asset resolution.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
}

/** Asset byte fetches in flight at once (E7: small pool, no dependency). */
const ASSET_FETCH_CONCURRENCY = 4;

/**
 * Fetch the bytes of every referenced asset: metadata from the local
 * node_asset rows (`getAssetInfo` resolves a raw asset_ref id), bytes via
 * the client's REST read, at most {@link ASSET_FETCH_CONCURRENCY} at a
 * time. Unknown assets and fetch failures skip silently — the Markdown
 * keeps the raw uuid ref and no file is added.
 */
export async function fetchSubtreeAssets(
  client: ExportClient,
  assetRefIds: readonly string[],
): Promise<Map<string, SubtreeAssetFile>> {
  const files = new Map<string, SubtreeAssetFile>();
  const byPath = new Map<string, SubtreeAssetFile>();
  await mapWithConcurrency(assetRefIds, ASSET_FETCH_CONCURRENCY, async (refId) => {
    if (files.has(refId)) return;
    const info = client.getAssetInfo(refId);
    if (info === undefined) return;
    const path = `assets/${assetZipFileName(info.originalName, info.hash, info.mimeType)}`;
    const existing = byPath.get(path);
    if (existing !== undefined) {
      // Same name+hash — same bytes; point the second ref at the one file.
      files.set(refId, existing);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await blobBytes(await client.fetchAssetBytes(info.assetId));
    } catch {
      return;
    }
    const file: SubtreeAssetFile = { path, bytes };
    byPath.set(path, file);
    files.set(refId, file);
  });
  return files;
}
