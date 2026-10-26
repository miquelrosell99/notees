/**
 * queryExport — the export-on-query machinery shared by the query node's
 * section and the Queries hub: @notees/export's bundleMarkdown over the
 * CURRENT result set — full nodes resolved via the client, ctx.nameOf via
 * display-name reads, ctx.childrenOf via direct-children reads — downloaded
 * as one concatenated `.md` (the bundle's files joined by `---`, the CLI's
 * concatBundleMarkdown).
 */

import {
  bundleMarkdown,
  concatBundleMarkdown,
  type ExportContext,
  type ExportNode,
} from "@notees/export";
import { rendersAsInlineBlock } from "@notees/domain";

import { titleOf } from "./dateDisplay.js";
import { parentlessBlockResolverOf } from "./renderStateLabel.js";

import type { ClientNode, EffectiveProperty } from "@/core/workspace-client/index.js";

/** The read surface export-on-query needs (satisfied by both client implementations). */
export interface QueryExportClient {
  getNode(id: string): ClientNode | undefined;
  getDisplayName(id: string): string | null;
  getEffectiveProperties(id: string): EffectiveProperty[];
  getChildren(id: string): ClientNode[];
  /** The parentlessRole "block" demote resolver for the role predicates. */
  effectiveClassParentlessBlock(classId: string): boolean;
}

function toExportNode(client: QueryExportClient, id: string): ExportNode | undefined {
  const node = client.getNode(id);
  if (node === undefined) return undefined;
  return {
    id: node.id,
    isClass: node.isClass ? 1 : 0,
    isEmbedded: node.isEmbedded ? 1 : 0,
    parentId: node.parentId,
    name: node.name,
    contentAst: node.contentAst,
    classIds: node.classIds,
    properties: client.getEffectiveProperties(id).map((property) => ({
      schemaId: property.propertySchemaId,
      schemaName: property.schema?.name ?? "",
      value: property.value,
      ...(property.metadata !== null ? { metadata: property.metadata } : {}),
    })),
  };
}

/**
 * Build the concatenated Markdown for a query result set: full nodes resolved
 * via the client, @notees/export's bundleMarkdown over them (ctx.nameOf from
 * display-name reads, ctx.childrenOf from direct block children), then the
 * bundle's files joined with `---` separators (concatBundleMarkdown).
 * Factored out of the component so tests can assert the markdown directly.
 */
export function buildQueryExportMarkdown(client: QueryExportClient, ids: readonly string[]): string {
  const nodes = ids
    .map((id) => toExportNode(client, id))
    .filter((node): node is ExportNode => node !== undefined);
  const exportCtx: ExportContext = {
    nameOf: (id) => titleOf(client, id) ?? undefined,
    childrenOf: (id) =>
      client
        .getChildren(id)
        .filter((child) =>
          rendersAsInlineBlock(child, client.getNode(id), parentlessBlockResolverOf(client)),
        )
        .map((child) => toExportNode(client, child.id))
        .filter((node): node is ExportNode => node !== undefined),
  };
  return concatBundleMarkdown(bundleMarkdown(nodes, exportCtx));
}

/** Download filename: the first result id's short prefix (deterministic for tests). */
export function queryExportFileName(ids: readonly string[]): string {
  const shortId = ids[0] !== undefined ? ids[0].slice(0, 8) : "query";
  return `notees-export-${shortId}.md`;
}

/** Blob + anchor download (no helper exists in the app yet — deliberately simple). */
export function downloadTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
