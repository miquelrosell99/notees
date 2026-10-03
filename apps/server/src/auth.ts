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

import { createCipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import { uuidv7 } from "uuidv7";

const scrypt = promisify(scryptCb) as unknown as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 36; // 48 base64url chars.

// Key-derivation parameters for password-derived encryption keys (the E2EE
// groundwork, Standard-Notes-style): auth uses fast scrypt above; deriving
// the user's master-key wrap key uses memory-hard parameters. The derived
// key never leaves the client in an E2EE flow; the server stores only the
// salt/params, the wrapped master key, and a verifier tag.
const KDF_N = 131072;
const KDF_R = 8;
const KDF_P = 1;

// Per-account login lockout: 5 failures → 15-minute lock (Sonarly /
// NextExplorer pattern). In-memory, like the fleet's lockouts — state resets
// on restart, which is the accepted tradeoff (a restart clears a lockout but
// also clears the failure count).
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string | null;
  name: string | null;
  surnames: string | null;
  avatarUrl: string | null;
  isAdmin: number;
  createdAt: number;
}

type UserRowRaw = Omit<UserRow, "passwordHash" | "displayName" | "name" | "surnames" | "avatarUrl" | "isAdmin" | "createdAt"> & {
  name: string | null;
  surnames: string | null;
  avatar_url: string | null;
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
    name: raw.name,
    surnames: raw.surnames,
    avatarUrl: raw.avatar_url,
    isAdmin: raw.is_admin,
    createdAt: raw.created_at,
  };
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  name: string | null;
  surnames: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface WorkspaceListEntry {
  id: string;
  name: string | null;
  role: string;
  createdAt: number;
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
    created_at INTEGER NOT NULL,
    name TEXT,
    surnames TEXT,
    avatar_url TEXT,
    kdf_salt TEXT,
    kdf_n INTEGER,
    kdf_r INTEGER,
    kdf_p INTEGER,
    wrapped_master_key TEXT,
    key_verifier TEXT
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

-- Per-user API keys: machine credentials minted from user settings. Only the
-- sha256 of the key is stored; the full nk_-prefixed token is shown once at
-- creation (like session tokens, nt_-prefixed, only hashed at rest).
-- The scopes column (§34.33 AG3): optional JSON array of scope names; NULL
-- means unrestricted (the M1 default; pre-scopes rows migrate as NULL).
CREATE TABLE IF NOT EXISTS api_key (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    scopes TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_key_user ON api_key (user_id);
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
    const derived = (await scrypt(password, salt, expected.length, { N, r, p }));
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** User API keys: `nk_` + 40 base64url chars (operator keys are nk_+32). */
export function generateApiKeyToken(): string {
  return `nk_${randomBytes(30).toString("base64url")}`;
}

// --- password-derived encryption keys (E2EE groundwork) ---------------------------
//
// Every account carries a random 256-bit master key. At rest the server
// stores only: the scrypt KDF parameters + salt, the master key encrypted
// with the password-derived key (AES-256-GCM), and a verifier tag the client
// can check after deriving the key (so a wrong password is detectable before
// attempting to unwrap). The password-derived key itself is never stored or
// transmitted. Created at setup, backfilled lazily on login for accounts
// that predate the column (e.g. the v1 import).

export interface KdfRecord {
  algorithm: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  wrappedMasterKey: string;
  keyVerifier: string;
}

async function deriveKey(password: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  // maxmem: N=131072/r=8 needs ~128MiB of scratch, above OpenSSL's default
  // cap — the explicit ceiling is required, not optional.
  return (await scrypt(password, salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 }));
}

/** Wrap a fresh master key with the password-derived key; returns the record. */
export async function createKdfRecord(password: string): Promise<KdfRecord> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, KDF_N, KDF_R, KDF_P);
  const masterKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  const verifier = createHmac("sha256", key).update("notees-key-check").digest();
  return {
    algorithm: "scrypt",
    N: KDF_N,
    r: KDF_R,
    p: KDF_P,
    salt: salt.toString("base64url"),
    wrappedMasterKey: Buffer.concat([iv, tag, ciphertext]).toString("base64url"),
    keyVerifier: verifier.toString("base64url"),
  };
}

export interface ApiKeyRow {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /**
   * §34.33 AG3: the key's scope set, or null when the key is unrestricted
   * (created without scopes — the M1 default; the operator key and account
   * sessions are always unrestricted).
   */
  scopes: string[] | null;
}

interface ApiKeyRaw {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  scopes: string | null;
}

