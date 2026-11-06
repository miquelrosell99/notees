/**
 * verify-migration — the honest post-migration check (2026-11-02, the
 * apply-through-server + self-heal-sweep slice).
 *
 * For each workspace: reads the migration's envelopes from the relay log
 * (READ-ONLY — the log is exact about what was appended), then asks the
 * RUNNING SERVER through `GET /api/admin/convergence` whether those exact
 * envelope ids are applied to its derived store. Prints PASS/FAIL per
 * workspace; exit code 1 on any failure.
 *
 * WHY through the server: raw sqlite probes of `derived/*.db` LIE — a live
 * workspace store may be served from a snapshot-restore temp file with a
 * stub at the derived path, WAL state makes side reads racy, and a
 * fat-fingered UUID literal returns honest-looking nulls (all three burned
 * the 2026-11-02 pmid migration post-check; every layer had actually
 * converged). The convergence endpoint answers from the server's own
 * connection — the same read path every route serves from.
 *
 * The endpoint caps an `envelopeIds` param at 100 ids (a protective bound;
 * routes-admin.ts) — a bigger batch would have its tail silently dropped
 * (false "unapplied" FAILs) or the URL grow past the header limit (HTTP 431
 * on a 7k-id import batch). So the check PAGES: ≤100 ids per request, the
 * per-page `envelopes` maps merged before the accounting. Batches of ≤100
 * ids issue exactly one request, byte-identical to the unpaged shape.
 *
 * The report line carries the sealed boundary, never silent (the
 * mandatory-keying dev-ops contract): `sealed-invisible: S` counts the
 * encrypted payloads in the device's filtered set — a keyed workspace's
 * sealed tail is invisible to a keyless server BY DESIGN (the derived apply
 * skips sealed payloads), so those envelopes can never read "applied". S is
 * a REPORT, never a fail criterion: PASS stays "every filtered envelope
 * applied + pending === 0", exactly the set the check always covered.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/verify-migration.mts \
 *     --data-dir /etc/periphery/stacks/notees/config/notees/sync \
 *     [--workspace <uuid> | --all] --device migrate-pmid-property \
 *     [--server http://localhost:8377] [--api-key <operator key>]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { RelayStorage } from "../apps/server/src/relay-storage.ts";
import { isEncryptedPayload } from "../packages/protocol/src/envelope.ts";

interface CliOptions {
  dataDir: string;
  workspace: string;
  all: boolean;
  /** The migration's envelope deviceId — which batch to expect. */
  device: string;
  server: string;
  apiKey: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const device = value("--device");
  if (device === undefined) {
    throw new Error("--device <envelope deviceId> is required (the migration's DEVICE constant)");
  }
  return {
    dataDir: value("--data-dir") ?? "config/notees/sync",
    workspace: value("--workspace") ?? "3b30e070-039b-47bc-ad0d-2440a2f173c5",
    all: argv.includes("--all"),
    device,
    server: (value("--server") ?? "http://localhost:8377").replace(/\/$/, ""),
    apiKey: value("--api-key") ?? null,
  };
}

function operatorKeyOf(options: CliOptions): string {
  if (options.apiKey !== null) return options.apiKey;
  try {
    return readFileSync(join(options.dataDir, "api_key.txt"), "utf8").trim();
  } catch {
    throw new Error(
      "the operator key is needed: pass --api-key or keep api_key.txt beside --data-dir",
    );
  }
}

export interface ConvergenceResponse {
  hydrated: boolean;
  lastSeq: number;
  latestSeq: number;
  pending: number;
  appliedCount: number;
  envelopes: Record<string, boolean>;
}

/**
 * The server's per-request cap on `envelopeIds` (routes-admin.ts slices to
 * 100 — a protective bound against giant query strings). The client pages
 * below it.
 */
export const CONVERGENCE_ID_PAGE = 100;

/**
 * Split an envelope-id list into server-sized pages. An empty list yields
 * one empty page — the probe request still runs (it reads the handle
 * watermark, no envelopeIds param), matching the unpaged shape.
 */
