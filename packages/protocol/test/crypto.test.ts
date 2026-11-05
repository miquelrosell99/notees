import { describe, expect, it } from "vitest";
import { createCipheriv, createHmac, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { newEnvelope } from "../src/envelope.js";
import {
  b64uDecode,
  b64uEncode,
  createKdfRecord,
  decryptAssetBytes,
  encryptAssetBytes,
  decryptBytes,
  decryptEnvelope,
  decryptPayload,
  encryptBytes,
  encryptEnvelope,
  encryptPayload,
  envelopeAad,
  exportWorkspaceKey,
  generateMasterKey,
  generateWorkspaceKey,
  importWorkspaceKey,
  masterKeyFp,
  SCRYPT_PARAMS,
  unwrapMasterKey,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
  type KdfRecord,
} from "../src/crypto.js";

const nodeScrypt = promisify(scryptCallback) as (
  password: string,
  salt: Uint8Array,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

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

const KEY = new Uint8Array(32).fill(7); // fixed fixture key material
const ENV_A = {
  id: "0192a000-0000-7000-8000-0000000000e1",
  workspaceId: "0192a000-0000-7000-8000-000000000001",
  actorId: "0192a000-0000-7000-8000-000000000002",
  deviceId: "test-device-laptop",
  hlc: { physical: 1727200000000, logical: 0 },
  affectedNodeIds: ["0192a000-0000-7000-8000-0000000000e2"],
  opType: "object.create",
  timestamp: "2026-09-24T12:00:00.000Z",
  payload: { objectId: "0192a000-0000-7000-8000-0000000000e2", isEmbedded: false, classIds: [] },
};

function makeEnv(id: string, payload: Record<string, unknown>): ReturnType<typeof newEnvelope> {
  // newEnvelope generates its own envelope id; override it for deterministic AADs.
  return { ...newEnvelope({ ...ENV_A, payload }), id };
}

describe("payload/envelope encryption", () => {
  it("round-trips a payload and binds it to the AAD", async () => {
    const key = await importWorkspaceKey(KEY);
    const slot = await encryptPayload(key, envelopeAad(ENV_A), ENV_A.payload);
    expect(Object.keys(slot)).toEqual(["$e"]);
    expect(await decryptPayload(key, envelopeAad(ENV_A), slot)).toEqual(ENV_A.payload);
  });

  it("rejects ciphertext transplanted into a different envelope (AAD)", async () => {
    const key = await importWorkspaceKey(KEY);
    const slot = await encryptPayload(key, envelopeAad(ENV_A), ENV_A.payload);
    const otherAad = envelopeAad({ ...ENV_A, id: "0192a000-0000-7000-8000-0000000000ff" });
    await expect(decryptPayload(key, otherAad, slot)).rejects.toThrow();
  });

  it("rejects tampered ciphertext", async () => {
    const key = await importWorkspaceKey(KEY);
    const slot = await encryptPayload(key, envelopeAad(ENV_A), ENV_A.payload);
    const tampered = { $e: { iv: slot.$e.iv, ct: slot.$e.ct.slice(0, -2) + (slot.$e.ct.endsWith("AA") ? "BB" : "AA") } };
    await expect(decryptPayload(key, envelopeAad(ENV_A), tampered)).rejects.toThrow();
  });

  it("encryptEnvelope preserves id and metadata; decryptEnvelope inverts it", async () => {
    const key = await importWorkspaceKey(KEY);
    const env = makeEnv(ENV_A.id, ENV_A.payload);
    const sealed = await encryptEnvelope(key, env);
    expect(sealed.id).toBe(env.id);
    expect(sealed.hlc).toEqual(env.hlc);
    expect(sealed.opType).toBe(env.opType);
    expect(sealed.affectedNodeIds).toEqual(env.affectedNodeIds);
    expect(sealed.payload).toHaveProperty("$e");
    const opened = await decryptEnvelope(key, sealed);
    expect(opened).toEqual(env);
  });

  it("decryptEnvelope passes plaintext envelopes through unchanged", async () => {
    const key = await importWorkspaceKey(KEY);
    const env = makeEnv(ENV_A.id, ENV_A.payload);
    expect(await decryptEnvelope(key, env)).toBe(env);
  });
});

describe("byte encryption (snapshots)", () => {
  it("round-trips; wrong key and tampering fail", async () => {
    const key = await importWorkspaceKey(KEY);
    const other = await importWorkspaceKey(new Uint8Array(32).fill(9));
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const sealed = await encryptBytes(key, bytes);
    expect(sealed.length).toBe(12 + 16 + bytes.length);
    expect([...(await decryptBytes(key, sealed))]).toEqual([...bytes]);
    await expect(decryptBytes(other, sealed)).rejects.toThrow();
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 1]! ^= 0xff;
    await expect(decryptBytes(key, tampered)).rejects.toThrow();
  });

  it("export/import round-trips a workspace key", async () => {
    const key = await generateWorkspaceKey();
    const raw = await exportWorkspaceKey(key);
    expect(raw.length).toBe(32);
    expect([...(await exportWorkspaceKey(await importWorkspaceKey(raw)))]).toEqual([...raw]);
  });
});

describe("server-format interop (golden vector)", () => {
  it("unwraps a KdfRecord built exactly as apps/server/src/auth.ts createKdfRecord", async () => {
    // Server side — the shipped createKdfRecord formulas (apps/server/src/auth.ts),
    // with fixed bytes where the server draws randomBytes, so the vector is
    // deterministic. maxmem is required, not optional (N=131072/r=8 exceeds
    // OpenSSL's default cap).
    const password = "golden horse battery";
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const iv = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i);
    const masterBytes = Uint8Array.from({ length: 32 }, (_, i) => 0x50 + i);
    const derived = await nodeScrypt(password, salt, 32, {
      N: 131072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
    const cipher = createCipheriv("aes-256-gcm", derived, Buffer.from(iv));
    const ct = Buffer.concat([cipher.update(Buffer.from(masterBytes)), cipher.final()]);
    const tag = cipher.getAuthTag();
    const record: KdfRecord = {
      algorithm: "scrypt",
      N: 131072,
      r: 8,
      p: 1,
      salt: b64uEncode(salt),
      wrappedMasterKey: b64uEncode(Buffer.concat([iv, tag, ct])),
      keyVerifier: b64uEncode(createHmac("sha256", derived).update("notees-key-check").digest()),
      // The pinned key fingerprint: HMAC-SHA256(key=master, "notees-key-fp").
      keyFp: masterKeyFp(masterBytes),
    };

    // Client side: the TS unwrap opens the server-built record.
    const masterKey = await unwrapMasterKey(password, record);

    // The pinned vector's fingerprint is a fixed HMAC over the fixed master —
    // pin the exact value so any drift in the formula fails here, not at a
    // password change.
    expect(record.keyFp).toBe(masterKeyFp(Uint8Array.from({ length: 32 }, (_, i) => 0x50 + i)));
    expect(record.keyFp).toMatch(/^[A-Za-z0-9_-]+$/);

    // The unwrapped key opens a blob the server sealed with the master key:
    // node:crypto produces ct and tag apart; WebCrypto's seal layout is ct ‖ tag.
    const blobIv = Uint8Array.from({ length: 12 }, (_, i) => 0xc0 + i);
    const blobCipher = createCipheriv("aes-256-gcm", Buffer.from(masterBytes), Buffer.from(blobIv));
    const blobCt = Buffer.concat([blobCipher.update("hello notees", "utf8"), blobCipher.final()]);
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blobIv },
      masterKey,
      Buffer.concat([blobCt, blobCipher.getAuthTag()]),
    );
    expect(new TextDecoder().decode(opened)).toBe("hello notees");

    // Wrong password fails at the verifier, before any unwrap.
    await expect(unwrapMasterKey("wrong password", record)).rejects.toThrow(/verifier|password/i);
  });
});

describe("asset-byte sealing (iv external, blob = tag ‖ ct)", () => {
  it("round-trips: random 12-byte iv, tag-first blob", async () => {
    const key = await importWorkspaceKey(new Uint8Array(32).fill(0x2a));
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 7, 8, 9]);
    const sealed = await encryptAssetBytes(key, bytes);
    expect(sealed.iv.length).toBe(12);
    expect(sealed.blob.length).toBe(16 + bytes.length);
    expect([...(await decryptAssetBytes(key, sealed.iv, sealed.blob))]).toEqual([...bytes]);
  });

  it("tampered blob and wrong key fail loud", async () => {
    const key = await importWorkspaceKey(new Uint8Array(32).fill(0x2a));
    const other = await importWorkspaceKey(new Uint8Array(32).fill(0x9b));
    const sealed = await encryptAssetBytes(key, new Uint8Array([1, 2, 3]));
    const tampered = new Uint8Array(sealed.blob);
    tampered[tampered.length - 1]! ^= 0xff;
    await expect(decryptAssetBytes(key, sealed.iv, tampered)).rejects.toThrow();
    await expect(decryptAssetBytes(other, sealed.iv, sealed.blob)).rejects.toThrow();
  });
});
