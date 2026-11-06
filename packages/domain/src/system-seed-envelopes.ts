/**
 * Shared system-seed envelope builder: the platform-fixed op sequence and
 * payloads that seed a workspace's system classes, extends edges, property
 * schemas, binding rows, archival, and system pages. Both sides stamp with
 * their own factory — the server (keyless-workspace shim: deviceId
 * "notees-server", client "seed"), the web client (keyed workspaces:
 * client-side seeding through the E2EE boundary) — so the ONLY varying input
 * is the `stamp` callback; payloads are byte-identical everywhere.
 */

import type { Envelope } from "@notees/protocol";

import {
  SEEDED_SYSTEM_CLASSES,
  SYSTEM_ARCHIVED_BY_DEFAULT_CLASSES,
  SYSTEM_CLASS_DISPLAY_NAMES,
  SYSTEM_CLASS_DISPLAY_TEMPLATES,
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_ICONS,
  SYSTEM_CLASS_PARENTLESS_ROLE_BLOCK,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_EXTRA_CLASS_BINDINGS,
  SYSTEM_PAGE_UUIDS,
  SYSTEM_PROPERTY_DISPLAY_NAMES,
  SYSTEM_PROPERTY_SPECS,
  SYSTEM_PROPERTY_UUIDS,
  type SystemClassName,
  type SystemPropertyName,
} from "./seeds.js";
import {
  SYSTEM_SOURCE_CLASS_BINDINGS,
  sourceBindingPropertyOf,
} from "./source-class-bindings.js";

/**
 * Stamp one seed envelope with the caller's identity metadata (workspaceId,
 * actor, device, HLC clock, client claim). The builder supplies opType +
 * payload + affectedNodeIds only.
 */
export type SeedStamp = (
  opType: string,
  payload: Record<string, unknown>,
  affectedNodeIds?: string[],
) => Envelope;

/**
 * The system-seed op sequence for a workspace. Callers stamp each envelope
 * with their own factory; the payloads here are the contract (pinned
 * byte-identical by the server's parity fixture).
 */
