/**
 * The public share render — the body behind `GET /s/<token>`.
 *
 * Deliberately a NO-APP document: no JavaScript, no app chrome, no external
 * resource — a standalone HTML page whose body is the export package's HTML
 * projection of the shared node's subtree (the same hardened serializer the
 * HTML export format uses: escaping-correct, cycle-guarded, nested-list
 * outline, inlined token-only stylesheet). The ExportNode mapping and the
 * nameOf/childrenOf resolution mirror the workspace-zip export in
 * routes-auth.ts (the established idiom — the mapping intentionally stays
 * local per consumer, like the CLI/web exporters).
 */

import { deriveDisplayName } from "@notees/domain";
import {
  buildExportDocument,
  renderExportDocumentToHtml,
  resolveExportOptions,
  type ExportContext,
  type ExportNode,
} from "@notees/export";
import type { NodeRow, Store } from "@notees/store";

import { fullObject } from "./routes-objects.js";

function toExportNode(store: Store, row: NodeRow): ExportNode {
  const object = fullObject(store, row);
  return {
    id: object.id,
    isClass: object.isClass ? 1 : 0,
    presentAsMain: object.presentAsMain ? 1 : 0,
    parentId: object.parentId,
    name: object.name,
    contentAst: object.contentAst as ExportNode["contentAst"],
    classIds: object.classIds,
    properties: object.properties.map((property) => ({
      schemaId: property.schemaId,
      schemaName: property.schemaName,
      value: property.value,
      ...(typeof property.metadata === "object" && property.metadata !== null && !Array.isArray(property.metadata)
        ? { metadata: property.metadata as Record<string, unknown> }
        : {}),
    })),
  };
}

/**
 * Render the shared node (and its inline-body subtree) to one standalone,
 * self-contained HTML document. `childrenOf` selects the inline body zone
 * (parented, render bit unset) — the block tree; main children are subpages
 * and stay outside a single share's closure, mirroring the markdown outline.
 */
export function renderSharedNode(store: Store, row: NodeRow): string {
  const nameOf = (nodeId: string): string | undefined => {
    const target = store.getNode(nodeId);
    if (target === undefined || target.is_active !== 1) return undefined;
    return (
      deriveDisplayName({
        id: target.id,
        isClass: target.is_class,
        presentAsMain: target.present_as_main,
        contentAst: JSON.parse(target.content) as ExportNode["contentAst"],
        classIds: JSON.parse(target.class_ids) as string[],
      }) || undefined
    );
  };
  const ctx: ExportContext = {
    nameOf,
    childrenOf: (parentId) =>
      store
        .children(parentId)
        .filter((child) => child.is_class === 0 && child.present_as_main === 0 && child.is_active === 1)
        .map((child) => toExportNode(store, child)),
  };
  const options = resolveExportOptions();
  return renderExportDocumentToHtml(buildExportDocument(toExportNode(store, row), ctx, options), options);
}
