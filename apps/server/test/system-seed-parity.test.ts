/**
 * System-seed parity gate: the shared `@notees/domain` builder must produce
 * the EXACT op sequence + payloads the server-only builder produced before
 * the move (captured in fixtures/system-seed-captured.json — op metadata
 * stripped, so the comparison is over opTypes, payloads, and affected ids
 * only; both sides stamp envelope metadata with their own factory). Server
 * seed payloads must not change at all — only where the loop lives.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { Clock } from "@notees/protocol";
import { buildSystemSeedEnvelopes } from "@notees/domain";

import { EnvelopeFactory } from "../src/envelope-factory.js";

interface CapturedOp {
  opType: string;
  payload: unknown;
  affectedNodeIds: string[];
}

const captured = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "system-seed-captured.json"),
    "utf8",
  ),
) as { workspaceId: string; ops: CapturedOp[] };

describe("buildSystemSeedEnvelopes parity", () => {
  it("reproduces the captured server-seed op sequence and payloads exactly", () => {
    const factory = new EnvelopeFactory(
      new Clock("parity-device"),
      "0192a000-0000-7000-8000-0000000000d1",
    );
    const stamp = (opType: string, payload: Record<string, unknown>, affectedNodeIds?: string[]) =>
      factory.make({
        workspaceId: captured.workspaceId,
        opType,
        payload,
        ...(affectedNodeIds !== undefined ? { affectedNodeIds } : {}),
        client: "seed",
      });

    const envelopes = buildSystemSeedEnvelopes(stamp);

    expect(envelopes).toHaveLength(captured.ops.length);
    for (const [i, envelope] of envelopes.entries()) {
      const expected = captured.ops[i]!;
      expect(envelope.opType, `op ${i} opType`).toBe(expected.opType);
      expect(envelope.payload, `op ${i} (${expected.opType}) payload`).toEqual(expected.payload);
      expect(envelope.affectedNodeIds, `op ${i} affectedNodeIds`).toEqual(expected.affectedNodeIds);
    }
    expect(envelopes.map((e) => e.opType)).toEqual(captured.ops.map((o) => o.opType));
  });
});