export function buildSystemSeedEnvelopes(stamp: SeedStamp): Envelope[] {
  const envelopes: Envelope[] = [];
  for (const name of SEEDED_SYSTEM_CLASSES) {
    const classId = SYSTEM_CLASS_UUIDS[name];
    envelopes.push(
      stamp(
        "class.create",
        {
          classId,
          // Title-is-content: the class's name is its (text-only) content —
          // authored in NORMAL WORDING (SYSTEM_CLASS_DISPLAY_NAMES), not the
          // camelCase/snake_case seed key.
          contentAst: [{ type: "text", text: SYSTEM_CLASS_DISPLAY_NAMES[name] }],
          icon: SYSTEM_CLASS_ICONS[name],
          // The class-level parentlessRole render contract:
          // flagged classes' parentless members render Block-role. Absent on
          // every other class = the "page" default. Live workspaces converge
          // by the one-time Path A migration, not by re-seeding.
          ...(SYSTEM_CLASS_PARENTLESS_ROLE_BLOCK.has(name)
            ? { parentlessRole: "block" as const }
            : {}),
          // The class-level displayTemplate seed (the citekey-centric header
          // template on `source`, explicit "" opt-outs on the media roster):
          // emitted only where the manifest has an entry — "" IS a real
          // entry. Absent on every other class = inherit through extends at
          // read time. Live workspaces converge by the one-time migration,
          // not by re-seeding.
          ...(SYSTEM_CLASS_DISPLAY_TEMPLATES[name] !== undefined
            ? { displayTemplate: SYSTEM_CLASS_DISPLAY_TEMPLATES[name] }
            : {}),
        },
        [classId],
      ),
    );
  }
  for (const [child, parents] of Object.entries(SYSTEM_CLASS_EXTENDS)) {
    const classId = SYSTEM_CLASS_UUIDS[child as SystemClassName];
    envelopes.push(
      stamp(
        "class.setExtends",
        {
          classId,
          // One envelope per child: parentClassIds replaces the full set.
          parentClassIds: parents.map((parent) => SYSTEM_CLASS_UUIDS[parent]),
        },
        [classId],
      ),
    );
  }
  for (const [name, spec] of Object.entries(SYSTEM_PROPERTY_SPECS)) {
    if (spec === undefined) continue;
    const propertySchemaId = SYSTEM_PROPERTY_UUIDS[name as SystemPropertyName];
    // bindTo-less specs (the alias property) seed the schema at global scope
    // with NO class binding row; a bound spec is scoped to its class unless
    // the spec is marked `global` (the seed-scope audit: genuinely reusable
    // properties — the task family, the global url seed (bound to `source`
    // since) — are global; family-identity fields like citekey stay local).
    // A LIST-valued bindTo (the multi-class bind, 2026-11-06 — `repeat`) is
    // normalized here: the schema's scope is the UNION of the named classes
    // and the binding-row loop below lands one row per class. Single-class
    // specs normalize to a one-element list — byte-identical envelopes to
    // the historical single-bind shape.
    // The binding row below lands either way — bindings are per-class config.
    const classes =
      spec.bindTo === undefined ? [] : Array.isArray(spec.bindTo) ? spec.bindTo : [spec.bindTo];
    const scopeClassIds =
      classes.length === 0 || spec.global === true
        ? null
        : classes.map((c) => SYSTEM_CLASS_UUIDS[c]);
    envelopes.push(
      stamp(
        "propertySchema.create",
        {
          propertySchemaId,
          // Normal wording (SYSTEM_PROPERTY_DISPLAY_NAMES), not the raw key.
          name: SYSTEM_PROPERTY_DISPLAY_NAMES[name as SystemPropertyName],
          type: spec.type,
          multi: spec.multi ?? false,
          ...(scopeClassIds !== null ? { scopeClassIds } : {}),
          // The spec's default is SCHEMA-level (one
          // global default per property, the Logseq shape).
          ...(spec.defaultValue !== undefined ? { defaultValue: spec.defaultValue } : {}),
          ...(spec.options !== undefined ? { options: spec.options } : {}),
          ...(spec.targetClassFilter !== undefined
            ? { targetClassFilter: spec.targetClassFilter.map((c) => SYSTEM_CLASS_UUIDS[c]) }
            : {}),
          // The schema-level hide-when-empty render contract (additive
          // 2026-10-28, the `project` seed — the first seed to carry it).
          ...(spec.hideWhenEmpty !== undefined ? { hideWhenEmpty: spec.hideWhenEmpty } : {}),
        },
      ),
    );
    if (spec.bindTo === undefined || spec.bind === false) continue;
    // `bind: false`: the schema seeds scoped to
    // `bindTo` above but NO binding row lands on it — the source pool's
    // type-specific fields render bound only via their own class's
    // SYSTEM_SOURCE_CLASS_BINDINGS rows; the source base keeps its rows.
    // The binding is a configuration ROW (class.property.*) carrying the
    // genuinely per-class mechanics ONLY — the active soft-unbind flag and
    // the pinned tier flag (a classification, never a stored order;
    // sequence retired 2026-10-21: effective-properties derives boundBy
    // from rows; panels sort in pin tiers; the default rides the schema).
    // The spec's pinned flag rides verbatim — the seed pin sets slice
    // (2026-10-27) declared the pinned roster in the domain manifests.
    // One row per normalized bound class (the multi-class bind lands a row
    // on every class in the union).
    for (const cls of classes) {
      const classId = SYSTEM_CLASS_UUIDS[cls];
      envelopes.push(
        stamp(
          "class.property.set",
          {
            classId,
            propertySchemaId,
            ...(spec.pinned !== undefined ? { pinned: spec.pinned } : {}),
          },
          [classId],
        ),
      );
    }
  }
  // The manifest's extra binding rows (SYSTEM_EXTRA_CLASS_BINDINGS): an
  // extends-child re-binding an inherited schema so class-local binding reads
  // (calendar quick-create eligibility) see it (eventDate→birthday). The web
  // self-heal authors the same rows idempotently — convergent either way.
  // (The cover→source row was removed 2026-10-05 — a cover
  // makes no sense on sources.)
  for (const extra of SYSTEM_EXTRA_CLASS_BINDINGS) {
    const classId = SYSTEM_CLASS_UUIDS[extra.bindTo];
    envelopes.push(
      stamp(
        "class.property.set",
        {
          classId,
          propertySchemaId: SYSTEM_PROPERTY_UUIDS[extra.property],
          ...(extra.pinned !== undefined ? { pinned: extra.pinned } : {}),
        },
        [classId],
      ),
    );
  }
  // The source library's per-class binding rows (SYSTEM_SOURCE_CLASS_BINDINGS,
  // slice 1 task 6): each source type-class re-binds its
  // Zotero field list — the pool schemas ride the source base via the SPECS
  // loop above (every pool spec is scoped to source), so the rows are
  // extends-eligible on every family member. The web self-heal
  // (deploySystemClass) authors the same rows idempotently — convergent
  // either way.
  for (const [name, properties] of Object.entries(SYSTEM_SOURCE_CLASS_BINDINGS)) {
    const classId = SYSTEM_CLASS_UUIDS[name as SystemClassName];
    for (const ref of properties) {
      const property = sourceBindingPropertyOf(ref);
      const pinned = typeof ref === "string" ? undefined : ref.pinned;
      envelopes.push(
        stamp(
          "class.property.set",
          {
            classId,
            propertySchemaId: SYSTEM_PROPERTY_UUIDS[property],
            ...(pinned !== undefined ? { pinned } : {}),
          },
          [classId],
        ),
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
      stamp(
        "object.update",
        { objectId: classId, active: false },
        [classId],
      ),
    );
  }
  for (const [name, pageId] of Object.entries(SYSTEM_PAGE_UUIDS)) {
    envelopes.push(
      stamp(
        "object.create",
        // Title-is-content: the system page's name is its text content; the
        // embedding-flag defaults are reproduced by the new appliers, so only
        // an explicit isEmbedded would be needed to deviate (parentless
        // pages are standalone by construction).
        { objectId: pageId, isEmbedded: false, contentAst: [{ type: "text", text: name }] },
        [pageId],
      ),
    );
  }
  return envelopes;
}
