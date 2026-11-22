/**
 * Confidential-share crypto tests — the password-sealed READ half of
 * confidential sharing (proposal §3.3): scrypt → AES-GCM with the plan-08
 * iv‖tag‖ct layout, round-tripped in-browser; a wrong password fails GCM
 * auth (throws), never a partial render.
 */

import { describe, expect, it } from "vitest";

import {
  CONFIDENTIAL_KDF,
  openConfidentialArtifact,
  sealConfidentialHtml,
} from "../src/features/sharing/confidentialCrypto.js";

const HTML = new TextEncoder().encode("<!DOCTYPE html><title>Proyecto</title><p>hola</p>");

// The full scrypt params (N=2^17) are too slow for a unit test — the
// round-trip pins the FORMAT with a light factor; the params themselves are
// carried in the kdf record verbatim.
const FAST_KDF = { algorithm: "scrypt", N: 16384, r: 8, p: 1 } as const;

describe("confidential-share crypto", () => {
  it("seals under a password and opens with the same password", async () => {
    const sealed = await sealConfidentialHtml(HTML, "correct horse", FAST_KDF);
    expect(sealed.salt.length).toBeGreaterThan(0);
    expect(sealed.kdf).toEqual(FAST_KDF);
    const opened = await openConfidentialArtifact(sealed.artifact, "correct horse", sealed.salt, sealed.kdf);
    expect(new TextDecoder().decode(opened)).toBe(new TextDecoder().decode(HTML));
  });

  it("a wrong password fails GCM auth — throws, never a partial render", async () => {
    const sealed = await sealConfidentialHtml(HTML, "right", FAST_KDF);
    await expect(openConfidentialArtifact(sealed.artifact, "wrong", sealed.salt, sealed.kdf)).rejects.toThrow();
  });

  it("different passwords with the same salt derive different keys (the salt is not the secret)", async () => {
    const a = await sealConfidentialHtml(HTML, "one", FAST_KDF);
    const b = await sealConfidentialHtml(HTML, "two", FAST_KDF);
    expect(a.artifact).not.toBe(b.artifact);
    await expect(openConfidentialArtifact(a.artifact, "two", a.salt, a.kdf)).rejects.toThrow();
  });

  it("the minting defaults pin the account-KDF scrypt triple", () => {
    expect(CONFIDENTIAL_KDF).toEqual({ algorithm: "scrypt", N: 131072, r: 8, p: 1 });
  });
});