export function pageEnvelopeIds(envelopeIds: string[], pageSize = CONVERGENCE_ID_PAGE): string[][] {
  const pages: string[][] = [];
  for (let offset = 0; offset < Math.max(envelopeIds.length, 1); offset += pageSize) {
    pages.push(envelopeIds.slice(offset, offset + pageSize));
  }
  return pages;
}

/**
 * Merge per-page convergence responses into one: the `envelopes` maps union
 * (ids never repeat across pages), the scalar fields come from the LAST
 * page — every page answers the same workspace handle, so hydrated /
 * lastSeq / latestSeq / pending are identical across pages and appliedCount
 * is the handle-wide stat, not a per-page sum. A single page passes through
 * unchanged.
 */
export function mergeConvergenceResponses(responses: ConvergenceResponse[]): ConvergenceResponse {
  const last = responses[responses.length - 1]!;
  const envelopes: Record<string, boolean> = {};
  for (const response of responses) {
    Object.assign(envelopes, response.envelopes);
  }
  return { ...last, envelopes };
}

async function convergencePage(
  options: CliOptions,
  workspaceId: string,
  envelopeIds: string[],
): Promise<ConvergenceResponse> {
  const params = new URLSearchParams({ workspaceId });
  if (envelopeIds.length > 0) params.set("envelopeIds", envelopeIds.join(","));
  const response = await fetch(`${options.server}/api/admin/convergence?${params.toString()}`, {
    headers: { "X-API-Key": operatorKeyOf(options) },
  });
  if (!response.ok) {
    throw new Error(
      `GET /api/admin/convergence answered ${response.status} for ${workspaceId}: ${await response.text()}`,
    );
  }
  return (await response.json()) as ConvergenceResponse;
}

async function convergenceOf(
  options: CliOptions,
  workspaceId: string,
  envelopeIds: string[],
): Promise<ConvergenceResponse> {
  const responses: ConvergenceResponse[] = [];
  for (const page of pageEnvelopeIds(envelopeIds)) {
    responses.push(await convergencePage(options, workspaceId, page));
  }
  return mergeConvergenceResponses(responses);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );

  let failures = 0;
  try {
    const workspaces = options.all ? relay.listWorkspaceIds() : [options.workspace];
    console.log(
      `verify-migration: device "${options.device}", ${workspaces.length} workspace(s), server ${options.server}`,
    );
    for (const workspaceId of workspaces) {
      const mine = relay
        .allEnvelopes(workspaceId)
        .filter((envelope) => envelope.deviceId === options.device);
      if (mine.length === 0) {
        console.log(`  ${workspaceId}: no "${options.device}" envelopes in the log — nothing to verify.`);
        continue;
      }
      const convergence = await convergenceOf(
        options,
        workspaceId,
        mine.map((envelope) => envelope.id),
      );
      const unapplied = mine.filter((envelope) => convergence.envelopes[envelope.id] !== true);
      // The sealed boundary (header ruling): encrypted payloads are invisible
      // to a keyless server by design — reported, never a fail criterion.
      const sealedInvisible = mine.filter((envelope) => isEncryptedPayload(envelope.payload)).length;
      const status = unapplied.length === 0 && convergence.pending === 0 ? "PASS" : "FAIL";
      if (status === "FAIL") failures += 1;
      console.log(
        `  ${status} ${workspaceId}: ${mine.length - unapplied.length}/${mine.length} envelopes ` +
          `applied (pending skips: ${convergence.pending}, sealed-invisible: ${sealedInvisible}, ` +
          `handle lastSeq ${convergence.lastSeq}/${convergence.latestSeq})` +
          (unapplied.length > 0 ? ` — unapplied: ${unapplied.map((e) => `${e.opType} ${e.id}`).join(", ")}` : ""),
      );
    }
    console.log(failures === 0 ? "\nVERIFY-MIGRATION-PASS" : `\nVERIFY-MIGRATION-FAIL (${failures} workspace(s))`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    relay.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
