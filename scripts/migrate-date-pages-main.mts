/**
 * Ensure every journal date node (the year/month/day chain) carries
 * present_as_main = 1. Date pages are main nodes by definition — the chain
 * nests (year root → month under year → day under month), so without the
 * render bit a chain node renders as an inline block (and shows up in the
 * node picker's Blocks scope). v2's `ensureDateChain` has always authored
 * the bit, and the v1→v2 migration set it on migrated pages — but clients
 * that build the chain themselves (older GTK/Flutter builds) can leave a
 * parented chain node with the bit unset.
 *
 * For every active node whose id is one of the deterministic date shapes
 * (year `…00bb-YYYY00000000`, month `…00aa-YYYYMM000000`, day
 * `…00dd-YYYYMMDD0000`) with present_as_main = 0, append an
 * object.update {presentAsMain: true} envelope — the immutable log is never
 * edited; the corrective ops flow through the normal relay ingest so every
 * derived database and client converges.
 *
 * Idempotent: after a run, no date node has the bit unset.
 *
 * Usage (from the repo root, server reachable):
 *   pnpm --filter @notees/server exec tsx scripts/migrate-date-pages-main.mts \
 *     --data-dir config/notees/sync --server http://127.0.0.1:8377
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { newEnvelope } from "../packages/protocol/src/index.ts";

import { AuthStorage } from "../apps/server/src/auth.ts";
import { RelayStorage } from "../apps/server/src/relay-storage.ts";
import { WorkspaceManager } from "../apps/server/src/workspace-store.ts";

const args = process.argv.slice(2);
const dataDir = args[args.indexOf("--data-dir") + 1] ?? "config/notees/sync";
const serverUrl = (args[args.indexOf("--server") + 1] ?? "http://127.0.0.1:8377").replace(/\/$/, "");
const apiKey = readFileSync(join(dataDir, "api_key.txt"), "utf8").trim();

const DATE_NODE =
  "id LIKE '00000000-0000-0000-00bb-%' OR id LIKE '00000000-0000-0000-00aa-%' OR id LIKE '00000000-0000-0000-00dd-%'";
const ACTOR = "01920000-0000-7000-8000-0000000000a3";

const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
const auth = new AuthStorage(join(dataDir, "relay.db"));
const workspaces = new WorkspaceManager(relay, join(dataDir, "derived"));

let fixed = 0;
let scanned = 0;

for (const workspaceId of auth.listAllWorkspaceIds()) {
  const store = workspaces.storeFor(workspaceId);
  const rows = store.database
    .prepare(`SELECT id FROM node WHERE is_active = 1 AND present_as_main = 0 AND (${DATE_NODE})`)
    .all() as Array<{ id: string }>;

  const envelopes = [];
  for (const row of rows) {
    scanned += 1;
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: "date-pages-main-repair",
        client: "migrate-date-pages-main",
        hlc: { physical: Date.now(), logical: envelopes.length },
        affectedNodeIds: [row.id],
        opType: "object.update",
        payload: { objectId: row.id, presentAsMain: true },
      }),
    );
  }
  if (envelopes.length > 0) {
    // The relay caps a batch at 1000 envelopes; send in 500-envelope chunks.
    for (let offset = 0; offset < envelopes.length; offset += 500) {
      const chunk = envelopes.slice(offset, offset + 500);
      const response = await fetch(`${serverUrl}/api/relay/v2/batch`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ envelopes: chunk }),
      });
      if (!response.ok) {
        throw new Error(`batch ingest failed for ${workspaceId}: HTTP ${response.status} ${await response.text()}`);
      }
    }
    fixed += envelopes.length;
    console.log(`${workspaceId.slice(0, 8)}: ${envelopes.length} date node(s) re-flagged as main`);
  }
  store.close();
}

console.log(`done: ${fixed}/${scanned} date nodes fixed (rest already main).`);
auth.close();
relay.close();
