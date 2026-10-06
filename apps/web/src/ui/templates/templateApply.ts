/**
 * Template apply orchestration — the thin client-composition
 * layer over the clone engine that every instantiation surface shares:
 * the slash flow, the TemplateGallery, and the Class View apply-to-existing
 * gesture. No new ops — everything composes the existing carriers through
 * the client's write surface (core/clone.ts).
 *
 * The client type is structural: the outliner seam (OutlinerClient &
 * OutlinerReader) satisfies it, and so do both full client classes. The
 * template family's idempotent self-heal is injected by the caller — the
 * slash flow passes the outliner context's `ensureTemplateFamily` seam, the
 * view-level surfaces pass `ensureTemplateFamily(client)` directly.
 */

import { instantiateTemplate, type CloneReadSurface, type CloneWriteSurface } from "@/core/clone.js";

import { generatedFromOf } from "../components/templateFamily.js";

/** Everything the apply helpers read + write (the outliner seam satisfies it). */
export type TemplateApplyClient = CloneReadSurface & CloneWriteSurface;

/**
 * Create-with-template: a fresh root-level page receives the template graft
 * (root content/classes/properties + cloned children in order) and records
 * generatedFrom provenance (the D1 amendment — instantiateTemplate's default).
 * The caller runs the family ensure first (see the module doc). Returns the
 * new node's id.
 */
export async function instantiateTemplateToNewPage(
  client: TemplateApplyClient,
  templateId: string,
  variables?: Record<string, string>,
): Promise<string> {
  const id = await client.createObject({ presentAsMain: true });
  await instantiateTemplate(
    { reads: client, writes: client },
    {
      templateRootId: templateId,
      objectId: id,
      ...(variables !== undefined ? { variables } : {}),
    },
  );
  return id;
}

/**
 * Apply-to-existing: graft the template
 * onto a node that already exists (typically one just assigned the
 * template-bearing class) and record generatedFrom provenance.
 *
 * Merge semantics: the generatedFrom marker IS the applied-template
 * marker — a node already generated from this template is skipped, so a
 * partial earlier apply is never re-applied (the naive-reapply duplication
 * the brief warns about). The generic duplicate gesture never reaches here
 * and never writes provenance.
 */
export async function applyTemplateToExistingNode(
  client: TemplateApplyClient,
  templateId: string,
  nodeId: string,
  variables?: Record<string, string>,
): Promise<"applied" | "already-applied"> {
  if (generatedFromOf(client, nodeId) === templateId) return "already-applied";
  // Prefill semantics (A4): never overwrite content the node already
  // carries — the graft adds structure (children/classes/properties)
  // alongside, the root content lands only on an empty body.
  const target = client.getNode(nodeId);
  const includeRootContent = target === undefined || target.contentAst.length === 0;
  await instantiateTemplate(
    { reads: client, writes: client },
    {
      templateRootId: templateId,
      objectId: nodeId,
      includeRootContent,
      ...(variables !== undefined ? { variables } : {}),
    },
  );
  return "applied";
}
