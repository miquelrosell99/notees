/**
 * Export bundle: one Markdown file per node plus the workspace-level
 * UUID↔name↔type manifest. E1/E2 extensions:
 *
 *  - `filenamePolicy` — "uuid" (`<uuid>.md`, rename-free default) or "slug"
 *    (`<slugified-title>-<uuid8>.md`, uuid8 fallback for empty titles; the
 *    uuid8 suffix keeps duplicate titles unique). The server zip (task E5)
 *    reuses this policy.
 *  - `whiteboardMode: "sidecar"` — besides each `.md`, the bundle emits one
 *    `<owner-id>.whiteboard.json` sidecar per whiteboard block (pretty-printed
 *    token layout), named exactly as the serializer's file links name them
 *    (both sides derive from `whiteboardSidecarPath`).
 *  - the manifest entries carry the rendered `path` alongside the id, plus a
 *    `type` discriminator ("page" | "class") — manifest version 2 (E5). The
 *    workspace zip consumes this manifest as its `notees-manifest.json`.
 */

import { deriveDisplayName } from "@notees/domain";

import type { ExportContext, ExportNode } from "./document.js";
import {
  buildExportDocument,
  listWhiteboardBlocks,
  whiteboardSidecarPath,
} from "./document.js";
import { renderExportDocumentToMarkdown } from "./markdown.js";
import type { ExportOptions } from "./options.js";
import { resolveExportOptions } from "./options.js";

export interface ExportFile {
  /** `<uuid>.md` (default policy) or `<slug>-<uuid8>.md` (slug policy). */
  path: string;
  content: string;
}

export interface ExportManifestEntry {
  id: string;
  /** The file this node rendered to (the bundle filename policy applied). */
  path: string;
  name: string;
  /** The exported node's kind — "page" (non-class) or "class". The workspace
   *  zip (E5) exports pages only, so every entry there is "page". */
  type: "page" | "class";
  /** Revision-11 render-state booleans (class identity + render bit). */
  isClass: boolean;
  presentAsMain: boolean;
}

/**
 * Workspace-level UUID↔name↔render-state map for the exported subset.
 * Version 2 adds the entry `type` discriminator (E5); version 1 entries
 * without `type` remain readable as pages.
 */
export interface ExportManifest {
  format: "notees-markdown";
  version: 2;
  generatedAt: string;
  nodes: ExportManifestEntry[];
}

export interface ExportBundle {
  files: ExportFile[];
  manifest: ExportManifest;
}

/**
 * Bundle file naming for one node: "uuid" keeps exports rename-free
 * (§34.12); "slug" renders `<slugified-title>-<uuid8>.md` — the slug keeps
 * unicode letters/numbers (the repo's existing slug idiom), empty titles
 * fall back to the uuid8 alone, and the uuid8 suffix disambiguates duplicate
 * titles (uniqueness never relies on the slug).
 */
export function exportFileName(node: ExportNode, policy: "uuid" | "slug"): string {
  if (policy === "uuid") return `${node.id}.md`;
  const slug = deriveDisplayName(node).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const uuid8 = node.id.slice(0, 8);
  return `${slug.length > 0 ? `${slug}-` : ""}${uuid8}.md`;
}

/**
 * Render a node list into an export bundle. Callers decide the node set
 * (explicit ids, backlink closure, or a query result — the future UI export
 * button passes its live query results straight here). `options` optional —
 * defaults are the hardened E2 behavior (escaping ON, full closure, empty
 * properties hidden, uuid filenames, inline whiteboards).
 */
export function bundleMarkdown(
  nodes: readonly ExportNode[],
  ctx: ExportContext,
  options?: ExportOptions,
): ExportBundle {
  const resolved = resolveExportOptions(options);
  const files: ExportFile[] = [];
  const sidecarPaths = new Set<string>();
  const manifestNodes: ExportManifestEntry[] = [];
  for (const node of nodes) {
    const document = buildExportDocument(node, ctx, resolved);
    const path = exportFileName(node, resolved.filenamePolicy);
    files.push({ path, content: renderExportDocumentToMarkdown(document, resolved) });
    manifestNodes.push({
      id: node.id,
      path,
      name: document.title.length > 0 ? document.title : node.id,
      type: document.isClass ? "class" : "page",
      isClass: document.isClass,
      presentAsMain: document.presentAsMain,
    });
    if (resolved.whiteboardMode === "sidecar") {
      // Per-owner occurrence counting mirrors the serializer's per-stream
      // whiteboard index, so link targets and files agree.
      const counts = new Map<string, number>();
      for (const ref of listWhiteboardBlocks(document)) {
        const index = counts.get(ref.ownerId) ?? 0;
        counts.set(ref.ownerId, index + 1);
        const sidecarPath = whiteboardSidecarPath(ref.ownerId, index);
        if (sidecarPaths.has(sidecarPath)) continue;
        sidecarPaths.add(sidecarPath);
        files.push({ path: sidecarPath, content: JSON.stringify(ref.layout, null, 2) + "\n" });
      }
    }
  }
  const manifest: ExportManifest = {
    format: "notees-markdown",
    version: 2,
    generatedAt: new Date().toISOString(),
    nodes: manifestNodes,
  };
  return { files, manifest };
}

/**
 * Concatenate a bundle into one Markdown document (CLI `--stdout`): each file
 * in order, separated by a thematic break. Non-inline-block files carry
 * their own `# <title>` heading, so every section stays labeled.
 */
export function concatBundleMarkdown(bundle: ExportBundle): string {
  return bundle.files.map((file) => file.content.trimEnd()).join("\n\n---\n\n") + "\n";
}
