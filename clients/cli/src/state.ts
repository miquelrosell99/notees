/**
 * Local CLI state lives in two XDG homes. STATE (`$XDG_DATA_HOME/notees/`,
 * default `~/.local/share/notees/`; the legacy `~/.notees/` home migrates
 * itself on first use): workspace cursors per server, stored credentials,
 * cached master keys — secrets and derived data, never synced by dotfiles
 * tools. CONFIG (`$XDG_CONFIG_HOME/notees/`, default `~/.config/notees/`):
 * the per-profile defaults from `notees config set` — the default sync URL
 * and workspace ARE preferences. Both files: reads tolerant (missing/corrupt
 * → empty), writes atomic (tmp + rename). Tests and relocations inject paths
 * via NOTEES_STATE_FILE / NOTEES_CONFIG_FILE (the former also pins the
 * derived stores beside it).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Stored credential from `notees auth login` (the state file is mode 0600). */
export interface StoredCredential {
  kind: "apiKey" | "session";
  token: string;
  /** The api-keys row id — `notees auth logout` revokes it server-side. */
  keyId?: string;
  email?: string;
  createdAt: string;
}

/**
 * Cached account master key for encrypted (E2EE) workspaces — the CLI-side
 * parity of the web client's persisted custody record (IndexedDB): one
 * password unlock must not be required on every invocation. Raw b64u bytes,
 * same trust domain as the stored credential (the state file is mode 0600).
 * Cleared by `notees auth lock` and `notees auth logout`.
 */
export interface CachedMasterKey {
  /** b64u of the 32-byte master key. */
  bytes: string;
  updatedAt: string;
}

export interface ServerState {
  workspaceId?: string;
  cursorSeq?: number;
  updatedAt?: string;
  /** Resolved --workspace name → workspace id (per server + profile). */
  workspaces?: Record<string, string>;
  /** Credential for this server+profile (set by `notees auth login`). */
  credential?: StoredCredential;
  /** Cached master key (encrypted workspaces; written on first unlock). */
  masterKey?: CachedMasterKey;
}

/**
 * Per-profile defaults written by `notees config set` — the stored default
 * server (so bare `notees <cmd>` works without env vars) and the stored
 * default workspace. Keyed by profile name, NOT by `profile:server`: the
 * server is what is being selected here, so it cannot be part of the key.
 */
export interface ProfileDefaults {
  server?: string;
  workspace?: string;
  updatedAt?: string;
}

export interface CliState {
  version: 1;
  servers: Record<string, ServerState>;
  /** Absent in state files written before `notees config` existed. */
  profiles?: Record<string, ProfileDefaults>;
}

/**
 * The default state home: the XDG data directory (state + derived stores are
 * data, not configuration — credentials and cached master keys ride the same
 * 0600 file). `NOTEES_STATE_FILE` overrides the whole home (tests, relocated
 * installs) and skips the legacy migration.
 */
function defaultStateHome(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "notees");
}

/**
 * One-time `~/.notees` → XDG home migration (idempotent — two existence
 * checks per call, cheap enough to run on every resolution). Same-volume
 * renames (state file + the stores directory move together — the stores are
 * derived and disposable, but keeping them avoids a re-sync); the legacy dir
 * is removed when empty. Runs only when the XDG home has no state yet: an
 * existing XDG state wins (already migrated), and a legacy dir under an
 * explicitly overridden NOTEES_STATE_FILE is left alone.
 */
function migrateLegacyHome(env: NodeJS.ProcessEnv): void {
  const legacy = join(homedir(), ".notees");
  const legacyState = join(legacy, "state.json");
  const home = defaultStateHome(env);
  if (existsSync(join(home, "state.json")) || !existsSync(legacyState)) return;
  mkdirSync(home, { recursive: true });
  renameSync(legacyState, join(home, "state.json"));
  const legacyStores = join(legacy, "stores");
  if (existsSync(legacyStores)) renameSync(legacyStores, join(home, "stores"));
  try {
    rmSync(legacy, { recursive: false }); // removes only when now empty
  } catch {
    // Leftover entries — harmless; the state and stores moved.
  }
}

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NOTEES_STATE_FILE !== undefined && env.NOTEES_STATE_FILE.length > 0) {
    return env.NOTEES_STATE_FILE;
  }
  migrateLegacyHome(env);
  return join(defaultStateHome(env), "state.json");
}

// --- config (the preferences half) ------------------------------------------------

