/**
 * verify-migration paging (scripts/verify-migration.mts).
 *
 * `GET /api/admin/convergence` caps the `envelopeIds` param at 100 ids (a
 * protective bound in routes-admin.ts). verify-migration sends a whole
 * migration batch as ONE comma-joined param, so pre-fix any batch >100 ids
 * had its tail silently dropped (false "unapplied" FAILs — a live 102-id
 * batch reported 100/102) and very large batches (a 7k-id import) outgrew
 * the URL entirely (HTTP 431). The fix is client-side paging: chunk the id
 * list into ≤100-id pages, one request per page, merge the per-page
 * `envelopes` maps before the applied/unapplied accounting.
 *
 * Pins:
 *  - the pure helpers: pageEnvelopeIds splits 250 into 100/100/50 (and keeps
 *    ≤100 as ONE page, the byte-identical request shape), an empty list still
 *    yields one watermark probe; mergeConvergenceResponses unions the maps
 *    and takes the scalar fields from the last page (never a sum);
 *  - the end-to-end shape in the migrate-* harness style: a scratch relay
 *    ingests a 250-envelope single-device batch, the real sync server opens
 *    the workspace (restores + applies), and the spawned script must report
 *    250/250 applied + VERIFY-MIGRATION-PASS — pre-fix the capped endpoint
 *    would have answered the tail 150 as unapplied and the run FAILed.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newEnvelope, type Envelope } from "@notees/protocol";

import { buildServer, type BuiltServer } from "../src/index.js";
import { RelayStorage } from "../src/relay-storage.ts";
import { makeConfig, TEST_API_KEY } from "./helpers";

import {
  CONVERGENCE_ID_PAGE,
  mergeConvergenceResponses,
  pageEnvelopeIds,
  type ConvergenceResponse,
} from "../../../scripts/verify-migration.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TSX = join(REPO_ROOT, "apps", "server", "node_modules", ".bin", "tsx");
const SCRIPT = "../../scripts/verify-migration.mts";

const WORKSPACE = "4b7d1a00-4444-4000-8000-000000000005";
const ACTOR = "51000000-0000-4000-8000-0000000000a1";
const DEVICE = "verify-migration-fixture";

const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `01930000-0000-7000-8000-${String(index).padStart(12, "0")}`);

describe("pageEnvelopeIds", () => {
  it("splits 250 ids into 100/100/50", () => {
    const pages = pageEnvelopeIds(ids(250));
    expect(pages.map((page) => page.length)).toEqual([100, 100, 50]);
    expect(pages.flat()).toEqual(ids(250));
    // No id is repeated or dropped across pages.
    expect(new Set(pages.flat()).size).toBe(250);
  });

  it("keeps ≤100 ids in ONE page — the byte-identical unpaged request shape", () => {
    expect(pageEnvelopeIds(ids(100))).toEqual([ids(100)]);
    expect(pageEnvelopeIds(ids(99))).toEqual([ids(99)]);
  });

  it("yields ONE empty page for an empty list (the watermark probe still runs)", () => {
    expect(pageEnvelopeIds([])).toEqual([[]]);
  });

  it("honours the server's 100-id cap as the default page size", () => {
    expect(CONVERGENCE_ID_PAGE).toBe(100);
    expect(pageEnvelopeIds(ids(101)).map((page) => page.length)).toEqual([100, 1]);
  });
});

describe("mergeConvergenceResponses", () => {
  const page = (envelopes: Record<string, boolean>, lastSeq: number): ConvergenceResponse => ({
    hydrated: true,
    lastSeq,
    latestSeq: 250,
    pending: 0,
    appliedCount: 250,
    envelopes,
  });

  it("unions the envelope maps and takes the scalar fields from the last page", () => {
    const a = ids(100);
    const b = ids(250).slice(100);
    const merged = mergeConvergenceResponses([
      page(Object.fromEntries(a.map((id) => [id, true])), 100),
      page(Object.fromEntries(b.map((id) => [id, true])), 250),
    ]);
    expect(Object.keys(merged.envelopes)).toHaveLength(250);
    for (const id of ids(250)) expect(merged.envelopes[id]).toBe(true);
    expect(merged.lastSeq).toBe(250);
    expect(merged.latestSeq).toBe(250);
    expect(merged.pending).toBe(0);
  });

  it("never sums the handle-wide appliedCount across pages", () => {
    const merged = mergeConvergenceResponses([page({}, 100), page({}, 250)]);
    expect(merged.appliedCount).toBe(250);
  });

  it("passes a single page through unchanged (the ≤100-id common case)", () => {
    const only = page({ "id-1": true }, 42);
    expect(mergeConvergenceResponses([only])).toEqual(only);
  });
});

/** The fixture batch: `count` single-device envelopes every replica applies. */
function fixtureBatch(count: number): Envelope[] {
  const physical = Date.now();
  return ids(count).map((objectId, index) =>
    newEnvelope({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      deviceId: DEVICE,
      client: "verify-migration-test",
      hlc: { physical: physical + index, logical: 0 },
      affectedNodeIds: [objectId],
      opType: "object.create",
      payload: { objectId, isEmbedded: false, contentAst: [{ type: "text", text: `Node ${index}` }] },
    }),
  );
}

interface CliResult {
  stdout: string;
  status: number;
}

const execFileAsync = promisify(execFile);

/**
 * Spawn the verification script exactly as the runbook documents. ASYNC on
 * purpose: the sync variant would block this process's event loop, and the
 * server under test lives IN this process — the script's fetch would never
 * be served (the migrate-* tests can afford execFileSync; this one cannot).
 */
async function runScript(args: string[]): Promise<CliResult> {
  try {
    const { stdout } = await execFileAsync(TSX, [SCRIPT, ...args], {
      cwd: join(REPO_ROOT, "apps", "server"),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      stdout: `${failed.stdout ?? ""}${failed.stderr ?? ""}`,
      status: failed.code ?? 1,
    };
  }
}

describe("verify-migration.mts end-to-end (the migrate-* harness shape)", () => {
  let dataDir: string;
  let server: BuiltServer;
  let port: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "notees-verify-migration-test-"));
    // The migration batch lives in the relay BEFORE the server starts (the
    // Path A script idiom — the log is exact about what was appended).
    const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
    try {
      relay.ingest(fixtureBatch(250));
    } finally {
      relay.close();
    }
    server = await buildServer(makeConfig(dataDir), { logger: false });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server.app.server.address();
    if (typeof address !== "object" || address === null) throw new Error("no server address");
    port = address.port;
  });

  afterEach(async () => {
    await server.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("a fully-applied 250-envelope batch reports 250/250 PASS — pre-fix the capped tail 150 read unapplied", async () => {
    const result = await runScript([
      "--data-dir",
      dataDir,
      "--workspace",
      WORKSPACE,
      "--device",
      DEVICE,
      "--server",
      `http://127.0.0.1:${port}`,
      "--api-key",
      TEST_API_KEY,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("250/250 envelopes applied");
    expect(result.stdout).toContain("VERIFY-MIGRATION-PASS");
    expect(result.stdout).not.toContain("unapplied:");
  });
});
