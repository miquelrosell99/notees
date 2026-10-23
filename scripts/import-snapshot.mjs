/**
 * Import a snapshot image into a Notees sync server — installs a serialized
 * @notees/store database (a workspace image, e.g. produced by
 * POST /api/workspaces/:id/clone's source side or a store export) as a
 * workspace's derived store, rewriting every workspace_id row. The target
 * must be ENVELOPE-EMPTY: an imported workspace's log starts empty and the
 * installed snapshot is load-bearing for rebuilds (a derived wipe rehydrates
 * from the snapshot, not the log).
 *
 * Usage (from the repo root):
 *
 *   node scripts/import-snapshot.mjs <image-file> \
 *     [--name <ws-name>] [--workspace <existing-empty-ws-id>] \
 *     [--server <url>] [--key-file <path>]
 *
 * Credentials, in order:
 *   1. Creating a workspace needs an ACCOUNT SESSION: NOTEES_ADMIN_EMAIL +
 *      NOTEES_ADMIN_PASSWORD, or NOTEES_ADMIN_PASSWORD_FILE pointing at a
 *      file containing the password (the measure-probe idiom).
 *   2. The relay PUT authenticates with the operator API key — the probe
 *      convention default <repo>/config/notees/sync/api_key.txt, overridden
 *      with --key-file — falling back to the session Bearer.
 *
 * Env: NOTEES_API (server base URL, default http://localhost:8377).
 * Prints the workspace id and the imported node count.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const args = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    workspace: { type: "string" },
    server: { type: "string" },
    "key-file": { type: "string" },
  },
});

const SERVER = (args.values.server ?? process.env.NOTEES_API ?? "http://localhost:8377").replace(/\/$/, "");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = args.values["key-file"] ?? resolve(REPO_ROOT, "config/notees/sync/api_key.txt");
const RELAY = `${SERVER}/api/relay/v2`;

const imagePath = args.positionals[0];
if (!imagePath || !existsSync(imagePath)) {
  console.error(`usage: import-snapshot.mjs <image-file> [--name <ws-name>] [--workspace <existing-empty-ws-id>] [--server <url>] [--key-file <path>]`);
  console.error(imagePath ? `image file not found: ${imagePath}` : "missing <image-file>");
  process.exit(2);
}

function adminPassword() {
  if (process.env.NOTEES_ADMIN_PASSWORD) return process.env.NOTEES_ADMIN_PASSWORD;
  if (process.env.NOTEES_ADMIN_PASSWORD_FILE && existsSync(process.env.NOTEES_ADMIN_PASSWORD_FILE)) {
    return readFileSync(process.env.NOTEES_ADMIN_PASSWORD_FILE, "utf8").trim();
  }
  return null;
}

async function sessionToken() {
  const password = adminPassword();
  const email = process.env.NOTEES_ADMIN_EMAIL;
  if (!password || !email) return null;
  const res = await fetch(`${SERVER}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (typeof body.token !== "string" || body.token === "") throw new Error("login returned no token");
  return body.token;
}

function operatorKey() {
  if (!existsSync(KEY_FILE)) return null;
  const key = readFileSync(KEY_FILE, "utf8").trim();
  return key === "" ? null : key;
}

async function main() {
  const token = await sessionToken();
  const key = operatorKey();

  let workspaceId = args.values.workspace ?? null;
  if (workspaceId === null) {
    if (token === null) {
      throw new Error(
        "creating a workspace needs an account session — set NOTEES_ADMIN_EMAIL + NOTEES_ADMIN_PASSWORD(_FILE), or pass --workspace for an existing empty workspace",
      );
    }
    const res = await fetch(`${SERVER}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: args.values.name ?? null }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`workspace create failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    workspaceId = (await res.json()).id;
  }
  if (typeof workspaceId !== "string" || workspaceId === "") {
    throw new Error("no target workspace — pass --workspace or let the script create one");
  }

  const headers = { "content-type": "application/octet-stream" };
  if (key !== null) headers["x-api-key"] = key;
  else if (token !== null) headers.authorization = `Bearer ${token}`;
  else throw new Error("no credential — neither the operator key file nor an admin session is available");

  const image = readFileSync(imagePath);
  const url =
    `${RELAY}/snapshot/data?workspaceId=${encodeURIComponent(workspaceId)}` +
    `&physical=${Date.now()}&logical=0&mode=import`;
  const res = await fetch(url, { method: "PUT", headers, body: image, signal: AbortSignal.timeout(600_000) });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON error page — reported verbatim below.
  }
  if (!res.ok) {
    throw new Error(`import failed: ${res.status} ${body?.error?.code ?? ""} ${body?.error?.message ?? text.slice(0, 300)}`);
  }
  console.log(`workspace ${workspaceId}`);
  console.log(`imported ${body.nodeCount} nodes (snapshot ${body.snapshotId}, upToSeq ${body.upToSeq})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
