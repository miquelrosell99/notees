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
    isEmbedded: object.isEmbedded ? 1 : 0,
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
 * self-contained HTML document. `childrenOf` selects the embedded body zone
 * (parented, is_embedded = 1) — the block tree; standalone children are
 * subpages and stay outside a single share's closure, mirroring the
 * markdown outline's Pages section.
 */
export function renderSharedNode(store: Store, row: NodeRow): string {
  // Share-hardening (the per-node-sharing proposal's contamination ruling):
  // the closure is the shared node's FULL descendant set — a reference
  // (mention, class link, embed, relation value) to anything outside it
  // renders as the redaction label, never the target's title, so a private
  // node's name cannot leak through a link inside a shared page.
  const closure = new Set<string>([row.id]);
  const stack = [row.id];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const child of store.children(id)) {
      if (!closure.has(child.id)) {
        closure.add(child.id);
        stack.push(child.id);
      }
    }
  }
  const nameOf = (nodeId: string): string | undefined => {
    const target = store.getNode(nodeId);
    if (target === undefined || target.is_active !== 1) return undefined;
    return (
      deriveDisplayName({
        id: target.id,
        isClass: target.is_class,
        isEmbedded: target.is_embedded,
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
        .filter((child) => child.is_class === 0 && child.is_embedded === 1 && child.is_active === 1)
        .map((child) => toExportNode(store, child)),
  };
  const options = resolveExportOptions({ refAccessGate: (id) => closure.has(id) });
  return renderExportDocumentToHtml(buildExportDocument(toExportNode(store, row), ctx, options), options);
}
