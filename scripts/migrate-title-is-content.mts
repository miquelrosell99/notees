/**
 * Title-is-content data migration (SCHEMA.md 2026-10-01): the node `name`
 * column is retired — a node's title IS its text content. This pass folds
 * every stored name into the node's content and normalizes page/class
 * content to the text-only invariant (rich inline tokens flatten to their
 * plain text; whiteboard/query structural widgets survive):
 *
 *  - name set, content empty            → content = [{ text token, name }]
 *  - name set, content non-empty        → name text PREPENDS the content
 *                                           (unless already the first text)
 *  - node_type page/class               → content stringified via the domain
 *                                           helper (same rule the appliers
 *                                           enforce going forward)
 *  - blocks                             → content kept verbatim (full token
 *                                           stream is legal for blocks)
 *
 * Writes go through appended object.update envelopes — the immutable log is
 * never edited; the corrective ops flow through the normal relay ingest so
 * every derived database and client converges. Idempotent: a second run
 * finds no names and already-normalized content, and writes nothing.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrate-title-is-content.mts \
 *     --data-dir ../../config/notees/sync --server http://127.0.0.1:8377
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { newEnvelope } from "../packages/protocol/src/index.ts";
import { stringifyContentAst } from "../packages/domain/src/node.ts";

import { AuthStorage } from "../apps/server/src/auth.ts";
import { RelayStorage } from "../apps/server/src/relay-storage.ts";
import { WorkspaceManager } from "../apps/server/src/workspace-store.ts";

const args = process.argv.slice(2);
const dataDir = args[args.indexOf("--data-dir") + 1] ?? "config/notees/sync";
const serverUrl = (args[args.indexOf("--server") + 1] ?? "http://127.0.0.1:8377").replace(/\/$/, "");
const apiKey = readFileSync(join(dataDir, "api_key.txt"), "utf8").trim();

const ACTOR = "01920000-0000-7000-8000-0000000000a3";

type Token = Record<string, unknown> & { type?: unknown };

/** The first text run of a token stream (top level only). */
function firstTextOf(tokens: Token[]): string {
  for (const token of tokens) {
    if (token.type === "text" && typeof token.text === "string") return token.text;
  }
  return "";
}

const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
const auth = new AuthStorage(join(dataDir, "relay.db"));
const workspaces = new WorkspaceManager(relay, join(dataDir, "derived"));

let migrated = 0;
let scanned = 0;

for (const workspaceId of auth.listAllWorkspaceIds()) {
  const store = workspaces.storeFor(workspaceId);
  const rows = store.database
    .prepare("SELECT id, node_type, name, content FROM node WHERE is_active = 1")
    .all() as Array<{ id: string; node_type: string; name: string | null; content: string }>;

  const envelopes = [];
  for (const row of rows) {
    scanned += 1;
    let ast: Token[];
    try {
      ast = JSON.parse(row.content) as Token[];
      if (!Array.isArray(ast)) continue;
    } catch {
      continue;
    }
    const name = row.name?.trim() ?? "";
    let next: Token[] | null = null;

    if (name !== "") {
      const alreadyFirst = firstTextOf(ast).trim() === name;
      if (ast.length === 0) {
        next = [{ type: "text", text: name }];
      } else if (!alreadyFirst) {
        next = [{ type: "text", text: name }, ...ast];
      }
    }
    if (row.node_type !== "block") {
      // Pages/classes: enforce the text-only invariant (same stringify the
      // appliers apply going forward).
      const normalized = stringifyContentAst((next ?? ast) as never) as Token[];
      if (JSON.stringify(normalized) !== JSON.stringify(next ?? ast)) next = normalized;
    }

    if (next === null) continue;
    if (JSON.stringify(next) === JSON.stringify(ast)) continue;
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: "title-is-content-migration",
        client: "migrate-title-is-content",
        hlc: { physical: Date.now(), logical: envelopes.length },
        affectedNodeIds: [row.id],
        opType: "object.update",
        payload: { objectId: row.id, contentAst: next },
      }),
    );
  }
  if (envelopes.length > 0) {
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
    migrated += envelopes.length;
    console.log(`${workspaceId.slice(0, 8)}: ${envelopes.length} node(s) migrated`);
  }
  store.close();
}

console.log(`done: ${migrated}/${scanned} nodes migrated.`);
auth.close();
relay.close();
