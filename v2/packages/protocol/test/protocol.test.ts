import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Clock,
  compareHlc,
  contentAstSchema,
  envelopeSchema,
  extractTypedLinkMarks,
  KNOWN_OP_TYPES,
  newEnvelope,
  payloadSchemaFor,
  PROTOCOL_VERSION,
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

describe("canonical fixtures (SCHEMA.md / 00-INDEX gate)", () => {
  const fixtures = loadFixtures();

  it("has exactly the seven required fixtures", () => {
    const names = fixtures.map((f) => f.name).sort();
    expect(names).toEqual([
      "class-extends-cycle.json",
      "class-extends-m2m.json",
      "envelope-minimal.json",
      "object-create.json",
      "property-set-lww.json",
      "typed-link-mark-deleted.json",
      "typed-link-mark.json",
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
      }
    });
  }

  it("typed-link-mark carries a verb mark with locator and record-don't-resolve spans", () => {
    const fixture = fixtures.find((f) => f.name === "typed-link-mark.json")!;
    const payload = fixture.envelopes[0]!.payload as {
      contentAst: unknown;
    };
    const ast = contentAstSchema.parse(payload.contentAst);
    const marks = extractTypedLinkMarks(ast);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      verb: "cites",
      text: "cites",
      metadata: { locator: "p. 42", candidateSpans: ["tok_3", "tok_7"] },
    });
  });

  it("typed-link-mark-deleted removes the mark with its word (honest lifecycle)", () => {
    const fixture = fixtures.find((f) => f.name === "typed-link-mark-deleted.json")!;
    const payload = fixture.envelopes[0]!.payload as { contentAst: unknown };
    const ast = contentAstSchema.parse(payload.contentAst);
    expect(extractTypedLinkMarks(ast)).toHaveLength(0);
  });

  it("property-set-lww races the same slot; higher HLC is the LWW winner", () => {
    const fixture = fixtures.find((f) => f.name === "property-set-lww.json")!;
    const [a, b] = fixture.envelopes;
    const pa = a!.payload as { propertySchemaId: string; idx: number; value: { nodeId: string } };
    const pb = b!.payload as { propertySchemaId: string; idx: number; value: { nodeId: string } };
    expect(pa.propertySchemaId).toBe(pb.propertySchemaId);
    expect(pa.idx).toBe(pb.idx);
    expect(pa.value.nodeId).not.toBe(pb.value.nodeId);
    const hlcA = (a!.hlc as { physical: number; logical: number }) ?? { physical: 0, logical: 0 };
    const hlcB = (b!.hlc as { physical: number; logical: number }) ?? { physical: 0, logical: 0 };
    expect(compareHlc(hlcA, hlcB)).toBeLessThan(0);
  });

  it("no fixture payload carries a relation op or seeded relation vocabulary", () => {
    for (const fixture of fixtures) {
      for (const env of fixture.envelopes) {
        expect(String(env.opType)).not.toMatch(/^relation\./);
      }
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
      opType: "property.set",
      payload: {},
    });
    expect(env.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(env.client).toBe("agent:scout");
    expect(env.deviceId).toBe("laptop");
  });

  it("object.update rejects two simultaneous content carriers", () => {
    const schema = payloadSchemaFor("object.update")!;
    const parsed = schema.safeParse({
      objectId: "0192a000-0000-7000-8000-000000000010",
      contentAst: [],
      contentDeltaB64: "AA==",
    });
    expect(parsed.success).toBe(false);
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