/**
 * The per-profile defaults ARE configuration (the default sync URL, the
 * default workspace — user preferences), so they live in the XDG config
 * home, split from the state file's secrets. Dotfiles tools commonly sync
 * `~/.config` to git remotes — credentials must never ride that path.
 * `NOTEES_CONFIG_FILE` overrides (tests, relocated installs).
 */
function defaultConfigHome(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "notees");
}

export interface CliConfig {
  version: 1;
  profiles: Record<string, ProfileDefaults>;
}

export function loadConfig(path: string): CliConfig {
  if (!existsSync(path)) return { version: 1, profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CliConfig>;
    if (parsed.version !== 1 || typeof parsed.profiles !== "object" || parsed.profiles === null) {
      return { version: 1, profiles: {} };
    }
    return { version: 1, profiles: parsed.profiles };
  } catch {
    return { version: 1, profiles: {} };
  }
}

export function saveConfig(path: string, config: CliConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * One-time split of the per-profile defaults out of the (legacy or
 * already-migrated) state file into the config home (idempotent — checked on
 * every resolution): reads switch to the config file exclusively, so the
 * stale `profiles` key is stripped from the state file it came from. Runs
 * only when no explicit NOTEES_CONFIG_FILE is set and the config file does
 * not exist yet.
 */
function migrateLegacyProfiles(env: NodeJS.ProcessEnv): void {
  if (env.NOTEES_CONFIG_FILE !== undefined && env.NOTEES_CONFIG_FILE.length > 0) return;
  const configPath = join(defaultConfigHome(env), "config.json");
  if (existsSync(configPath)) return;
  const dataState = join(defaultStateHome(env), "state.json");
  const legacyState = join(homedir(), ".notees", "state.json");
  const source = existsSync(dataState) ? dataState : existsSync(legacyState) ? legacyState : null;
  if (source === null) return;
  const state = loadState(source);
  if (state.profiles === undefined) return;
  saveConfig(configPath, { version: 1, profiles: state.profiles });
  delete state.profiles;
  saveState(source, state);
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NOTEES_CONFIG_FILE !== undefined && env.NOTEES_CONFIG_FILE.length > 0) {
    return env.NOTEES_CONFIG_FILE;
  }
  migrateLegacyProfiles(env);
  return join(defaultConfigHome(env), "config.json");
}

export function loadState(path: string): CliState {
  if (!existsSync(path)) return { version: 1, servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CliState>;
    if (parsed.version !== 1 || typeof parsed.servers !== "object" || parsed.servers === null) {
      return { version: 1, servers: {} };
    }
    // Tolerant of state files written before profiles existed (and of any
    // other unknown top-level fields, which are dropped on save).
    const profiles =
      typeof parsed.profiles === "object" && parsed.profiles !== null ? parsed.profiles : undefined;
    return { version: 1, servers: parsed.servers, ...(profiles !== undefined ? { profiles } : {}) };
  } catch {
    return { version: 1, servers: {} };
  }
}

export function saveState(path: string, state: CliState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function serverState(path: string, server: string): ServerState {
  return loadState(path).servers[server] ?? {};
}

export function updateServerState(
  path: string,
  server: string,
  patch: (current: ServerState) => ServerState,
): CliState {
  const state = loadState(path);
  state.servers[server] = patch(state.servers[server] ?? {});
  saveState(path, state);
  return state;
}

/** The cached master key for this server+profile, or undefined (never cached / cleared). */
export function cachedMasterKey(path: string, server: string): CachedMasterKey | undefined {
  return loadState(path).servers[server]?.masterKey;
}

/** Cache the master key bytes (atomic, mode 0600). */
export function storeCachedMasterKey(path: string, server: string, bytes: string): void {
  updateServerState(path, server, (current) => ({
    ...current,
    masterKey: { bytes, updatedAt: new Date().toISOString() },
  }));
}

/** Drop the cached master key (`notees auth lock` / logout). */
export function clearCachedMasterKey(path: string, server: string): boolean {
  const had = cachedMasterKey(path, server) !== undefined;
  if (had) {
    updateServerState(path, server, (current) => {
      const next = { ...current };
      delete next.masterKey;
      return next;
    });
  }
  return had;
}

export function profileDefaults(path: string, profile: string): ProfileDefaults {
  return loadState(path).profiles?.[profile] ?? {};
}

/** Atomic read-modify-write of one profile's defaults (same discipline as updateServerState). */
export function updateProfileDefaults(
  path: string,
  profile: string,
  patch: (current: ProfileDefaults) => ProfileDefaults,
): CliState {
  const state = loadState(path);
  state.profiles = state.profiles ?? {};
  state.profiles[profile] = patch(state.profiles[profile] ?? {});
  saveState(path, state);
  return state;
}
