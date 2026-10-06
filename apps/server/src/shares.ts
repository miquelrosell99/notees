/**
 * Share tokens — server-side coordination state for READ-ONLY public
 * page shares: an owner/admin mints an unguessable token for a page; anyone
 * holding `GET /s/<token>` gets a static read-only render. No write path, no
 * viewer account. Deliberately NOT operation-log state (like prefs): shares
 * are coordination, they expire, they are revoked — none of that belongs in
 * the semantic graph every client converges on.
 *
 * Stored in relay.db next to the account tables (one coordination database).
 * The token is the capability and is stored as-is: a relay.db leak already
 * exposes the workspace's whole derived content, so hashing the token would
 * buy nothing the threat model cares about (documented in the OpenAPI
 * description + docs/usage.md).
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

const DDL = `
CREATE TABLE IF NOT EXISTS share_tokens (
    token TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_share_tokens_node ON share_tokens (workspace_id, node_id);
CREATE INDEX IF NOT EXISTS idx_share_tokens_created ON share_tokens (created_at);
`;

export interface ShareRow {
  token: string;
  workspaceId: string;
  nodeId: string;
  /** The minter's user id, or the server's operator actor id. */
  createdBy: string | null;
  createdAt: number;
  /** Epoch millis after which the share stops resolving; null = no expiry. */
  expiresAt: number | null;
  /** Epoch millis when revoked; null = live (when also unexpired). */
  revokedAt: number | null;
}

interface ShareRowRaw {
  token: string;
  workspace_id: string;
  node_id: string;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

function toShareRow(raw: ShareRowRaw): ShareRow {
  return {
    token: raw.token,
    workspaceId: raw.workspace_id,
    nodeId: raw.node_id,
    createdBy: raw.created_by,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    revokedAt: raw.revoked_at,
  };
}

/** Live = not revoked and not past its expiry (absent expiry never lapses). */
export function shareIsLive(row: ShareRow, now = Date.now()): boolean {
  return row.revokedAt === null && (row.expiresAt === null || row.expiresAt > now);
}

export class ShareStorage {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(DDL);
  }

  /** Mint a share; returns the row. The caller validated the node + expiry. */
  create(input: {
    workspaceId: string;
    nodeId: string;
    createdBy: string | null;
    expiresAt: number | null;
  }): ShareRow {
    const token = randomBytes(24).toString("base64url");
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO share_tokens (token, workspace_id, node_id, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(token, input.workspaceId, input.nodeId, input.createdBy, createdAt, input.expiresAt);
    return {
      token,
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      createdBy: input.createdBy,
      createdAt,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
  }

  get(token: string): ShareRow | null {
    const row = this.db
      .prepare("SELECT * FROM share_tokens WHERE token = ?")
      .get(token) as ShareRowRaw | undefined;
    return row === undefined ? null : toShareRow(row);
  }

  /** Newest first; includes revoked rows so managers can see history. */
  list(workspaceId: string, nodeId?: string): ShareRow[] {
    const rows = (
      nodeId === undefined
        ? this.db
            .prepare("SELECT * FROM share_tokens WHERE workspace_id = ? ORDER BY created_at DESC")
            .all(workspaceId)
        : this.db
            .prepare(
              "SELECT * FROM share_tokens WHERE workspace_id = ? AND node_id = ? ORDER BY created_at DESC",
            )
            .all(workspaceId, nodeId)
    ) as ShareRowRaw[];
    return rows.map(toShareRow);
  }

  /** Immediate revocation: the row keeps revoked_at; the public route 404s. */
  revoke(token: string): boolean {
    const result = this.db
      .prepare("UPDATE share_tokens SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL")
      .run(Date.now(), token);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
