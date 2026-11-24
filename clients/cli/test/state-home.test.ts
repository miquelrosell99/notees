/**
 * State/config homes: the XDG split (preferences in the config home, secrets
 * + derived stores in the data home) and the one-time legacy `~/.notees`
 * migration. `os.homedir()` is read at call time, so the specs swap $HOME
 * (and the XDG vars) for the whole test body; module-level migration latches
 * reset via fresh imports.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "notees-cli-home-test-"));
  dirs.push(dir);
  return dir;
}

/** Swap the home/XDG env for the whole callback; import a fresh state module inside. */
async function withFreshState<T>(
  env: Record<string, string>,
  fn: (mod: typeof import("../src/state.js")) => Promise<T>,
): Promise<T> {
  const keys = ["NOTEES_STATE_FILE", "NOTEES_CONFIG_FILE", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "HOME"];
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    const mod = await import("../src/state.js");
    return await fn(mod);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe("state/config homes", () => {
  it("defaults to the XDG homes: data home for state, config home for the defaults", async () => {
    const home = tempHome();
    await withFreshState({ HOME: home }, async (mod) => {
      expect(mod.defaultStatePath()).toBe(join(home, ".local", "share", "notees", "state.json"));
      expect(mod.defaultConfigPath()).toBe(join(home, ".config", "notees", "config.json"));
    });
  });

  it("honours XDG_DATA_HOME / XDG_CONFIG_HOME overrides", async () => {
    const home = tempHome();
    const data = join(home, "xdg-data");
    const conf = join(home, "xdg-config");
    await withFreshState({ HOME: home, XDG_DATA_HOME: data, XDG_CONFIG_HOME: conf }, async (mod) => {
      expect(mod.defaultStatePath()).toBe(join(data, "notees", "state.json"));
      expect(mod.defaultConfigPath()).toBe(join(conf, "notees", "config.json"));
    });
  });

  it("NOTEES_STATE_FILE / NOTEES_CONFIG_FILE win and skip every migration", async () => {
    const home = tempHome();
    // A legacy dir that must be left untouched by the overrides.
    const legacy = join(home, ".notees");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "state.json"), JSON.stringify({ version: 1, servers: {}, profiles: { default: { server: "https://legacy" } } }), { mode: 0o600 });
    const stateFile = join(home, "custom", "state.json");
    const configFile = join(home, "custom", "config.json");
    await withFreshState({ HOME: home, NOTEES_STATE_FILE: stateFile, NOTEES_CONFIG_FILE: configFile }, async (mod) => {
      expect(mod.defaultStatePath()).toBe(stateFile);
      expect(mod.defaultConfigPath()).toBe(configFile);
    });
    expect(existsSync(join(legacy, "state.json"))).toBe(true);
    expect(existsSync(join(home, ".local", "share", "notees", "state.json"))).toBe(false);
    expect(existsSync(join(home, ".config", "notees", "config.json"))).toBe(false);
  });

  it("migrates the legacy ~/.notees home (state + stores) into the data home", async () => {
    const home = tempHome();
    const legacy = join(home, ".notees");
    mkdirSync(join(legacy, "stores"), { recursive: true });
    writeFileSync(join(legacy, "state.json"), JSON.stringify({ version: 1, servers: {} }), { mode: 0o600 });
    writeFileSync(join(legacy, "stores", "ws.db"), "derived");
    await withFreshState({ HOME: home }, async (mod) => {
      expect(mod.defaultStatePath()).toBe(join(home, ".local", "share", "notees", "state.json"));
    });
    const moved = join(home, ".local", "share", "notees");
    expect(JSON.parse(readFileSync(join(moved, "state.json"), "utf8"))).toEqual({ version: 1, servers: {} });
    expect(readFileSync(join(moved, "stores", "ws.db"), "utf8")).toBe("derived");
    expect(existsSync(join(legacy, "state.json"))).toBe(false);
  });

  it("splits legacy per-profile defaults into the config home and strips them from state", async () => {
    const home = tempHome();
    const legacy = join(home, ".notees");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, "state.json"),
      JSON.stringify({
        version: 1,
        servers: { "default:https://x": { credential: { kind: "apiKey", token: "nk_test", createdAt: "2026-11-24" } } },
        profiles: { default: { server: "https://prod", workspace: "ws-1" } },
      }),
      { mode: 0o600 },
    );
    // The real resolution order: the state home migrates first, then the
    // config split reads the moved state file.
    let statePath = "";
    let configPath = "";
    await withFreshState({ HOME: home }, async (mod) => {
      statePath = mod.defaultStatePath();
      configPath = mod.defaultConfigPath();
      expect(configPath).toBe(join(home, ".config", "notees", "config.json"));
      expect(mod.loadConfig(configPath).profiles.default).toEqual({ server: "https://prod", workspace: "ws-1" });
      // The state half keeps the credential but drops the profiles key.
      const state = mod.loadState(statePath);
      expect(state.servers["default:https://x"]?.credential?.token).toBe("nk_test");
      expect(state.profiles).toBeUndefined();
    });
    expect(statePath.endsWith(join(".local", "share", "notees", "state.json"))).toBe(true);
  });
});
