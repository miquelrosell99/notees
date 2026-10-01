/**
 * Repair mention tokens whose captured `text` is a raw uuid — the v1→v2
 * migrator wrote the link TARGET id as the text of unlabeled node_links
 * (scripts/migrate-v1/content_ast.py, fixed in the same commit as this
 * script). The uuid leaked into excerpts, breadcrumbs and search.
 *
 * For every active node whose content AST carries such a mention, rewrite
 * the captured text to the target's display name (stored name, else its
 * content excerpt, else "") via appended object.update envelopes — the
 * immutable log is never edited; the corrective ops flow through the normal
 * relay ingest so every derived database and client converges.
 *
 * Idempotent: after a run, no uuid-like mention text remains.
 *
 * Usage (from the repo root):
 *   pnpm --filter @notees/server exec tsx scripts/migrate-mention-texts.mjs \
 *     --data-dir config/notees/sync --server http://127.0.0.1:8377
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { newEnvelope } from "../packages/protocol/src/index.ts";
import { plainTextExcerpt } from "../packages/domain/src/node.ts";

import { AuthStorage } from "../apps/server/src/auth.ts";
import { RelayStorage } from "../apps/server/src/relay-storage.ts";
import { WorkspaceManager } from "../apps/server/src/workspace-store.ts";

const args = process.argv.slice(2);
const dataDir = args[args.indexOf("--data-dir") + 1] ?? "config/notees/sync";
const serverUrl = (args[args.indexOf("--server") + 1] ?? "http://127.0.0.1:8377").replace(/\/$/, "");
const apiKey = readFileSync(join(dataDir, "api_key.txt"), "utf8").trim();

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = "01920000-0000-7000-8000-0000000000a2";

type Token = Record<string, unknown> & { type?: unknown };

/** Rewrite uuid-captured mention texts in place; returns true when changed. */
function repairTokens(tokens: Token[], resolveName: (id: string) => string): boolean {
  let changed = false;
  for (const token of tokens) {
    if (token.type === "mention") {
      const text = typeof token.text === "string" ? token.text : "";
      const target = typeof token.targetNodeId === "string" ? token.targetNodeId : "";
      if (target !== "" && UUID_LIKE.test(text.trim())) {
        const resolved = resolveName(target);
        token.text = resolved;
        changed = true;
      }
    }
    if (Array.isArray(token.children)) {
      if (repairTokens(token.children as Token[], resolveName)) changed = true;
    }
  }
  return changed;
}

const relay = new RelayStorage(join(dataDir, "relay.db"), join(dataDir, "snapshots"));
const auth = new AuthStorage(join(dataDir, "relay.db"));
const workspaces = new WorkspaceManager(relay, join(dataDir, "derived"));

let repaired = 0;
let scanned = 0;

for (const workspaceId of auth.listAllWorkspaceIds()) {
  const store = workspaces.storeFor(workspaceId);
  const rows = store.database
    .prepare("SELECT id, name, content FROM node WHERE is_active = 1")
    .all() as Array<{ id: string; name: string | null; content: string }>;

  // First pass: name table for resolution (stored name, else content excerpt).
  const nameOf = new Map<string, string>();
  for (const row of rows) {
    let name = row.name !== null && row.name.trim() !== "" && !UUID_LIKE.test(row.name.trim()) ? row.name.trim() : "";
    if (name === "") {
      try {
        name = plainTextExcerpt(JSON.parse(row.content)) ?? "";
      } catch {
        name = "";
      }
    }
    nameOf.set(row.id, name);
  }

  const envelopes = [];
  for (const row of rows) {
    scanned += 1;
    if (!row.content.includes("mention")) continue;
    let ast: Token[];
    try {
      ast = JSON.parse(row.content) as Token[];
    } catch {
      continue;
    }
    if (!repairTokens(ast, (id) => nameOf.get(id) ?? "")) continue;
    envelopes.push(
      newEnvelope({
        workspaceId,
        actorId: ACTOR,
        deviceId: "mention-text-repair",
        client: "migrate-mention-texts",
        hlc: { physical: Date.now(), logical: envelopes.length },
        affectedNodeIds: [row.id],
        opType: "object.update",
        payload: { objectId: row.id, contentAst: ast },
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
    repaired += envelopes.length;
    console.log(`${workspaceId.slice(0, 8)}: ${envelopes.length} node(s) repaired`);
  }
  store.close();
}

console.log(`done: ${repaired}/${scanned} nodes repaired (rest already clean).`);
auth.close();
relay.close();
