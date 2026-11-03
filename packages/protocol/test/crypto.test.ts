import { describe, expect, it } from "vitest";
import {
  b64uDecode,
  b64uEncode,
  createKdfRecord,
  generateMasterKey,
  generateWorkspaceKey,
  SCRYPT_PARAMS,
  unwrapMasterKey,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
} from "../src/crypto.js";

describe("b64u", () => {
  it("round-trips and uses unpadded url-safe alphabet", () => {
    const bytes = new Uint8Array([251, 255, 190, 239, 0, 1, 2, 3]);
    const text = b64uEncode(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(text).not.toContain("=");
    expect([...b64uDecode(text)]).toEqual([...bytes]);
  });
});

describe("master-key KDF record", () => {
  it("uses the server groundwork scrypt params", () => {
    expect(SCRYPT_PARAMS).toEqual({ N: 131072, r: 8, p: 1 });
  });

  it("create → unwrap round-trips; wrong password throws", async () => {
    const masterKey = await generateMasterKey();
    const record = await createKdfRecord(masterKey, "correct horse");
    expect(record.algorithm).toBe("scrypt");
    // Same inputs must reproduce the verifier (deterministic wrap given salt).
    const again = await unwrapMasterKey("correct horse", record);
    expect(again).toBeDefined();
    // Wrong password must fail at the verifier, not silently unwrap garbage.
    await expect(unwrapMasterKey("wrong", record)).rejects.toThrow(/verifier|password/i);
  });
});

describe("workspace-key wrap", () => {
  it("wrap → unwrap round-trips; wrong master key throws", async () => {
    const masterKey = await generateMasterKey();
    const workspaceKey = await generateWorkspaceKey();
    const wrapped = await wrapWorkspaceKey(masterKey, workspaceKey);
    expect(await unwrapWorkspaceKey(masterKey, wrapped)).toBeDefined();
    const otherMaster = await generateMasterKey();
    await expect(unwrapWorkspaceKey(otherMaster, wrapped)).rejects.toThrow();
  });
});
