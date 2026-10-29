/**
 * The class displayTemplate branch of the title seam (one responsibility:
 * resolve a node's templated display name, or decline).
 *
 * A node whose class carries a displayTemplate (sources → "@{{citekey}}")
 * renders the RESOLVED template everywhere it is referenced; its own page
 * header opts out at the seam (`template: "off"`) and keeps the editable
 * content title — title-is-content stays the authority. Resolution rule:
 * for a NON-date, NON-class node, the FIRST class in `classIds` order whose
 * effective template resolves (the store's extends-aware
 * `resolveEffectiveDisplayTemplate`) wins; `{{schemaName}}` placeholders
 * flatten to the node's effective property value via `propertyDisplayText`
 * (multi values join ", ", node-refs resolve to titles through the same
 * seam), resolved by the DUAL-KEY rule: a placeholder matches a schema by
 * its DISPLAY name folded case-insensitively OR by the system wire key
 * aliased from the schema's manifest id (the seeds carry display names —
 * "Citekey" — while the shipped templates name wire keys — "{{citekey}}";
 * both spellings render, and the write-time validation offers the same two
 * keys). A placeholder whose property is unvalued renders ""; when the
 * fully-resolved string carries no word character after trimming (the "" /
 * "@" empty-result cases) the helper returns null and the caller falls
 * back to the content title — a blank template result never renders a
 * blank title.
 * Class nodes (a class has its own name) and date-chain nodes (date
 * formatting is frozen platform behavior) are NEVER templated.
 */

import { SYSTEM_PROPERTY_UUIDS, type NodeLike } from "@notees/domain";

import type { EffectiveProperty } from "../core/workspace-client/index.js";
import {
  propertyDisplayText,
  type PropertyDisplayClient,
} from "../features/collection/propertyDisplay.js";
import { isDatePageNode, type TitleClient } from "./dateDisplay.js";

/** The placeholder grammar (the domain's PLACEHOLDER_RE shape — authored
 *  templates are validated at write time, this is the render-side walk). */
const PLACEHOLDER_RENDER_RE = /\{\{([^{}]*)\}\}/g;

/**
 * The system schemas' wire keys by schema id — the reverse of
 * SYSTEM_PROPERTY_UUIDS. The dual-key rule (below) aliases "{{citekey}}"
 * to the schema whose DISPLAY name is "Citekey": the seeds author
 * property_schema rows with display names, while the shipped templates
 * name wire keys.
 */
const SYSTEM_WIRE_KEY_BY_SCHEMA_ID = new Map<string, string>(
  Object.entries(SYSTEM_PROPERTY_UUIDS).map(([key, id]) => [id, key]),
);

/**
 * Synchronous-recursion guard: a template placeholder may hold a node-typed
 * value that (pathologically) references the templated node itself — the
 * flatten re-enters this seam through `propertyDisplayText`'s titleOf. The
 * whole seam is synchronous, so one module-scoped active set with
 * add/delete suffices: a cycle folds to null (content title) at the loop
 * point instead of hanging the UI.
 */
const ACTIVE = new Set<string>();

/**
 * The resolved templated display name of `node`, or null when the node is
 * not templated (class/date node, no class with a resolving template, an
 * empty-after-trim resolution, or the client lacks the template reads).
 * Never returns a substance-free string — a resolution with no word
 * character declines so the caller's content-title fallback always has
 * something to show.
 */
