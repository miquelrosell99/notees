/**
 * Migrate text-property carrier values from the legacy scalar-uuid shape to
 * the designed node-reference shape: property_value rows whose value is a
 * uuid STRING that resolves to a child BLOCK of the owner become
 * {"nodeId": <uuid>} via appended property.set ops — the immutable log is
 * never edited; the corrective ops flow through the normal relay ingest so
 * every derived database and client converges.
 *
 * Detection reads the server's derived DB (WAL, read-only queries); the
 * writes go through POST /api/relay/v2/batch with the operator key.
 * Idempotent: after a run, no scalar-uuid carrier rows remain.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx scripts/migrate-text-carriers.mjs \
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

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = "01920000-0000-7000-8000-0000000000a1";

const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
const auth = new AuthStorage(join(dataDir, "relay.db"));
const workspaces = new WorkspaceManager(relay, join(dataDir, "derived"));

let converted = 0;
let scanned = 0;

for (const workspaceId of auth.listAllWorkspaceIds()) {
  const store = workspaces.storeFor(workspaceId);
  const rows = store.database
    .prepare(
      `SELECT pv.node_id AS object_id, pv.property_schema_id AS schema_id, pv.idx AS idx, pv.value AS value
       FROM property_value pv`,
    )
    .all() as Array<{ object_id: string; schema_id: string; idx: number; value: string }>;
  const envelopes = [];
  for (const row of rows) {
    scanned += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (typeof parsed !== "string" || !UUID_LIKE.test(parsed)) continue;
    const target = store.database
      .prepare("SELECT node_type, parent_id FROM node WHERE id = ? AND is_active = 1")
      .get(parsed) as { node_type: string; parent_id: string | null } | undefined;
    // Only carrier blocks: a block that is a child of the property's owner.
    if (target === undefined || target.node_type !== "block") continue;
    if (target.parent_id !== row.object_id) continue;
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: "text-carrier-migration",
        client: "migrate-text-carriers",
        hlc: { physical: Date.now(), logical: envelopes.length },
        affectedNodeIds: [row.object_id],
        opType: "property.set",
        payload: {
          objectId: row.object_id,
          propertySchemaId: row.schema_id,
          value: { nodeId: parsed },
          idx: row.idx,
        },
      }),
    );
  }
  if (envelopes.length > 0) {
    const response = await fetch(`${serverUrl}/api/relay/v2/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ envelopes }),
    });
    if (!response.ok) {
      throw new Error(`batch ingest failed for ${workspaceId}: HTTP ${response.status} ${await response.text()}`);
    }
    converted += envelopes.length;
    console.log(`${workspaceId.slice(0, 8)}: ${envelopes.length} carrier value(s) migrated`);
  }
  store.close();
}

console.log(`done: ${converted}/${scanned} property values migrated (rest already node-shaped or scalar).`);
auth.close();
relay.close();
