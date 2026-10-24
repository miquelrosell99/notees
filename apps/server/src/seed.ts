/**
 * Workspace seeding: emit the domain seed ops (class nodes, extends edges,
 * property schemas, inbox page) through the standard envelope
 * pipeline, reusing the fixed system UUIDs from @notees/domain. Idempotent:
 * seeding runs only while the workspace is completely empty, so a second
 * call is a no-op (seededCount 0).
 */

import {
  SEEDED_SYSTEM_CLASSES,
  SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES,
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_PARENTLESS_ROLE_BLOCK,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_EXTRA_CLASS_BINDINGS,
  SYSTEM_PAGE_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  SYSTEM_SOURCE_CLASS_BINDINGS,
  type SystemClassName,
  type SystemPropertyName,
} from "@notees/domain";
import type { Envelope } from "@notees/protocol";

import type { EnvelopeFactory } from "./envelope-factory.js";

export function buildSeedEnvelopes(factory: EnvelopeFactory, workspaceId: string): Envelope[] {
  const envelopes: Envelope[] = [];
  for (const name of SEEDED_SYSTEM_CLASSES) {
    const classId = SYSTEM_CLASS_UUIDS[name];
    envelopes.push(
      factory.make({
        workspaceId,
        opType: "class.create",
        payload: {
          classId,
          // Title-is-content: the class's name is its (text-only) content —
          // authored in NORMAL WORDING (SYSTEM_CLASS_DISPLAY_NAMES), not the
          // camelCase/snake_case seed key.
          contentAst: [{ type: "text", text: SYSTEM_CLASS_DISPLAY_NAMES[name] }],
          icon: SYSTEM_CLASS_ICONS[name],
          // The class-level parentlessRole render contract (owner 2026-10-24):
          // flagged classes' parentless members render Block-role. Absent on
          // every other class = the "page" default. Live workspaces converge
          // by the one-time Path A migration, not by re-seeding.
          ...(SYSTEM_CLASS_PARENTLESS_ROLE_BLOCK.has(name)
            ? { parentlessRole: "block" as const }
            : {}),
        },
        affectedNodeIds: [classId],
        client: "seed",
      }),
    );
  }
  for (const [child, parents] of Object.entries(SYSTEM_CLASS_EXTENDS)) {
    const classId = SYSTEM_CLASS_UUIDS[child as SystemClassName];
    envelopes.push(
      factory.make({
        workspaceId,
        opType: "class.setExtends",
        payload: {
          classId,
          // One envelope per child: parentClassIds replaces the full set.
          parentClassIds: parents.map((parent) => SYSTEM_CLASS_UUIDS[parent]),
        },
        affectedNodeIds: [classId],
        client: "seed",
      }),
    );
  }
  for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
    if (spec === undefined) continue;
    const propertySchemaId = SYSTEM_PROPERTY_UUIDS[name as SystemPropertyName];
    // bindTo-less specs (the alias property) seed the schema at global scope
    // with NO class binding row; a bound spec is scoped to its class unless
    // the spec is marked `global` (owner ruling 2026-10-20, the seed-scope
    // audit: genuinely reusable properties — the task family, the global url
    // seed (bound to `source` since owner 2026-10-22) — are global;
    // family-identity fields like citekey stay local). The
    // binding row below lands either way — bindings are per-class config.
    const scopeClassIds =
      spec.bindTo === undefined || spec.global === true
        ? null
        : [SYSTEM_CLASS_UUIDS[spec.bindTo]];
    envelopes.push(
      factory.make({
        workspaceId,
        opType: "propertySchema.create",
        payload: {
          propertySchemaId,
          // Normal wording (SYSTEM_PROPERTY_DISPLAY_NAMES), not the raw key.
          name: SYSTEM_PROPERTY_DISPLAY_NAMES[name as SystemPropertyName],
          type: spec.type,
          multi: spec.multi ?? false,
          ...(scopeClassIds !== null ? { scopeClassIds } : {}),
          // The spec's default is SCHEMA-level (owner ruling 2026-10-20 — one
          // global default per property, the Logseq shape).
          ...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
          ...(spec.options !== undefined ? { options: spec.options } : {}),
          ...(spec.targetClassFilter !== undefined
            ? { targetClassFilter: spec.targetClassFilter.map((c) => SYSTEM_CLASS_UUIDS[c]) }
            : {}),
        },
        client: "seed",
      }),
    );
    if (spec.bindTo === undefined || spec.bind === false) continue;
    // `bind: false` (owner ruling 2026-10-24): the schema seeds scoped to
    // `bindTo` above but NO binding row lands on it — the source pool's
    // type-specific fields render bound only via their own class's
    // SYSTEM_SOURCE_CLASS_BINDINGS rows; the source base keeps its rows.
    // The binding is a configuration ROW (class.property.*) carrying the
    // genuinely per-class mechanic ONLY — the active soft-unbind flag
    // (sequence retired 2026-10-21: effective-properties derives boundBy
    // from rows; panels sort alphabetically; the default rides the schema).
    const classId = SYSTEM_CLASS_UUIDS[spec.bindTo];
    envelopes.push(
      factory.make({
        workspaceId,
        opType: "class.property.set",
        payload: {
          classId,
          propertySchemaId,
        },
        affectedNodeIds: [classId],
        client: "seed",
      }),
    );
  }
  // The manifest's extra binding rows (SYSTEM_EXTRA_CLASS_BINDINGS): an
  // extends-child re-binding an inherited schema so class-local binding reads
  // (calendar quick-create eligibility) see it (eventDate→birthday). The web
  // self-heal authors the same rows idempotently — convergent either way.
  // (The cover→source row was removed 2026-10-05 — owner ruling: a cover
  // makes no sense on sources.)
  for (const extra of SYSTEM_EXTRA_CLASS_BINDINGS) {
    const classId = SYSTEM_CLASS_UUIDS[extra.bindTo];
    envelopes.push(
      factory.make({
        workspaceId,
        opType: "class.property.set",
        payload: {
          classId,
          propertySchemaId: SYSTEM_PROPERTY_UUIDS[extra.property],
        },
        affectedNodeIds: [classId],
        client: "seed",
      }),
    );
  }
  // The source library's per-class binding rows (SYSTEM_SOURCE_CLASS_BINDINGS,
  // owner 2026-10-23 slice 1 task 6): each source type-class re-binds its
  // Zotero field list — the pool schemas ride the source base via the SPECS
  // loop above (every pool spec is scoped to source), so the rows are
  // extends-eligible on every family member. The web self-heal
  // (deploySystemClass) authors the same rows idempotently — convergent
  // either way.
  for (const [name, properties] of Object.entries(SYSTEM_SOURCE_CLASS_BINDINGS)) {
    const classId = SYSTEM_CLASS_UUIDS[name as SystemClassName];
    for (const property of properties) {
      envelopes.push(
        factory.make({
          workspaceId,
          opType: "class.property.set",
          payload: {
            classId,
            propertySchemaId: SYSTEM_PROPERTY_UUIDS[property],
          },
          affectedNodeIds: [classId],
          client: "seed",
        }),
      );
    }
  }
  // Archived-by-default seeding (SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES): the
  // long-tail source types land with `active = false` — a VISIBILITY state,
  // not an absence (they still resolve through extends for queries, export,
  // and backlinks). Archival rides object.update (the wire's archival op;
  // class.create carries no active field) AFTER the rows exist; the
  // gallery/ensure enable path un-archives with object.update {active: true}.
  for (const name of SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES) {
    const classId = SYSTEM_CLASS_UUIDS[name];
    envelopes.push(
      factory.make({
        workspaceId,
        opType: "object.update",
        payload: { objectId: classId, active: false },
        affectedNodeIds: [classId],
        client: "seed",
      }),
    );
  }
  for (const [name, pageId] of Object.entries(SYSTEM_PAGE_UUIDS)) {
    envelopes.push(
      factory.make({
        workspaceId,
        opType: "object.create",
        // Title-is-content: the system page's name is its text content; the
        // embedding-flag defaults are reproduced by the new appliers, so only
        // an explicit isEmbedded would be needed to deviate (parentless
        // pages are standalone by construction).
        payload: { objectId: pageId, isEmbedded: false, contentAst: [{ type: "text", text: name }] },
        affectedNodeIds: [pageId],
        client: "seed",
      }),
    );
  }
  return envelopes;
}

export interface SeedResult {
  seededCount: number;
}

/**
 * Seed a workspace when it is completely empty (no log rows, no nodes).
 * Callers serialize first-boot seeding per process.
 */
export async function seedWorkspace(
  deps: {
    factory: EnvelopeFactory;
    apply: (workspaceId: string, envelopes: Envelope[]) => Promise<{ savedIds: string[] }>;
    isEmpty: (workspaceId: string) => boolean;
  },
  workspaceId: string,
): Promise<SeedResult> {
  if (!deps.isEmpty(workspaceId)) {
    return { seededCount: 0 };
  }
  const envelopes = buildSeedEnvelopes(deps.factory, workspaceId);
  const { savedIds } = await deps.apply(workspaceId, envelopes);
  return { seededCount: savedIds.length };
}
