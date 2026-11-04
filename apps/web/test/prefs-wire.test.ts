// @vitest-environment node
/**
 * The prefs wire shape (plan 07): ONE opaque blob.
 *
 * - Keyless: the blob is the unwrapped JSON verbatim (self-host compat).
 * - Master key in memory: seal produces b64u(iv ‖ tag ‖ ct) ciphertext
 *   (opaque to the server); open decrypts it, falling back to the unwrapped
 *   form for rows written keyless (the transparent upgrade path).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { b64uDecode, createKdfRecord, generateMasterKey } from "@notees/protocol";

import {
  clearCryptoCustody,
  deriveMasterKey,
} from "../src/core/crypto-custody.js";
import {
  openPrefsBlob,
  parsePrefsWire,
  sealPrefsBlob,
  serializePrefs,
} from "../src/core/prefs-wire.js";

const PASSWORD = "correct horse battery staple";

async function masterInMemory(): Promise<void> {
  const master = await generateMasterKey();
  await deriveMasterKey(PASSWORD, await createKdfRecord(master, PASSWORD));
}

const PREFS = {
  favorites: ["0192a000-0000-7000-8000-0000000000a1"],
  recents: [],
  cardsAlgorithm: "fsrs" as const,
  adsApiToken: "ads-token",
};

afterEach(() => {
  clearCryptoCustody();
  vi.unstubAllGlobals();
});

describe("prefs wire blob", () => {
  it("keyless: seal is the unwrapped JSON verbatim; open passes it through", async () => {
    const serialized = serializePrefs(PREFS);
    const blob = await sealPrefsBlob(serialized);
    expect(blob).toBe(serialized);
    expect(await openPrefsBlob(blob)).toBe(serialized);
    expect(parsePrefsWire(await openPrefsBlob(blob))).toEqual(PREFS);
  });

  it("keyed: seal produces ciphertext (no plaintext leak); open round-trips", async () => {
    await masterInMemory();
    const serialized = serializePrefs(PREFS);
    const blob = await sealPrefsBlob(serialized);
    expect(blob).not.toBe(serialized);
    expect(blob).not.toContain("ads-token");
    // b64u-decodes to iv(12) ‖ tag(16) ‖ ct (> 0).
    expect(b64uDecode(blob).length).toBeGreaterThan(28);
    expect(parsePrefsWire(await openPrefsBlob(blob))).toEqual(PREFS);
  });

  it("keyed open falls back to the unwrapped form (a row written keyless upgrades transparently)", async () => {
    await masterInMemory();
    const legacy = serializePrefs(PREFS); // written while keyless
    expect(await openPrefsBlob(legacy)).toBe(legacy);
    expect(parsePrefsWire(await openPrefsBlob(legacy))).toEqual(PREFS);
  });

  it("a blob sealed under a DIFFERENT account does not open (wrong master → not valid plaintext)", async () => {
    await masterInMemory();
    const sealed = await sealPrefsBlob(serializePrefs(PREFS));
    clearCryptoCustody();
    const other = await generateMasterKey();
    await deriveMasterKey("other-password-1", await createKdfRecord(other, "other-password-1"));
    const opened = await openPrefsBlob(sealed);
    // Decrypt fails → the blob comes back verbatim (opaque garbage to the
    // wrong account, never silently misparsed).
    expect(opened).toBe(sealed);
    expect(() => parsePrefsWire(sealed)).not.toThrow();
  });
});
