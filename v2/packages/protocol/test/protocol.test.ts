import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Clock,
  compareHlc,
  envelopeSchema,
  isSeedRelationSchemaId,
  KNOWN_OP_TYPES,
  newEnvelope,
  payloadSchemaFor,
  PROTOCOL_VERSION,
  RELATION_SCHEMA_SEEDS,
  relationSchemaByName,
} from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

interface FixtureFile {
  name: string;
  envelopes: Record<string, unknown>[];
}

function loadFixtures(): FixtureFile[] {
  return readdirSync(fixturesDir, { encoding: "utf8" })
    .filter((f) => f.endsWith(".json"))
    .map((name) => {
      const raw = JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as Record<
        string,
        unknown
      >;
      const envelopes = Array.isArray(raw.envelopes)
        ? (raw.envelopes as Record<string, unknown>[])
        : [raw];
      return { name, envelopes };
    });
}

describe("canonical fixtures (RELATIONS.md)", () => {
  const fixtures = loadFixtures();

  it("has the five required fixtures", () => {
    const names = fixtures.map((f) => f.name).sort();
    expect(names).toEqual([
      "envelope-minimal.json",
      "object-create.json",
      "relation-concurrent-create.json",
      "relation-create.json",
      "relation-delete.json",
    ]);
  });

  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      for (const [i, raw] of fixture.envelopes.entries()) {
        it(`envelope ${i} matches the v2 envelope schema`, () => {
          const parsed = envelopeSchema.safeParse(raw);
          expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
        });

        it(`envelope ${i} has a known opType and a valid payload`, () => {
          const opType = raw.opType as string;
          expect(KNOWN_OP_TYPES).toContain(opType);
          const schema = payloadSchemaFor(opType);
          expect(schema).toBeDefined();
          const parsed = schema!.safeParse(raw.payload);
          expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
        });

        if ((raw.opType as string).startsWith("relation.")) {
          it(`envelope ${i} references a seeded relation schema UUID`, () => {
            const schemaId = (raw.payload as Record<string, unknown>).relationSchemaId;
            if (schemaId !== undefined) {
              expect(isSeedRelationSchemaId(schemaId as string)).toBe(true);
            }
          });
        }
      }
    });
  }

  it("relation-create fixture cites the seeded 'cites' schema with a locator", () => {
    const fixture = fixtures.find((f) => f.name === "relation-create.json")!;
    const payload = fixture.envelopes[0]!.payload as Record<string, unknown>;
    const cites = relationSchemaByName("cites")!;
    expect(payload.relationSchemaId).toBe(cites.id);
    expect(payload.properties).toEqual({ locator: "p. 42" });
  });

  it("concurrent-create fixture races the same triple with distinct ids", () => {
    const fixture = fixtures.find((f) => f.name === "relation-concurrent-create.json")!;
    const [a, b] = fixture.envelopes;
    const pa = a!.payload as Record<string, unknown>;
    const pb = b!.payload as Record<string, unknown>;
    expect(pa.sourceId).toBe(pb.sourceId);
    expect(pa.relationSchemaId).toBe(pb.relationSchemaId);
    expect(pa.targetId).toBe(pb.targetId);
    expect(pa.relationId).not.toBe(pb.relationId);
  });
});

describe("seed relation schemas (RELATIONS.md §0)", () => {
  it("are ten, with unique fixed ids and names", () => {
    expect(RELATION_SCHEMA_SEEDS).toHaveLength(10);
    const ids = new Set(RELATION_SCHEMA_SEEDS.map((s) => s.id));
    const names = new Set(RELATION_SCHEMA_SEEDS.map((s) => s.name));
    expect(ids.size).toBe(10);
    expect(names.size).toBe(10);
  });

  it("live in the reserved 00000000-0000-0000-0004-… block", () => {
    for (const seed of RELATION_SCHEMA_SEEDS) {
      expect(seed.id).toMatch(/^00000000-0000-0000-0004-/);
    }
  });
});

describe("envelope v2", () => {
  it("rejects a missing protocolVersion", () => {
    const raw = {
      id: "0192a000-0000-7000-8000-0000000000ff",
      workspaceId: "0192a000-0000-7000-8000-000000000001",
      actorId: "0192a000-0000-7000-8000-000000000002",
      deviceId: "dev",
      hlc: { physical: 1, logical: 0 },
      affectedNodeIds: [],
      opType: "object.create",
      timestamp: "2026-09-24T12:00:00.000Z",
      payload: {},
    };
    expect(envelopeSchema.safeParse(raw).success).toBe(false);
  });

  it("accepts the M3 encryption slot without interpreting it", () => {
    const env = newEnvelope({
      workspaceId: "0192a000-0000-7000-8000-000000000001",
      actorId: "0192a000-0000-7000-8000-000000000002",
      deviceId: "dev",
      hlc: { physical: 1, logical: 0 },
      opType: "object.create",
      payload: { $e: { iv: "aa", ct: "bb" } },
    });
    expect(env.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(envelopeSchema.safeParse(env).success).toBe(true);
  });

  it("stamps uuidv7 ids and provenance claims", () => {
    const env = newEnvelope({
      workspaceId: "0192a000-0000-7000-8000-000000000001",
      actorId: "0192a000-0000-7000-8000-000000000002",
      deviceId: "laptop",
      client: "agent:scout",
      hlc: { physical: 1, logical: 0 },
      opType: "relation.create",
      payload: {},
    });
    expect(env.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.client).toBe("agent:scout");
    expect(env.deviceId).toBe("laptop");
  });
});

describe("HLC clock", () => {
  it("is monotonic within a device", () => {
    const clock = new Clock("dev");
    const a = clock.now(1000);
    const b = clock.now(1000);
    const c = clock.now(999);
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(b, c)).toBeLessThan(0);
  });

  it("merges received clocks without going backwards", () => {
    const clock = new Clock("dev");
    clock.now(1000);
    const merged = clock.update({ physical: 2000, logical: 5 }, 1500);
    expect(merged.physical).toBe(2000);
    expect(merged.logical).toBeGreaterThanOrEqual(6);
    const next = clock.now(2000);
    expect(compareHlc(next, merged)).toBeGreaterThan(0);
  });
});
