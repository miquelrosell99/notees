/**
 * Server workspace seeding: the `project` property seed (2026-10-28) rides
 * the generic SYSTEM_PROPERTY_SPECS loop — one `propertySchema.create` at
 * the reserved id (global scope, multi, the project target filter,
 * hideWhenEmpty) plus one unpinned `class.property.set` on the task class.
 *
 * Covers: the envelope shapes the seed authors, their replay through a
 * scratch derived store (the server seed is a plain envelope pipeline), and
 * the seed's emptiness gate — a second seedWorkspace call on a non-empty
 * workspace plans and writes nothing.
 */

import { describe, expect, it } from "vitest";

import { Clock, type Envelope } from "@notees/protocol";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { Store } from "../../../packages/store/src/index.ts";
import { betterSqlite3Backend } from "../../../packages/store/src/adapters/better-sqlite3.ts";

import { buildSeedEnvelopes, seedWorkspace } from "../src/seed.js";
import { EnvelopeFactory } from "../src/envelope-factory.js";

const WS = "0192a000-0000-7000-8000-0000000004d1";
const ACTOR = "0192a000-0000-7000-8000-0000000004d2";

function factory(): EnvelopeFactory {
  return new EnvelopeFactory(new Clock(ACTOR), ACTOR);
}

describe("buildSeedEnvelopes: the project property seed", () => {
  it("authors the project schema (global scope, multi, filter, hideWhenEmpty) + the unpinned task binding", () => {
    const envelopes = buildSeedEnvelopes(factory(), WS);

    const create = envelopes.find(
      (envelope) =>
        envelope.opType === "propertySchema.create" &&
        (envelope.payload as { propertySchemaId: string }).propertySchemaId ===
          SYSTEM_PROPERTY_UUIDS.project,
    );
    expect(create).toBeDefined();
    expect(create!.payload).toEqual({
      propertySchemaId: SYSTEM_PROPERTY_UUIDS.project,
      name: "Project",
      type: "object",
      multi: true,
      // global: true → NO scopeClassIds key (absent = global).
      targetClassFilter: [SYSTEM_CLASS_UUIDS.project],
      hideWhenEmpty: true,
    });

    const binding = envelopes.find(
      (envelope) =>
        envelope.opType === "class.property.set" &&
        (envelope.payload as { classId: string }).classId === SYSTEM_CLASS_UUIDS.task &&
        (envelope.payload as { propertySchemaId: string }).propertySchemaId ===
          SYSTEM_PROPERTY_UUIDS.project,
    );
    expect(binding).toBeDefined();
    // The binding carries NO pin (the 2026-10-27 pin ruling — the payload
    // lands bare: classId + propertySchemaId only).
    expect(binding!.payload).toEqual({
      classId: SYSTEM_CLASS_UUIDS.task,
      propertySchemaId: SYSTEM_PROPERTY_UUIDS.project,
    });
  });

  it("the seed envelopes replay clean through a scratch derived store (schema + binding rows present)", () => {
    const store = Store.open(betterSqlite3Backend(":memory:"));
    try {
      for (const envelope of buildSeedEnvelopes(factory(), WS)) {
        store.apply(envelope);
      }
      const schema = store.database
        .prepare("SELECT type, multi, scope_class_ids, hide_when_empty FROM property_schema WHERE id = ?")
        .get(SYSTEM_PROPERTY_UUIDS.project) as
        | { type: string; multi: number; scope_class_ids: string | null; hide_when_empty: number | null }
        | undefined;
      expect(schema).toEqual({
        type: "object",
        multi: 1,
        scope_class_ids: null,
        hide_when_empty: 1,
      });
      const bound = store.database
        .prepare(
          "SELECT 1 FROM class_property WHERE class_id = ? AND property_schema_id = ? AND pinned = 0",
        )
        .get(SYSTEM_CLASS_UUIDS.task, SYSTEM_PROPERTY_UUIDS.project);
      expect(bound).toBeDefined();
    } finally {
      store.close();
    }
  });
});

describe("buildSeedEnvelopes: the displayTemplate seed (citekey-centric)", () => {
  const OPT_OUTS = [
    "film",
    "tv_broadcast",
    "audio_recording",
    "radio_broadcast",
    "podcast",
    "video_recording",
    "book",
  ] as const;

  it("emits displayTemplate on class.create for `source` and the 7 opt-outs ONLY", () => {
    const envelopes = buildSeedEnvelopes(factory(), WS);
    const creates = envelopes.filter((envelope) => envelope.opType === "class.create");
    const payloadOf = (classId: string): Record<string, unknown> => {
      const envelope = creates.find(
        (candidate) => (candidate.payload as { classId: string }).classId === classId,
      );
      expect(envelope).toBeDefined();
      return envelope!.payload as Record<string, unknown>;
    };

    // `source` ships the citekey-centric header template; the seven
    // media-type classes opt OUT explicitly ("" — a real entry, not absence).
    expect(payloadOf(SYSTEM_CLASS_UUIDS.source).displayTemplate).toBe("@{{citekey}}");
    for (const name of OPT_OUTS) {
      expect(payloadOf(SYSTEM_CLASS_UUIDS[name]).displayTemplate, name).toBe("");
    }

    // Every other seeded class carries NO displayTemplate key at all —
    // absent = inherit through extends at read time.
    const flagged = new Set<string>([
      SYSTEM_CLASS_UUIDS.source,
      ...OPT_OUTS.map((name) => SYSTEM_CLASS_UUIDS[name]),
    ]);
    for (const envelope of creates) {
      const payload = envelope.payload as Record<string, unknown>;
      if (!flagged.has(payload.classId as string)) {
        expect(payload, payload.classId as string).not.toHaveProperty("displayTemplate");
      }
    }
  });

  it("replays clean: the class registry rows carry the template (`source`) and the explicit '' opt-out (`film`)", () => {
    const store = Store.open(betterSqlite3Backend(":memory:"));
    try {
      for (const envelope of buildSeedEnvelopes(factory(), WS)) {
        store.apply(envelope);
      }
      const templateOf = (classId: string): string | null | undefined =>
        (
          store.database
            .prepare("SELECT display_template FROM class WHERE id = ?")
            .get(classId) as { display_template: string | null } | undefined
        )?.display_template;
      expect(templateOf(SYSTEM_CLASS_UUIDS.source)).toBe("@{{citekey}}");
      expect(templateOf(SYSTEM_CLASS_UUIDS.film)).toBe("");
      // A non-manifest class stays NULL (inherits through extends at read).
      expect(templateOf(SYSTEM_CLASS_UUIDS.person)).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("seedWorkspace idempotency", () => {
  it("a second run on a non-empty workspace plans and writes nothing (seededCount 0)", async () => {
    let applied: Envelope[] = [];
    let empty = true;
    const deps = {
      factory: factory(),
      apply: async (_workspaceId: string, envelopes: Envelope[]) => {
        applied = envelopes;
        return { savedIds: envelopes.map((_, index) => `seed-${index}`) };
      },
      isEmpty: () => empty,
    };

    const first = await seedWorkspace(deps, WS);
    expect(first.seededCount).toBe(applied.length);
    expect(applied.length).toBeGreaterThan(0);

    empty = false;
    const second = await seedWorkspace(deps, WS);
    expect(second.seededCount).toBe(0);
  });
});
