/**
 * Export bundle: one Markdown file per node (UUID filename — rename-free,
 * §34.12) plus the workspace-level UUID↔name↔type manifest.
 */

import { deriveDisplayName } from "@notees/domain";

import type { ExportContext, ExportNode } from "./markdown.js";
import { nodeToMarkdown } from "./markdown.js";

export interface ExportFile {
  /** `<uuid>.md` — UUID filenames keep exports rename-free (§34.12). */
  path: string;
  content: string;
}

export interface ExportManifestEntry {
  id: string;
  name: string;
  /** Revision-11 render-state booleans (class identity + render bit). */
  isClass: boolean;
  presentAsMain: boolean;
}

/** Workspace-level UUID↔name↔render-state map for the exported subset. */
export interface ExportManifest {
  format: "notees-markdown";
  version: 1;
  generatedAt: string;
  nodes: ExportManifestEntry[];
}

export interface ExportBundle {
  files: ExportFile[];
  manifest: ExportManifest;
}

/**
 * Render a node list into an export bundle. Callers decide the node set
 * (explicit ids, backlink closure, or a query result — the future UI export
 * button passes its live query results straight here).
 */
export function bundleMarkdown(
  nodes: readonly ExportNode[],
  ctx: ExportContext,
): ExportBundle {
  const files: ExportFile[] = nodes.map((node) => ({
    path: `${node.id}.md`,
    content: nodeToMarkdown(node, ctx),
  }));
  const manifest: ExportManifest = {
    format: "notees-markdown",
    version: 1,
    generatedAt: new Date().toISOString(),
    nodes: nodes.map((node) => {
      const name = deriveDisplayName(node);
      return {
        id: node.id,
        name: name.length > 0 ? name : node.id,
        isClass: node.isClass === 1,
        presentAsMain: node.presentAsMain === 1,
      };
    }),
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
