export interface AddinSettings {
  port: number;
  token: string;
  styleId: string;
}

export interface KVStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface SettingsStore {
  load(): AddinSettings;
  save(patch: Partial<AddinSettings>): AddinSettings;
  clear(): void;
}

const DEFAULTS: AddinSettings = { port: 8474, token: "", styleId: "apa" };
const KEY = "notees.addin.settings.v1";
/** The canonical record shape — anything else in storage is legacy. */
const KNOWN_KEYS = new Set(["port", "token", "styleId"]);

export function createSettingsStore(kv: KVStore): SettingsStore {
  return {
    load() {
      try {
        const raw = kv.get(KEY);
        if (!raw) return { ...DEFAULTS };
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const port = Number(parsed.port);
        const settings: AddinSettings = {
          port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULTS.port,
          token: typeof parsed.token === "string" ? parsed.token : DEFAULTS.token,
          styleId: typeof parsed.styleId === "string" && parsed.styleId ? parsed.styleId : DEFAULTS.styleId,
        };
        // Migration: the pre-gateway pane stored its own sync-server URL and
        // API key in this record. The gateway (notees word serve) holds those
        // now — a legacy record must not break startup, and loading one
        // rewrites it to the canonical shape so the dropped fields (and any
        // other strays) leave localStorage for good.
        if (Object.keys(parsed).some((key) => !KNOWN_KEYS.has(key))) {
          kv.set(KEY, JSON.stringify(settings));
        }
        return settings;
      } catch {
        return { ...DEFAULTS };
      }
    },
    save(patch) {
      const next = { ...this.load(), ...patch };
      kv.set(KEY, JSON.stringify(next));
      return next;
    },
    clear() {
      kv.set(KEY, JSON.stringify(DEFAULTS));
    },
  };
}