export function templatedTitleOf(node: NodeLike, client: TitleClient): string | null {
  if (node.isClass === true || node.isClass === 1) return null;
  if (isDatePageNode({ id: node.id, name: node.name ?? null, classIds: node.classIds ?? [] })) {
    return null;
  }
  // Bound copies: TitleClient may be a class-based client (WorkspaceClient/
  // WorkerClient), where extracting the method loses `this` — and the
  // synthesized displayClient below must carry the SAME bindings so
  // propertyDisplayText's nested titleOf reads the real state.
  const resolveTemplate = client.resolveEffectiveDisplayTemplate?.bind(client);
  const propertiesOf = client.getEffectiveProperties?.bind(client);
  if (resolveTemplate === undefined || propertiesOf === undefined) return null;
  let template: string | null = null;
  for (const classId of node.classIds ?? []) {
    const resolved = resolveTemplate(classId);
    if (resolved !== null) {
      template = resolved;
      break;
    }
  }
  if (template === null) return null;
  if (ACTIVE.has(node.id)) return null;
  ACTIVE.add(node.id);
  try {
    // The placeholder index — the DUAL-KEY rule: a placeholder resolves
    // against (a) the schema's DISPLAY name, folded case-insensitively
    // ("Citekey" answers "{{citekey}}" and "{{Citekey}}" alike), and
    // (b) the system WIRE KEY aliased from the schema's manifest id
    // (schema …000023 answers "{{citekey}}"). The seeds author
    // property_schema rows with display names (apps/server/src/seed.ts
    // writes SYSTEM_PROPERTY_DISPLAY_NAMES) while the shipped templates
    // name wire keys — either spelling renders. First index wins per key;
    // the effective-properties read order is the deterministic precedence.
    const byName = new Map<string, EffectiveProperty>();
    const index = (key: string, prop: EffectiveProperty): void => {
      if (!byName.has(key)) byName.set(key, prop);
    };
    for (const prop of propertiesOf(node.id)) {
      const schema = prop.schema;
      if (schema === undefined || schema === null) continue;
      index(schema.name.toLowerCase(), prop);
      const wireKey = SYSTEM_WIRE_KEY_BY_SCHEMA_ID.get(schema.id);
      if (wireKey !== undefined) index(wireKey.toLowerCase(), prop);
    }
    const displayClient: PropertyDisplayClient = {
      getNode: client.getNode.bind(client),
      getDisplayName: client.getDisplayName.bind(client),
      ...(client.getNodeRaw !== undefined
        ? { getNodeRaw: client.getNodeRaw.bind(client) }
        : {}),
      ...(client.effectiveClassParentlessBlock !== undefined
        ? { effectiveClassParentlessBlock: client.effectiveClassParentlessBlock.bind(client) }
        : {}),
      ...(client.resolveEffectiveDisplayTemplate !== undefined
        ? { resolveEffectiveDisplayTemplate: client.resolveEffectiveDisplayTemplate.bind(client) }
        : {}),
      ...(client.getEffectiveProperties !== undefined
        ? { getEffectiveProperties: client.getEffectiveProperties.bind(client) }
        : {}),
      listPropertySchemas: client.listPropertySchemas?.bind(client) ?? (() => []),
    };
    const text = template.replace(PLACEHOLDER_RENDER_RE, (_match, raw: string) => {
      const name = raw.trim();
      if (name === "") return "";
      const prop = byName.get(name.toLowerCase());
      return prop === undefined ? "" : propertyDisplayText(displayClient, prop);
    });
    // Empty-result fallback: the plan's rule 3 — a template whose placeholders
    // all rendered nothing must fall back to the content title even when
    // literal punctuation survives ("@{{citekey}}" unvalued resolves to "@").
    // No word character after trimming = nothing of substance rendered.
    if (text.trim() === "" || !/\w/.test(text)) return null;
    return text;
  } finally {
    ACTIVE.delete(node.id);
  }
}

/**
 * The `titleOf` funnel's template-axis resolver: built from the client when
 * it carries the three template reads (the real WorkspaceClient/WorkerClient
 * do; bare TitleClient mocks without them simply don't template — the seam
 * degrades to the content title).
 */
export function displayTemplateResolver(
  client: TitleClient,
): ((node: NodeLike) => string | null) | undefined {
  if (
    client.resolveEffectiveDisplayTemplate === undefined ||
    client.getEffectiveProperties === undefined ||
    client.listPropertySchemas === undefined
  ) {
    return undefined;
  }
  return (node) => templatedTitleOf(node, client);
}
