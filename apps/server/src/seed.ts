/**
 * Workspace seeding: emit the domain seed ops (class nodes, extends edges,
 * property schemas, inbox page) through the standard envelope
 * pipeline, reusing the fixed system UUIDs from @notees/domain. Idempotent:
 * seeding runs only while the workspace is completely empty, so a second
 * call is a no-op (seededCount 0).
 */

import {
  SEEDED_SYSTEM_CLASSES,
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_EXTRA_CLASS_BINDINGS,
  SYSTEM_PAGE_UUIDS,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
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
          // Title-is-content: the class's name is its (text-only) content.
          contentAst: [{ type: "text", text: name }],
          icon: SYSTEM_CLASS_ICONS[name],
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
  const bindingSequence = new Map<string, number>();
  for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
    if (spec === undefined) continue;
    const propertySchemaId = SYSTEM_PROPERTY_UUIDS[name as SystemPropertyName];
    // PG10: bindTo-less specs (the alias property) seed the schema at
    // global scope with NO class binding row.
    const scope = spec.bindTo === undefined ? "global" : "class";
    envelopes.push(
      factory.make({
        workspaceId,
        opType: "propertySchema.create",
        payload: {
          propertySchemaId,
          name,
          type: spec.type,
          multi: spec.multi ?? false,
          scope,
          ...(spec.options !== undefined ? { options: spec.options } : {}),
          ...(spec.targetClassFilter !== undefined
            ? { targetClassFilter: spec.targetClassFilter.map((c) => SYSTEM_CLASS_UUIDS[c]) }
            : {}),
        },
        client: "seed",
      }),
    );
    if (spec.bindTo === undefined) continue;
    // The binding is a configuration ROW (class.property.*), not just spec
    // metadata — effective-properties derives boundBy/defaults from rows.
    const classId = SYSTEM_CLASS_UUIDS[spec.bindTo];
    const sequence = bindingSequence.get(classId) ?? 0;
    bindingSequence.set(classId, sequence + 1);
    envelopes.push(
      factory.make({
        workspaceId,
        opType: "class.property.set",
        payload: {
          classId,
          propertySchemaId,
          sequence,
          ...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
        },
        affectedNodeIds: [classId],
        client: "seed",
      }),
    );
  }
  // The manifest's extra binding rows (SYSTEM_EXTRA_CLASS_BINDINGS): a schema
  // whose home is elsewhere gaining a second class (cover→source), and an
  // extends-child re-binding an inherited schema so class-local binding reads
  // (calendar quick-create eligibility) see it (eventDate→birthday). The web
  // self-heal authors the same rows idempotently — convergent either way.
  for (const extra of SYSTEM_EXTRA_CLASS_BINDINGS) {
    const classId = SYSTEM_CLASS_UUIDS[extra.bindTo];
    envelopes.push(
      factory.make({
        workspaceId,
        opType: "class.property.set",
        payload: {
          classId,
          propertySchemaId: SYSTEM_PROPERTY_UUIDS[extra.property],
          sequence: extra.sequence,
        },
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
        // render bit defaults are reproduced by the new appliers, so only an
        // explicit presentAsMain would be needed to deviate (parentless
        // pages default to the main zone by construction).
        payload: { objectId: pageId, presentAsMain: true, contentAst: [{ type: "text", text: name }] },
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
