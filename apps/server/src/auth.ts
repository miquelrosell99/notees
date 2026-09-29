/**
 * Accounts on the sync server: users, sessions, workspaces, membership.
 *
 * The relay used to be single-user (the bootstrap API key was the principal).
 * This module adds account-based access on top of the same relay.db so the
 * web client can log in with email + password instead of pasting a relay key
 * and workspace UUID. The API-key principal is kept as the machine/operator
 * path (CLI, owned devices) with full access — see routes-relay.ts authz.
 *
 * Passwords are scrypt-hashed (`scrypt$N$r$p$salt$hash`, node:crypto, no
 * dependencies). v1's bcrypt hashes are NOT stored: the one-off migration
 * script (scripts/import-v1-admin.mjs) verifies the v1 bcrypt hash with
 * Python and stores a fresh scrypt hash of the same password.
 *
 * Sessions are opaque `nt_` tokens; only the sha256 of the token is stored,
 * so a database leak does not leak active sessions. 30-day expiry, sliding:
 * every authenticated use extends the expiry (capped at 30 days past now).
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import { uuidv7 } from "uuidv7";

const scrypt = promisify(scryptCb);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 36; // 48 base64url chars.

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string | null;
  isAdmin: number;
  createdAt: number;
}

type UserRowRaw = Omit<UserRow, "passwordHash" | "displayName" | "isAdmin" | "createdAt"> & {
  password_hash: string;
  display_name: string | null;
  is_admin: number;
  created_at: number;
};

function toUserRow(raw: UserRowRaw): UserRow {
  return {
    id: raw.id,
    email: raw.email,
    passwordHash: raw.password_hash,
    displayName: raw.display_name,
    isAdmin: raw.is_admin,
    createdAt: raw.created_at,
  };
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
}

export interface WorkspaceListEntry {
  id: string;
  name: string | null;
  role: string;
  envelopeCount: number;
  latestSeq: number;
}

const DDL = `
CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_user ON session (user_id);
CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_by TEXT REFERENCES "user"(id),
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_member (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'owner',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_member_user ON workspace_member (user_id);
`;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  try {
    const derived = (await scrypt(password, salt, expected.length, { N, r, p })) as Buffer;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type Db = Database.Database;

export class AuthStorage {
  private readonly db: Db;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(DDL);
  }

  // --- users -------------------------------------------------------------------

  userCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM \"user\"").get() as { n: number }).n;
  }

  createUser(input: {
    id?: string;
    email: string;
    passwordHash: string;
    displayName?: string | null;
    isAdmin?: boolean;
  }): UserRow {
    const row: UserRow = {
      id: input.id ?? uuidv7(),
      email: input.email.trim(),
      passwordHash: input.passwordHash,
      displayName: input.displayName ?? null,
      isAdmin: input.isAdmin === true ? 1 : 0,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO "user" (id, email, password_hash, display_name, is_admin, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.email, row.passwordHash, row.displayName, row.isAdmin, row.createdAt);
    return row;
  }

  findUserByEmail(email: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM \"user\" WHERE email = ?").get(email.trim()) as
      | UserRowRaw
      | undefined;
    return row === undefined ? null : toUserRow(row);
  }

  findUserById(id: string): UserRow | null {
    const row = this.db.prepare("SELECT * FROM \"user\" WHERE id = ?").get(id) as
      | UserRowRaw
      | undefined;
    return row === undefined ? null : toUserRow(row);
  }

  // --- sessions ------------------------------------------------------------------

  /** Mint an opaque session token; returns the full token once (store sha256). */
  createSession(userId: string): { token: string; expiresAt: number } {
    const token = `nt_${randomBytes(TOKEN_BYTES).toString("base64url")}`;
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.db
      .prepare(
        "INSERT INTO session (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(tokenDigest(token), userId, now, expiresAt);
    return { token, expiresAt };
  }

  /** Resolve a token to its user, extending the expiry (sliding, capped). */
  resolveSession(token: string): { user: SessionUser; expiresAt: number } | null {
    const digest = tokenDigest(token);
    const row = this.db
      .prepare(
        `SELECT s.expires_at AS expires_at, u.id AS id, u.email AS email,
                u.display_name AS display_name, u.is_admin AS is_admin
         FROM session s JOIN "user" u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(digest) as
      | { expires_at: number; id: string; email: string; display_name: string | null; is_admin: number }
      | undefined;
    if (row === undefined) return null;
    const now = Date.now();
    if (row.expires_at <= now) {
      this.db.prepare("DELETE FROM session WHERE token_hash = ?").run(digest);
      return null;
    }
    const extended = Math.min(row.expires_at, now) + SESSION_TTL_MS;
    this.db
      .prepare("UPDATE session SET expires_at = ? WHERE token_hash = ?")
      .run(extended, digest);
    return {
      user: {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        isAdmin: row.is_admin === 1,
      },
      expiresAt: extended,
    };
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM session WHERE token_hash = ?").run(tokenDigest(token));
  }

  // --- workspaces & membership ------------------------------------------------------

  createWorkspace(input: { id?: string; name?: string | null; createdBy?: string | null }): string {
    const id = input.id ?? uuidv7();
    this.db
      .prepare(
        "INSERT INTO workspace (id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, input.name ?? null, input.createdBy ?? null, Date.now());
    return id;
  }

  addMember(workspaceId: string, userId: string, role = "owner"): void {
    this.db
      .prepare(
        `INSERT INTO workspace_member (workspace_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      )
      .run(workspaceId, userId, role, Date.now());
  }

  membership(workspaceId: string, userId: string): string | null {
    const row = this.db
      .prepare("SELECT role FROM workspace_member WHERE workspace_id = ? AND user_id = ?")
      .get(workspaceId, userId) as { role: string } | undefined;
    return row?.role ?? null;
  }

  /** Workspaces with at least one member (claimed). */
  hasAnyMembership(workspaceId: string): boolean {
    return (
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM workspace_member WHERE workspace_id = ?")
          .get(workspaceId) as { n: number }
      ).n > 0
    );
  }

  listWorkspacesForUser(
    userId: string,
    stats: (workspaceId: string) => { envelopeCount: number; latestSeq: number },
  ): WorkspaceListEntry[] {
    const rows = this.db
      .prepare(
        `SELECT w.id AS id, w.name AS name, m.role AS role
         FROM workspace_member m JOIN workspace w ON w.id = m.workspace_id
         WHERE m.user_id = ? ORDER BY w.created_at ASC`,
      )
      .all(userId) as { id: string; name: string | null; role: string }[];
    return rows.map((row) => ({ ...row, ...stats(row.id) }));
  }

  /** Every workspace id present in the relay log (migration helper). */
  listAllWorkspaceIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT workspace_id AS id FROM envelope
         UNION SELECT DISTINCT workspace_id FROM snapshot
         UNION SELECT id FROM workspace`,
      )
      .all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  close(): void {
    this.db.close();
  }
}
