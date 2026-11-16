import { describe, expect, it } from "vitest";
import { createSettingsStore, type KVStore } from "../src/settings/store";

function memoryKV(seed?: string): KVStore & { dump(): string | null } {
  const m = new Map<string, string>();
  if (seed !== undefined) m.set("notees.addin.settings.v1", seed);
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    dump: () => m.get("notees.addin.settings.v1") ?? null,
  };
}

describe("createSettingsStore", () => {
  it("returns defaults on empty store", () => {
    expect(createSettingsStore(memoryKV()).load()).toEqual({ port: 8474, token: "", styleId: "apa" });
  });

  it("round-trips a save", () => {
    const kv = memoryKV();
    const s = createSettingsStore(kv);
    const next = s.save({ port: 9000, token: "tok-abc" });
    expect(next).toEqual({ port: 9000, token: "tok-abc", styleId: "apa" });
    expect(s.load()).toEqual(next);
    expect(JSON.parse(kv.dump()!)).toEqual(next);
  });

  it("falls back to defaults on corrupted JSON", () => {
    expect(createSettingsStore(memoryKV("{not json")).load()).toEqual({ port: 8474, token: "", styleId: "apa" });
  });

  it("rejects out-of-range ports per-field, keeping valid fields", () => {
    const kv = memoryKV(JSON.stringify({ port: 70000, token: "keep-me", styleId: "apa" }));
    expect(createSettingsStore(kv).load()).toEqual({ port: 8474, token: "keep-me", styleId: "apa" });
  });

  it("rejects non-integer and non-positive ports", () => {
    for (const bad of [0, -1, 65536, 3.14, "abc"]) {
      const kv = memoryKV(JSON.stringify({ port: bad }));
      expect(createSettingsStore(kv).load().port).toBe(8474);
    }
  });

  it("survives a token round-trip and preserves it on unrelated saves", () => {
    const s = createSettingsStore(memoryKV());
    s.save({ token: "Bearer-token-123" });
    expect(s.save({ port: 9002 }).token).toBe("Bearer-token-123");
  });

  describe("legacy pre-gateway records", () => {
    it("a stored server URL + API key does not break startup and is dropped on load", () => {
      const kv = memoryKV(
        JSON.stringify({ port: 9001, token: "tok", styleId: "ieee", serverUrl: "https://old.example", apiKey: "old-key" }),
      );
      const store = createSettingsStore(kv);
      expect(store.load()).toEqual({ port: 9001, token: "tok", styleId: "ieee" });
      // Migration rewrites the record: the legacy fields leave localStorage.
      expect(JSON.parse(kv.dump()!)).toEqual({ port: 9001, token: "tok", styleId: "ieee" });
    });

    it("a legacy-only record falls back to defaults and is rewritten", () => {
      const kv = memoryKV(JSON.stringify({ serverUrl: "https://old.example", apiKey: "old-key" }));
      expect(createSettingsStore(kv).load()).toEqual({ port: 8474, token: "", styleId: "apa" });
      expect(JSON.parse(kv.dump()!)).toEqual({ port: 8474, token: "", styleId: "apa" });
    });

    it("a canonical record is not rewritten (no spurious writes)", () => {
      const kv = memoryKV(JSON.stringify({ port: 9001, token: "tok", styleId: "apa" }));
      createSettingsStore(kv).load();
      expect(JSON.parse(kv.dump()!)).toEqual({ port: 9001, token: "tok", styleId: "apa" });
    });
  });

  it("save merges onto stored state and clear resets to defaults", () => {
    const kv = memoryKV();
    const s = createSettingsStore(kv);
    s.save({ styleId: "mla" });
    expect(s.save({ port: 9001 })).toEqual({ port: 9001, token: "", styleId: "mla" });
    s.clear();
    expect(s.load()).toEqual({ port: 8474, token: "", styleId: "apa" });
    expect(JSON.parse(kv.dump()!)).toEqual({ port: 8474, token: "", styleId: "apa" });
  });
});
