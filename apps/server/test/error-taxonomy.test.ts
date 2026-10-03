/**
 * Error-code taxonomy pin (§34.33 AC2): the `ErrorCode` union in
 * src/errors.ts is the single source; this test fails on drift between
 *  - the taxonomy table (ERROR_TAXONOMY) and the codes route code actually
 *    throws or emits (`new AppError(status, "<code>"…)` /
 *    `errorBody(status, "<code>"…)` across src/), including the STATUS each
 *    call site uses, and
 *  - the OpenAPI exposure (`x-error-codes`).
 *
 * The AG5 additions (`scope_denied` from AG3 scoped keys, `idempotency_replay`
 * from the Idempotency-Key guard) are covered behaviorally in
 * developer-api.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ERROR_TAXONOMY, THROWN_ERROR_CODES, type ErrorCode } from "../src/errors.js";
import { buildOpenApiDocument } from "../src/openapi.js";
import { SERVER_VERSION } from "../src/index.js";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

interface Emission {
  code: string;
  status: number;
  file: string;
}

/** Scan src/ for the two emission idioms: new AppError(N, "code") / errorBody(N, "code"). */
function scanEmissions(): Emission[] {
  const emissions: Emission[] = [];
  const pattern = /(?:new AppError\(|errorBody\()\s*(\d{3})\s*,\s*"([a-z_]+)"/g;
  for (const file of readdirSync(SRC_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(SRC_DIR, file), "utf8");
    for (const match of source.matchAll(pattern)) {
      emissions.push({ status: Number(match[1]), code: match[2]!, file });
    }
  }
  return emissions;
}

describe("error taxonomy pin (AC2)", () => {
  it("every code emitted by route code is in the pinned taxonomy", () => {
    const emitted = scanEmissions();
    expect(emitted.length).toBeGreaterThan(0);
    for (const emission of emitted) {
      expect(
        Object.keys(ERROR_TAXONOMY),
        `${emission.file} emits unknown error code "${emission.code}"`,
      ).toContain(emission.code);
    }
  });

  it("every emission's HTTP status matches the taxonomy pin", () => {
    for (const emission of scanEmissions()) {
      const pinned = ERROR_TAXONOMY[emission.code as ErrorCode];
      expect(
        pinned,
        `${emission.file} emits unknown error code "${emission.code}"`,
      ).toBeDefined();
      const allowed = [pinned!.status, ...(pinned!.aliases ?? [])];
      expect(
        allowed,
        `${emission.file} emits "${emission.code}" with status ${emission.status}, taxonomy allows ${allowed.join("/")}`,
      ).toContain(emission.status);
    }
  });

  it("the taxonomy covers every thrown code; internal is the app.ts fallback only", () => {
    const emittedCodes = new Set(scanEmissions().map((emission) => emission.code));
    for (const code of Object.keys(ERROR_TAXONOMY)) {
      if (code === "internal") {
        // The only legitimate emitter is the global error handler fallback.
        const internalEmissions = scanEmissions().filter((emission) => emission.code === "internal");
        expect(internalEmissions.map((emission) => emission.file)).toEqual(["app.ts"]);
      } else {
        expect(
          emittedCodes.has(code),
          `taxonomy code "${code}" is never emitted — pin it or drop it`,
        ).toBe(true);
      }
    }
    expect(THROWN_ERROR_CODES).not.toContain("internal");
    expect(THROWN_ERROR_CODES.length).toBe(Object.keys(ERROR_TAXONOMY).length - 1);
  });

  it("the OpenAPI document exposes exactly the pinned taxonomy", () => {
    const document = buildOpenApiDocument(SERVER_VERSION);
    expect(document["x-error-codes"]).toEqual(
      Object.fromEntries(
        Object.entries(ERROR_TAXONOMY).map(([code, entry]) => [
          code,
          { status: entry.status, description: entry.description },
        ]),
      ),
    );
  });
});