function toApiKeyRow(raw: ApiKeyRaw): ApiKeyRow {
  return {
    id: raw.id,
    userId: raw.user_id,
    name: raw.name,
    prefix: raw.prefix,
    createdAt: raw.created_at,
    lastUsedAt: raw.last_used_at,
    revokedAt: raw.revoked_at,
    scopes: raw.scopes === null ? null : (JSON.parse(raw.scopes) as string[]),
  };
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
    // Additive column migrations: relay.db may predate a column (CREATE TABLE
    // IF NOT EXISTS never alters an existing table).
    const columns = new Set(
      (this.db.pragma('table_info("user")') as { name: string }[]).map((c) => c.name),
    );
    const additions: [string, string][] = [
      ["name", "TEXT"],
      ["surnames", "TEXT"],
      ["avatar_url", "TEXT"],
      ["kdf_salt", "TEXT"],
      ["kdf_n", "INTEGER"],
      ["kdf_r", "INTEGER"],
      ["kdf_p", "INTEGER"],
      ["wrapped_master_key", "TEXT"],
      ["key_verifier", "TEXT"],
    ];
    for (const [name, type] of additions) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE "user" ADD COLUMN ${name} ${type}`);
      }
    }
    const keyColumns = new Set(
      (this.db.pragma("table_info(api_key)") as { name: string }[]).map((c) => c.name),
    );
    if (!keyColumns.has("scopes")) {
      this.db.exec("ALTER TABLE api_key ADD COLUMN scopes TEXT");
    }
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
      name: null,
      surnames: null,
      avatarUrl: null,
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
                u.display_name AS display_name, u.name AS name, u.surnames AS surnames,
                u.avatar_url AS avatar_url, u.is_admin AS is_admin
         FROM session s JOIN "user" u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(digest) as
      | { expires_at: number; id: string; email: string; display_name: string | null; name: string | null; surnames: string | null; avatar_url: string | null; is_admin: number }
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
        name: row.name,
        surnames: row.surnames,
        avatarUrl: row.avatar_url,
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

  /** Rename an existing workspace; no-op when the workspace row is missing. */
  renameWorkspace(workspaceId: string, name: string): void {
    this.db
      .prepare("UPDATE workspace SET name = ? WHERE id = ?")
      .run(name, workspaceId);
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
        `SELECT w.id AS id, w.name AS name, m.role AS role, w.created_at AS created_at
         FROM workspace_member m JOIN workspace w ON w.id = m.workspace_id
         WHERE m.user_id = ? ORDER BY w.created_at ASC`,
      )
      .all(userId) as { id: string; name: string | null; role: string; created_at: number }[];
    return rows.map((row) => ({ ...row, createdAt: row.created_at, ...stats(row.id) }));
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

  // --- API keys -------------------------------------------------------------------

  /** Mint a key; returns the row plus the full token (shown to the user once). */
  createApiKey(userId: string, name: string, scopes?: string[]): { row: ApiKeyRow; token: string } {
    const token = generateApiKeyToken();
    const id = uuidv7();
    this.db
      .prepare(
        `INSERT INTO api_key (id, user_id, name, key_hash, prefix, created_at, scopes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        name.trim() || "API key",
        tokenDigest(token),
        token.slice(0, 12),
        Date.now(),
        scopes !== undefined ? JSON.stringify(scopes) : null,
      );
    const row = this.db.prepare("SELECT * FROM api_key WHERE id = ?").get(id) as ApiKeyRaw;
    return { row: toApiKeyRow(row), token };
  }

  listApiKeys(userId: string): ApiKeyRow[] {
    const rows = this.db
      .prepare("SELECT * FROM api_key WHERE user_id = ? ORDER BY created_at ASC")
      .all(userId) as ApiKeyRaw[];
    return rows.map(toApiKeyRow);
  }

  revokeApiKey(userId: string, keyId: string): boolean {
    const result = this.db
      .prepare("UPDATE api_key SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .run(Date.now(), keyId, userId);
    return result.changes > 0;
  }

  /**
   * Resolve a key to its owning user id (and the key's own row id — self-
   * revocation); updates last_used_at. `scopes` is null for unrestricted
   * keys (§34.33 AG3).
   */
  resolveApiKey(token: string): { userId: string; isAdmin: boolean; keyId: string; scopes: string[] | null } | null {

    const row = this.db
      .prepare(
        `SELECT k.id AS key_id, k.revoked_at AS revoked_at, k.scopes AS scopes,
                u.id AS user_id, u.is_admin AS is_admin
         FROM api_key k JOIN "user" u ON u.id = k.user_id
         WHERE k.key_hash = ?`,
      )
      .get(tokenDigest(token)) as
      | { key_id: string; revoked_at: number | null; scopes: string | null; user_id: string; is_admin: number }
      | undefined;
    if (row === undefined || row.revoked_at !== null) return null;
    this.db
      .prepare("UPDATE api_key SET last_used_at = ? WHERE id = ?")
      .run(Date.now(), row.key_id);
    return {
      userId: row.user_id,
      isAdmin: row.is_admin === 1,
      keyId: row.key_id,
      scopes: row.scopes === null ? null : (JSON.parse(row.scopes) as string[]),
    };
  }

  // --- password-derived keys ------------------------------------------------------

  getKdfRecord(userId: string): KdfRecord | null {
    const row = this.db
      .prepare(
        `SELECT kdf_salt, kdf_n, kdf_r, kdf_p, wrapped_master_key, key_verifier
         FROM "user" WHERE id = ?`,
      )
      .get(userId) as
      | {
          kdf_salt: string | null;
          kdf_n: number | null;
          kdf_r: number | null;
          kdf_p: number | null;
          wrapped_master_key: string | null;
          key_verifier: string | null;
        }
      | undefined;
    if (
      row === undefined ||
      row.kdf_salt === null ||
      row.kdf_n === null ||
      row.kdf_r === null ||
      row.kdf_p === null ||
      row.wrapped_master_key === null ||
      row.key_verifier === null
    ) {
      return null;
    }
    return {
      algorithm: "scrypt",
      N: row.kdf_n,
      r: row.kdf_r,
      p: row.kdf_p,
      salt: row.kdf_salt,
      wrappedMasterKey: row.wrapped_master_key,
      keyVerifier: row.key_verifier,
    };
  }

  /** Remove a workspace and all its membership rows (owner-initiated delete). */
  deleteWorkspace(workspaceId: string): void {
    this.db.prepare("DELETE FROM workspace_member WHERE workspace_id = ?").run(workspaceId);
    this.db.prepare("DELETE FROM workspace WHERE id = ?").run(workspaceId);
  }

  /** Profile fields editable from user settings (all optional). */
  updateProfile(
    userId: string,
    input: {
      displayName?: string | null | undefined;
      name?: string | null | undefined;
      surnames?: string | null | undefined;
      avatarUrl?: string | null | undefined;
    },
  ): void {
    const map: Record<string, string | null | undefined> = {
      display_name: input.displayName,
      name: input.name,
      surnames: input.surnames,
      avatar_url: input.avatarUrl,
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of Object.entries(map)) {
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        values.push(value);
      }
    }
    if (sets.length === 0) return;
    values.push(userId);
    this.db.prepare(`UPDATE "user" SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  /** Backfill the KDF record for accounts that predate it (idempotent). */
  async ensureKdfRecord(userId: string, password: string): Promise<KdfRecord> {
    const existing = this.getKdfRecord(userId);
    if (existing !== null) return existing;
    const record = await createKdfRecord(password);
    this.db
      .prepare(
        `UPDATE "user" SET kdf_salt = ?, kdf_n = ?, kdf_r = ?, kdf_p = ?,
                wrapped_master_key = ?, key_verifier = ? WHERE id = ?`,
      )
      .run(record.salt, record.N, record.r, record.p, record.wrappedMasterKey, record.keyVerifier, userId);
    return record;
  }

  close(): void {
    this.db.close();
  }
}

// --- per-account login lockout -------------------------------------------------------

interface LockoutEntry {
  count: number;
  firstFailureAt: number;
  lockedUntil: number;
}

export interface LockoutStatus {
  locked: boolean;
  retryAfterSeconds: number;
}

/**
 * In-memory per-account lockout (5 failures within 15 min → locked for
 * 15 min). Deliberately not persisted: a restart clears both the failure
 * count and any active lock, the accepted fleet-wide tradeoff (Sonarly,
 * NextExplorer do the same).
 */
export class AccountLockout {
  private readonly entries = new Map<string, LockoutEntry>();

  private entry(email: string): LockoutEntry {
    const key = email.toLowerCase();
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { count: 0, firstFailureAt: 0, lockedUntil: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  status(email: string, now = Date.now()): LockoutStatus {
    const entry = this.entry(email);
    if (entry.lockedUntil > now) {
      return { locked: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
    }
    if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) {
      // Lock expired: reset the window.
      entry.count = 0;
      entry.lockedUntil = 0;
    }
    return { locked: false, retryAfterSeconds: 0 };
  }

  /** Record a failure; returns the resulting lock state. */
  recordFailure(email: string, now = Date.now()): LockoutStatus {
    const entry = this.entry(email);
    if (now - entry.firstFailureAt > LOCKOUT_WINDOW_MS) {
      entry.count = 0;
      entry.firstFailureAt = now;
    }
    entry.count += 1;
    if (entry.count >= LOCKOUT_THRESHOLD) {
      entry.lockedUntil = now + LOCKOUT_DURATION_MS;
      entry.count = 0;
      entry.firstFailureAt = 0;
    }
    return this.status(email, now);
  }

  recordSuccess(email: string): void {
    this.entries.delete(email.toLowerCase());
  }
}
