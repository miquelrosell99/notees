/**
 * Full-subtree Markdown export — the web client's export engine.
 *
 * Built on @notees/export: the page and every descendant (blocks and child
 * pages, depth-first) become one Markdown document. Block children render as
 * nested bullets under their node (the exporter's `childrenOf`); child pages
 * become their own sections separated by thematic breaks (concatBundle).
 * Names for mentions / chips / class ids resolve through the client's live
 * display-name read (rename-free: the CURRENT name renders).
 */

import {
  bundleMarkdown,
  concatBundleMarkdown,
  type ExportContext,
  type ExportNode,
  type ExportPropertyValue,
} from "@notees/export";
import { rendersAsInlineBlock } from "@notees/domain";

import { displayNameForSettings, displayNameFromClient } from "../../dateDisplay.js";

import type { WorkspaceClient } from "@/core/workspace-client.js";
import type { WorkerClient } from "@/core/worker-client.js";

export type ExportClient = WorkspaceClient | WorkerClient;

/** Map a client node to the exporter's shape, with its effective properties. */
function toExportNode(client: ExportClient, id: string): ExportNode | undefined {
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

export interface SubtreeExport {
  /** The concatenated Markdown document (frontmatter per node, `---` breaks). */
  markdown: string;
  /** Suggested download filename (`<title>.md`). */
  filename: string;
}

export interface ExportSubtreeOptions {
  /** false → only the root node (its block tree still renders as bullets). */
  includeChildPages?: boolean;
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
  const includeChildPages = options.includeChildPages ?? true;
  const root = client.getNode(rootId);
  if (root === undefined) throw new Error("exportSubtreeMarkdown: node not found");

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

  const exportCtx: ExportContext = {
    nameOf: (id) => displayNameFromClient(client, id) ?? undefined,
    childrenOf: (id) => blockChildrenOf(client, id),
  };

  const bundle = bundleMarkdown(ordered, exportCtx);
  const title = displayNameForSettings(root).trim();
  const filename = `${title.length > 0 ? title.replace(/[\\/:*?"<>|]/g, "-") : root.id}.md`;
  return { markdown: concatBundleMarkdown(bundle), filename };
}
