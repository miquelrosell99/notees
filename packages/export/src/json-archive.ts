/**
 * JSON archive (2026-10-04):
 * the object-graph slice as structured JSON in a versioned envelope —
 * every node with its verbatim `contentAst`, `classIds`, authored
 * `properties`, position-ordered `children`, and explicit `edges` metadata
 * mined from the content stream and property values.
 *
 * Doctrine: export is a PROJECTION, one-way by design — this
 * archive is the highest-fidelity projection (raw tokens and raw property
 * values, not display strings), the disaster-recovery / migration artifact
 * and the future re-import harness's input. It is still not the log: HLC
 * clocks, actor ids, and op history are coordination state and stay out.
 *
 * Shape (envelope version 1 — `JSON_ARCHIVE_VERSION`):
 *
 * ```json
 * {
 *   "format": "notees-json-archive",
 *   "version": 1,
 *   "generatedAt": "<ISO-8601>",
 *   "nodes": [
 *     {
 *       "id": "<uuid>", "isClass": false, "presentAsMain": true,
 *       "parentId": "<uuid|null>",
 *       "displayName": "<derived — title-is-content; redundant by design>",
 *       "contentAst": [ …verbatim content tokens… ],
 *       "classIds": ["<uuid>"],
 *       "properties": [{ "schemaId", "schemaName", "schemaType"?,
 *                         "schemaOptions"?, "value", "metadata"? }],
 *       "children": ["<uuid> — direct child ids, position order"],
 *       "edges": [{ "kind": "…", …ids… }]
 *     }
 *   ]
 * }
 * ```
 *
 * Like {@link bundleMarkdown}, the caller decides the node set (selected
 * nodes, a subtree collection, a query result, the whole workspace walk) —
 * the builder stays pure and IO-free. Duplicate ids collapse to the first
 * occurrence (overlapping subtree collections). Node-set-shaped, not
 * IR-shaped, so it stays outside the `EXPORT_FORMATS` registry for the
 * same reason CSV does (see csv.ts).
 */

import type { ContentAst } from "@notees/protocol";
import { deriveDisplayName } from "@notees/domain";

import type { ExportContext, ExportNode, ExportPropertyValue } from "./document.js";

/** Envelope discriminator — pins the artifact's identity. */
export const JSON_ARCHIVE_FORMAT = "notees-json-archive";

/** Envelope version — bump on any breaking shape change. */
export const JSON_ARCHIVE_VERSION = 1;

/**
 * One explicit graph edge mined from a node's content stream or property
 * values. `targetNodeId` edges reference nodes (possibly outside the
 * exported slice — the slice boundary is the caller's choice); `classId` /
 * `schemaId` / `assetId` reference class nodes / property schemas / CAS
 * assets respectively.
 */
export type JsonArchiveEdge =
  | { kind: "mention"; targetNodeId: string }
  | { kind: "embed"; targetNodeId: string }
  | { kind: "typedLink"; verb: string | null; schemaId: string | null }
  | { kind: "class"; classId: string }
  | { kind: "asset"; assetId: string }
  | { kind: "property"; schemaId: string; targetNodeId: string };

/** One node in the archive — the full projection, verbatim payloads. */
export interface JsonArchiveNode {
  id: string;
  /** Revision-11 render-state booleans (class identity + render bit). */
  isClass: boolean;
  presentAsMain: boolean;
  parentId: string | null;
  /** Content-derived display name (title-is-content) — redundant by design,
   *  present so the artifact stays human-readable without replaying
   *  content through the derivation rules. */
  displayName: string;
  /** Verbatim content token stream (marks, displayText, layouts intact). */
  contentAst: ContentAst;
  classIds: readonly string[];
  /** Authored property values verbatim (schema ids + raw values + metadata —
   *  node-typed values stay `{ nodeId }` refs, selects stay option ids). */
  properties: readonly ExportPropertyValue[];
  /** Direct child ids in position order (via ctx.childrenOf; empty when the
   *  caller injects no children resolver). */
  children: readonly string[];
  edges: readonly JsonArchiveEdge[];
}

/** The versioned archive envelope. */
export interface JsonArchive {
  format: typeof JSON_ARCHIVE_FORMAT;
  version: typeof JSON_ARCHIVE_VERSION;
  generatedAt: string;
  nodes: JsonArchiveNode[];
}

/** Options accepted by {@link buildJsonArchive}. All optional. */
export interface JsonArchiveOptions {
  /** Clock injection (deterministic specs). Default: the current time. */
  now?: Date | string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestampOf(now: Date | string | undefined): string {
  if (now === undefined) return new Date().toISOString();
  return typeof now === "string" ? now : now.toISOString();
}

function collectValueNodeRefs(value: unknown, into: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectValueNodeRefs(entry, into);
    return;
  }
  if (isRecord(value)) {
    if (typeof value.nodeId === "string") into.push(value.nodeId);
    for (const entry of Object.values(value)) collectValueNodeRefs(entry, into);
  }
}

function edgesOf(node: ExportNode): JsonArchiveEdge[] {
  const edges: JsonArchiveEdge[] = [];
  const walk = (tokens: readonly ContentAst[number][]): void => {
    for (const token of tokens) {
      switch (token.type) {
        case "mention":
          edges.push({ kind: "mention", targetNodeId: token.targetNodeId });
          break;
        case "embed_ref":
          edges.push({ kind: "embed", targetNodeId: token.nodeId });
          break;
        case "class_chip":
          edges.push({ kind: "class", classId: token.classId });
          break;
        case "typed_link":
          edges.push(
            typeof token.verb === "string"
              ? { kind: "typedLink", verb: token.verb, schemaId: null }
              : { kind: "typedLink", verb: null, schemaId: token.verb.propertySchemaId },
          );
          break;
        case "asset_ref":
          edges.push({ kind: "asset", assetId: token.assetId });
          break;
        case "quote":
          walk(token.children);
          break;
        default:
          break;
      }
    }
  };
  walk(node.contentAst);
  for (const property of node.properties) {
    const refs: string[] = [];
    collectValueNodeRefs(property.value, refs);
    for (const targetNodeId of refs) {
      edges.push({ kind: "property", schemaId: property.schemaId, targetNodeId });
    }
  }
  return edges;
}

/**
 * Build the archive over the given node set. Nodes are emitted in caller
 * order (duplicates collapse to the first occurrence); `children` resolves
 * through the injected ctx's `childrenOf` — the ARCHIVE does not recurse:
 * the emitted node set IS the caller's slice, so a slice cut above a child
 * still records the child's id here without the child's record.
 */
export function buildJsonArchive(
  nodes: readonly ExportNode[],
  ctx: ExportContext,
  options?: JsonArchiveOptions,
): JsonArchive {
  const seen = new Set<string>();
  const out: JsonArchiveNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push({
      id: node.id,
      isClass: node.isClass === 1,
      presentAsMain: node.presentAsMain === 1,
      parentId: node.parentId,
      displayName: deriveDisplayName(node),
      contentAst: node.contentAst,
      classIds: node.classIds,
      properties: node.properties,
      children: ctx.childrenOf?.(node.id)?.map((child) => child.id) ?? [],
      edges: edgesOf(node),
    });
  }
  return {
    format: JSON_ARCHIVE_FORMAT,
    version: JSON_ARCHIVE_VERSION,
    generatedAt: timestampOf(options?.now),
    nodes: out,
  };
}

/** Pretty-printed archive document (2-space indent, trailing newline). */
export function renderJsonArchive(archive: JsonArchive): string {
  return `${JSON.stringify(archive, null, 2)}\n`;
}
