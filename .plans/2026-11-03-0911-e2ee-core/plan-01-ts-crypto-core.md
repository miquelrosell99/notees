# E2EE core — Plan 01: TS crypto core implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Notees E2EE crypto core: envelope/payload/snapshot encryption primitives in `@notees/protocol`, the `EnvelopeCrypto` boundary in `@notees/sync` (wire + relay + snapshots ciphertext), and the canonical encrypted-payload fixture extending the lockstep corpus.

**Architecture:** No wire changes — the `{"$e": {iv, ct}}` slot has been schema-reserved since envelope v2 (`packages/protocol/src/envelope.ts:35-46`). This plan adds a WebCrypto-based crypto module to `@notees/protocol` (scrypt KDF via `@noble/hashes`, since WebCrypto has no scrypt), a `keyCryptoProvider(workspaceKey)` adapter in `@notees/sync`, and engine wiring that encrypts at the push boundary, decrypts before remote apply, and seals snapshot blobs. The canonical fixture `envelope-encrypted.json` extends the protocol gate with encrypted-payload assertions (decrypt + payload-schema proof). See spec §2 amendment: the durable local op log stays plaintext on-device; the wire/relay/snapshots are ciphertext.

**Tech Stack:** TypeScript, Node 22 (global `crypto.subtle`), `@noble/hashes@^1.8.0` (pinned v1 — known subpath layout), zod, vitest. No other new dependencies.

**Spec:** `.plans/2026-11-03-0911-e2ee-core/design.md` (read it first; this plan implements §1, §2, §5 (envelope half), §7).

## Global Constraints

- Repo laws from `AGENTS.md`: the fixture gate is the lockstep corpus — fixtures are byte-identical contracts with the GTK/Flutter ports; fail-loud validation; TDD; per-file staging only (never `git add -A`); Conventional Commits; `CHANGELOG.md` entry per shipped slice.
- **Dev-condition exports**: vitest reads `src` (the `development` export condition), `tsc` reads `dist`. After changing `@notees/protocol`'s public API, run `pnpm --filter @notees/protocol build` before typechecking/testing dependents.
- Envelope ids are identity: `encryptEnvelope` must preserve id, HLC, and all metadata; only `payload` changes.
- GCM additional authenticated data (AAD) = `` `${envelope.id}.${envelope.workspaceId}` `` — ciphertext cannot be transplanted across envelopes or workspaces.
- `decryptEnvelope` passes plaintext envelopes through unchanged (mixed plaintext/ciphertext logs exist during migration).
- Encryption formats match the server groundwork in `apps/server/src/auth.ts:42-49`: `wrappedMasterKey` = base64url(`iv(12) ‖ tag(16) ‖ ct`); `keyVerifier` = base64url(HMAC-SHA256(key, "notees-key-check")).
- All ciphertext base64url (`b64u`) encoded; no padding; `-`/`_` alphabet.
- Existing tests must stay green: `pnpm test` at repo root is the blocking gate.
- Other agent sessions work in this repo — never revert/modify files outside this plan's file list; stage only the files you changed.

## Review Focus

1. **Tampered or wrong-key ciphertext must throw, never apply garbage** — GCM auth failure on payload decrypt and on snapshot decrypt pins (Task 2, Task 6).
2. **AAD transplant across envelopes** — swapping the `ct` of two envelopes in the same workspace must fail decryption (Task 2).
3. **Envelope id stability across encryption** — ack/idempotency key on envelope id; `encryptEnvelope` preserving id is pinned (Task 2).
4. **Engine internals that read payloads** (`packages/sync/src/conflicts.ts`, `change-info.ts`) must only ever see plaintext — remote decrypt-before-apply pins structural classification and conflict detection under crypto (Task 6).
5. **Snapshot paths under crypto** — upload must not take the plaintext streaming path; download must decrypt before `restoreAsync`; a corrupted/tampered snapshot fails the pull with a clear error (Task 6).

---

### Task 1: `@noble/hashes` + base64url + key KDF/wrap primitives

**Files:**
- Modify: `packages/protocol/package.json` (dependencies)
- Create: `packages/protocol/src/crypto.ts`
- Create: `packages/protocol/test/crypto.test.ts`
- Modify: `packages/protocol/src/index.ts` (add export)

**Interfaces:**
- Consumes: server-side record shapes in `apps/server/src/auth.ts:42-49,304-349` (read for format parity; do not modify).
- Produces (used by Task 2, 3, 5, 6):
```ts
export function b64uEncode(bytes: Uint8Array): string;
export function b64uDecode(text: string): Uint8Array;
export interface KdfRecord {
  algorithm: "scrypt";
  N: number; r: number; p: number;
  salt: string;             // b64u
  wrappedMasterKey: string; // b64u(iv ‖ tag ‖ ct)
  keyVerifier: string;      // b64u(HMAC-SHA256(key, "notees-key-check"))
}
export const SCRYPT_PARAMS: { N: number; r: number; p: number }; // { 131072, 8, 1 }
export function generateMasterKey(): Promise<CryptoKey>;
export function createKdfRecord(masterKey: CryptoKey, password: string): Promise<KdfRecord>;
export function unwrapMasterKey(password: string, record: KdfRecord): Promise<CryptoKey>; // throws on verifier mismatch
export function generateWorkspaceKey(): Promise<CryptoKey>;
export function wrapWorkspaceKey(masterKey: CryptoKey, workspaceKey: CryptoKey): Promise<string>; // b64u(iv ‖ tag ‖ ct)
export function unwrapWorkspaceKey(masterKey: CryptoKey, wrapped: string): Promise<CryptoKey>;
```

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/test/crypto.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @notees/protocol test`
Expected: FAIL — `../src/crypto.js` does not exist.

- [ ] **Step 3: Implement**

Add the dependency (pin v1 for the known subpath layout):

```bash
pnpm --filter @notees/protocol add @noble/hashes@^1.8.0
```

Create `packages/protocol/src/crypto.ts`:

```ts
/**
 * E2EE crypto primitives (client side). WebCrypto for AES-GCM; @noble/hashes
 * for scrypt/HMAC/SHA-256 (WebCrypto has no scrypt). Formats match the
 * server-side groundwork in apps/server/src/auth.ts: wrapped keys and
 * verifiers are base64url(iv ‖ tag ‖ ct) / base64url(HMAC-SHA256(...)).
 * Ports: GTK (cryptography), Flutter (Dart) — keep this file dependency-thin
 * and side-effect free; it is the reference for the lockstep corpus.
 */

import { hmac } from "@noble/hashes/hmac";
import { scrypt } from "@noble/hashes/scrypt";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToUtf8, utf8ToBytes } from "@noble/hashes/utils";

export const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1 } as const;

// --- base64url -----------------------------------------------------------------

export function b64uEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- small helpers ---------------------------------------------------------------

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function importAesKey(bytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, usages);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** WebCrypto returns ct ‖ tag(16); the wire format (auth.ts) is iv ‖ tag ‖ ct. */
function splitCtTag(sealed: Uint8Array): { ct: Uint8Array; tag: Uint8Array } {
  return { ct: sealed.slice(0, sealed.length - 16), tag: sealed.slice(sealed.length - 16) };
}

/** iv ‖ tag ‖ ct, matching the server groundwork in apps/server/src/auth.ts. */
function joinIvTagCt(iv: Uint8Array, tag: Uint8Array, ct: Uint8Array): Uint8Array {
  const out = new Uint8Array(iv.length + tag.length + ct.length);
  out.set(iv, 0);
  out.set(tag, iv.length);
  out.set(ct, iv.length + tag.length);
  return out;
}

/** Inverse of joinIvTagCt: WebCrypto's unwrap wants the seal back as ct ‖ tag. */
function ivTagCtToSealed(raw: Uint8Array): { iv: Uint8Array; sealed: Uint8Array } {
  const iv = raw.slice(0, 12);
  const tag = raw.slice(12, 28);
  const ct = raw.slice(28);
  const sealed = new Uint8Array(ct.length + tag.length);
  sealed.set(ct, 0);
  sealed.set(tag, ct.length);
  return { iv, sealed };
}

/** keyVerifier parity with auth.ts: HMAC-SHA256(passwordDerivedKey, "notees-key-check"). */
function keyVerifierOf(derivedKeyBytes: Uint8Array): Uint8Array {
  return hmac(sha256, derivedKeyBytes, utf8ToBytes("notees-key-check"));
}

// --- master key (password-wrapped, Standard-Notes-style record) ---------------------

export interface KdfRecord {
  algorithm: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  wrappedMasterKey: string;
  keyVerifier: string;
}

function scryptKeyBytes(password: string, salt: Uint8Array): Uint8Array {
  return scrypt(utf8ToBytes(password), salt, { ...SCRYPT_PARAMS, dkLen: 32 });
}

export function generateMasterKey(): Promise<CryptoKey> {
  // extractable: WebCrypto wrapKey exports the key being wrapped, so the
  // master key must be extractable even though we never call exportKey on it.
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
    "wrapKey",
    "unwrapKey",
  ]);
}

export async function createKdfRecord(
  masterKey: CryptoKey,
  password: string,
): Promise<KdfRecord> {
  const salt = randomBytes(16);
  const wrapKeyBytes = scryptKeyBytes(password, salt);
  const wrapKey = await importAesKey(wrapKeyBytes, ["wrapKey", "unwrapKey"]);
  const iv = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.wrapKey("raw", masterKey, wrapKey, { name: "AES-GCM", iv: iv as BufferSource }),
  );
  const { ct, tag } = splitCtTag(sealed);
  return {
    algorithm: "scrypt",
    ...SCRYPT_PARAMS,
    salt: b64uEncode(salt),
    wrappedMasterKey: b64uEncode(joinIvTagCt(iv, tag, ct)),
    keyVerifier: b64uEncode(keyVerifierOf(wrapKeyBytes)),
  };
}

export async function unwrapMasterKey(password: string, record: KdfRecord): Promise<CryptoKey> {
  const salt = b64uDecode(record.salt);
  const wrapKeyBytes = scryptKeyBytes(password, salt);
  // Fail fast on a wrong password: the verifier is over the derived key, so
  // it is checkable before attempting the unwrap.
  if (!constantTimeEqual(keyVerifierOf(wrapKeyBytes), b64uDecode(record.keyVerifier))) {
    throw new Error("master-key verifier mismatch (wrong password)");
  }
  const wrapKey = await importAesKey(wrapKeyBytes, ["wrapKey", "unwrapKey"]);
  const { iv, sealed } = ivTagCtToSealed(b64uDecode(record.wrappedMasterKey));
  return crypto.subtle.unwrapKey(
    "raw",
    sealed as BufferSource,
    wrapKey,
    { name: "AES-GCM", iv: iv as BufferSource },
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
  );
}

// --- workspace keys (master-key-wrapped) ---------------------------------------------

export function generateWorkspaceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function wrapWorkspaceKey(
  masterKey: CryptoKey,
  workspaceKey: CryptoKey,
): Promise<string> {
  const iv = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.wrapKey("raw", workspaceKey, masterKey, { name: "AES-GCM", iv: iv as BufferSource }),
  );
  const { ct, tag } = splitCtTag(sealed);
  return b64uEncode(joinIvTagCt(iv, tag, ct));
}

export async function unwrapWorkspaceKey(
  masterKey: CryptoKey,
  wrapped: string,
): Promise<CryptoKey> {
  const { iv, sealed } = ivTagCtToSealed(b64uDecode(wrapped));
  return crypto.subtle.unwrapKey(
    "raw",
    sealed as BufferSource,
    masterKey,
    { name: "AES-GCM", iv: iv as BufferSource },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}
```

Note: the verifier is HMAC-SHA256 over the scrypt-derived wrap key (auth.ts parity — a wrong password fails the verifier check before the unwrap is attempted), so no `exportKey` call exists anywhere. The master key is still generated `extractable: true` — not for the verifier but because WebCrypto `wrapKey` exports the key it wraps; the unwrapped master key in `unwrapMasterKey` is non-extractable (`false`).

Add the export to `packages/protocol/src/index.ts` (after the `plugin-manifest.js` line):

```ts
export * from "./crypto.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @notees/protocol test`
Expected: PASS (all protocol tests, including the new file).

- [ ] **Step 5: Build dist (dev-condition gate) and typecheck**

```bash
pnpm --filter @notees/protocol build && pnpm --filter @notees/protocol typecheck
```

Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/package.json packages/protocol/src/crypto.ts packages/protocol/src/index.ts packages/protocol/test/crypto.test.ts
git commit -m "feat(protocol): E2EE crypto primitives — b64u, scrypt KDF record, key wrap/unwrap"
```

---

### Task 2: Payload / envelope / snapshot-byte encryption primitives

**Files:**
- Modify: `packages/protocol/src/crypto.ts` (append)
- Modify: `packages/protocol/test/crypto.test.ts` (append)

**Interfaces:**
- Consumes: `Envelope` type and `isEncryptedPayload` from `./envelope.js`; Task 1 primitives.
- Produces (used by Tasks 3, 5, 6):
```ts
export function envelopeAad(envelope: { id: string; workspaceId: string }): string;
export interface EncryptedPayloadSlot { $e: { iv: string; ct: string } }
export function encryptPayload(workspaceKey: CryptoKey, aad: string, payload: Record<string, unknown>): Promise<EncryptedPayloadSlot>;
export function decryptPayload(workspaceKey: CryptoKey, aad: string, slot: EncryptedPayloadSlot): Promise<Record<string, unknown>>;
export function encryptEnvelope(workspaceKey: CryptoKey, envelope: Envelope): Promise<Envelope>;
export function decryptEnvelope(workspaceKey: CryptoKey, envelope: Envelope): Promise<Envelope>; // passthrough for plaintext payloads
export function encryptBytes(workspaceKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array>; // iv(12) ‖ tag(16) ‖ ct
export function decryptBytes(workspaceKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array>;
export function importWorkspaceKey(raw: Uint8Array): Promise<CryptoKey>;
export function exportWorkspaceKey(workspaceKey: CryptoKey): Promise<Uint8Array>;
```

- [ ] **Step 1: Write the failing test**

Append to `packages/protocol/test/crypto.test.ts`:

```ts
import { newEnvelope } from "../src/envelope.js";
import {
  decryptBytes,
  decryptEnvelope,
  decryptPayload,
  encryptBytes,
  encryptEnvelope,
  encryptPayload,
  envelopeAad,
  exportWorkspaceKey,
  importWorkspaceKey,
} from "../src/crypto.js";

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
  return newEnvelope({ ...ENV_A, id, payload });
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
    tampered[tampered.length - 1] ^= 0xff;
    await expect(decryptBytes(key, tampered)).rejects.toThrow();
  });

  it("export/import round-trips a workspace key", async () => {
    const key = await generateWorkspaceKey();
    const raw = await exportWorkspaceKey(key);
    expect(raw.length).toBe(32);
    expect([...(await exportWorkspaceKey(await importWorkspaceKey(raw)))]).toEqual([...raw]);
  });
});
```

Add `encryptPayload` etc. to the existing import from `../src/crypto.js` at the top of the test file instead of a second import block.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @notees/protocol test`
Expected: FAIL — `encryptPayload` / `encryptEnvelope` / `encryptBytes` are not exported.

- [ ] **Step 3: Implement**

Append to `packages/protocol/src/crypto.ts`:

```ts
// --- envelope payload encryption (the {"$e": {iv, ct}} slot) -------------------------

import { isEncryptedPayload, type Envelope } from "./envelope.js";

export interface EncryptedPayloadSlot {
  $e: { iv: string; ct: string };
}

/** GCM AAD binds ciphertext to its envelope: `${id}.${workspaceId}`. */
export function envelopeAad(envelope: { id: string; workspaceId: string }): string {
  return `${envelope.id}.${envelope.workspaceId}`;
}

export async function encryptPayload(
  workspaceKey: CryptoKey,
  aad: string,
  payload: Record<string, unknown>,
): Promise<EncryptedPayloadSlot> {
  const iv = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: utf8ToBytes(aad) as BufferSource },
      workspaceKey,
      utf8ToBytes(JSON.stringify(payload)) as BufferSource,
    ),
  );
  const { ct, tag } = splitCtTag(sealed);
  return { $e: { iv: b64uEncode(iv), ct: b64uEncode(joinIvTagCt(tag, ct)) } };
}

export async function decryptPayload(
  workspaceKey: CryptoKey,
  aad: string,
  slot: EncryptedPayloadSlot,
): Promise<Record<string, unknown>> {
  const iv = b64uDecode(slot.$e.iv);
  const raw = b64uDecode(slot.$e.ct);
  const tag = raw.slice(0, 16);
  const ct = raw.slice(16);
  const sealed = joinIvTagCt(ct, tag); // WebCrypto expects ct ‖ tag
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: utf8ToBytes(aad) as BufferSource },
      workspaceKey,
      sealed as BufferSource,
    ),
  );
  return JSON.parse(bytesToUtf8(plain)) as Record<string, unknown>;
}

/** Seal an envelope's payload; every other field (id, HLC, …) is preserved. */
export async function encryptEnvelope(workspaceKey: CryptoKey, envelope: Envelope): Promise<Envelope> {
  const slot = await encryptPayload(workspaceKey, envelopeAad(envelope), envelope.payload as Record<string, unknown>);
  return { ...envelope, payload: slot };
}

/** Open an envelope's payload; plaintext envelopes pass through unchanged. */
export async function decryptEnvelope(workspaceKey: CryptoKey, envelope: Envelope): Promise<Envelope> {
  if (!isEncryptedPayload(envelope.payload)) return envelope;
  const payload = await decryptPayload(workspaceKey, envelopeAad(envelope), envelope.payload);
  return { ...envelope, payload };
}

// --- byte encryption (snapshot blobs) --------------------------------------------------

export async function encryptBytes(workspaceKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, workspaceKey, bytes as BufferSource),
  );
  return joinIvTagCt(iv, sealed); // iv ‖ tag ‖ ct
}

export async function decryptBytes(workspaceKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  const iv = bytes.slice(0, 12);
  const sealed = bytes.slice(12); // tag ‖ ct — already the WebCrypto layout
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, workspaceKey, sealed as BufferSource),
  );
}

export function importWorkspaceKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export function exportWorkspaceKey(workspaceKey: CryptoKey): Promise<Uint8Array> {
  return crypto.subtle.exportKey("raw", workspaceKey).then((buf) => new Uint8Array(buf));
}
```

Move the `import { isEncryptedPayload, type Envelope } from "./envelope.js";` to the top of the file with the other imports (keep one import block; the plan shows it inline for placement clarity).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @notees/protocol test`
Expected: PASS.

- [ ] **Step 5: Build + typecheck**

```bash
pnpm --filter @notees/protocol build && pnpm --filter @notees/protocol typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/crypto.ts packages/protocol/test/crypto.test.ts
git commit -m "feat(protocol): envelope/payload/snapshot encryption with AAD binding"
```

---

### Task 3: Canonical encrypted fixture + protocol gate branch

**Files:**
- Create: `packages/protocol/fixtures/envelope-encrypted.json` (generated)
- Modify: `packages/protocol/test/protocol.test.ts:45-98` (fixture count), `:100-117` (gate branch)

**Interfaces:**
- Consumes: Task 2 primitives (`importWorkspaceKey`, `decryptEnvelope`); `payloadSchemaFor`, `KNOWN_OP_TYPES` (existing gate).
- Produces: `envelope-encrypted.json` — the lockstep contract for GTK/Flutter ports. Shape:
```jsonc
{
  "comment": "…",
  "crypto": { "version": 1, "aad": "envelope.id.envelope.workspaceId", "workspaceKey": "<b64u 32 bytes>" },
  "envelopes": [ /* envelopes whose payload is the $e slot */ ]
}
```

- [ ] **Step 1: Generate the fixture (deterministic, one-time)**

Build first so the generator can import `dist`: `pnpm --filter @notees/protocol build`.

Then create a throwaway generator at `/tmp/gen-enc-fixture.mjs` and run it with `node`:

```js
import { writeFileSync } from "node:fs";
import {
  b64uEncode,
  encryptEnvelope,
  importWorkspaceKey,
} from "/root/projects/notees/packages/protocol/dist/index.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const NODE = "0192a000-0000-7000-8000-0000000000e2"; // dedicated ids — no other fixture touches 0e2/0e3
const keyBytes = new Uint8Array(32).fill(0x5a);
const key = await importWorkspaceKey(keyBytes);

function env(id, physical, opType, affected, payload) {
  return {
    id, protocolVersion: 3, workspaceId: WS, actorId: ACTOR,
    deviceId: "test-device-laptop",
    hlc: { physical, logical: 0 },
    affectedNodeIds: affected, opType,
    timestamp: new Date(physical).toISOString(),
    payload,
  };
}

const envelopes = [
  await encryptEnvelope(key, env(
    "0192a000-0000-7000-8000-0000000000e0", 1727200000000, "object.create", [NODE],
    { objectId: NODE, contentAst: [{ type: "text", text: "Encrypted fixture page" }], isEmbedded: false, classIds: [] },
  )),
  await encryptEnvelope(key, env(
    "0192a000-0000-7000-8000-0000000000e1", 1727200001000, "object.update", [NODE],
    { objectId: NODE, icon: "book" },
  )),
];

writeFileSync(
  "/root/projects/notees/packages/protocol/fixtures/envelope-encrypted.json",
  JSON.stringify({
    comment: "Encrypted-payload fixture (E2EE core): payloads carry the $e slot; `crypto.workspaceKey` (b64u 32 bytes, public test key) opens them. AAD = `${envelope.id}.${envelope.workspaceId}`. GTK/Flutter ports must replay this byte-identical: decrypt each envelope, apply the plaintext payloads. Decrypted payloads MUST validate against payloadSchemaFor(opType) — the gate asserts it.",
    crypto: { version: 1, aad: "envelope.id.envelope.workspaceId", workspaceKey: b64uEncode(keyBytes) },
    envelopes,
  }, null, 2) + "\n",
);
console.log("wrote envelope-encrypted.json");
```

Run: `node /tmp/gen-enc-fixture.mjs`
Verify: `cat packages/protocol/fixtures/envelope-encrypted.json` — two envelopes, both `payload.$e`.

Note: AES-GCM seals are deterministic given (key, iv, aad, plaintext) but iv is random per call — the committed file is the contract; the generator exists only to produce it (do not commit the generator).

- [ ] **Step 2: Write the failing gate test**

In `packages/protocol/test/protocol.test.ts`:

1. Add `"envelope-encrypted.json",` to the expected-names array in the count test, between `"embed-ref-view.json"` and `"envelope-minimal.json"` (alphabetical), and change the test title to `forty-nine`.
2. In the per-envelope gate loop, replace the `it("envelope ${i} has a known opType and a valid payload", …)` body with a branch:

```ts
it(`envelope ${i} has a known opType and a valid payload`, async () => {
  const opType = raw.opType as string;
  expect(KNOWN_OP_TYPES).toContain(opType);
  const schema = payloadSchemaFor(opType);
  expect(schema).toBeDefined();
  if (isEncryptedPayload(raw.payload)) {
    // E2EE payloads are opaque on the wire: assert the slot shape, then prove
    // the fixture's key opens a payload that DOES satisfy the op schema
    // (the lockstep contract for GTK/Flutter decrypt-and-replay).
    const cryptoBlock = (fixture as { crypto?: { workspaceKey: string } }).crypto;
    expect(cryptoBlock, `${fixture.name} carries its workspace key`).toBeDefined();
    const key = await importWorkspaceKey(b64uDecode(cryptoBlock!.workspaceKey));
    const opened = await decryptEnvelope(key, envelopeSchema.parse(raw));
    expect(schema!.safeParse(opened.payload).success, JSON.stringify(schema!.safeParse(opened.payload).error?.issues, null, 2)).toBe(true);
  } else {
    const parsed = schema!.safeParse(raw.payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
  }
});
```

Add to the test file's `@notees`… imports (it imports from `../src/index.js`):
```ts
import { b64uDecode, decryptEnvelope, importWorkspaceKey, isEncryptedPayload } from "../src/crypto.js";
// isEncryptedPayload also re-exported from ../src/index.js — prefer the index import for it.
```

- [ ] **Step 3: Run test to verify behavior**

Run: `pnpm --filter @notees/protocol test`
Expected: the count test FAILS first (48 vs 49 — proving the fixture is seen); after the count fix, all PASS including the two new decrypt-and-validate assertions.

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/fixtures/envelope-encrypted.json packages/protocol/test/protocol.test.ts
git commit -m "feat(protocol): encrypted-payload canonical fixture with decrypt-and-validate gate"
```

---

### Task 4: Store suite harnesses decrypt the encrypted fixture

**Files:**
- Modify: `packages/store/test/store.test.ts:54-59` (`loadFixture`), and `allFixtureEnvelopes()` where defined (search the file; it flatMaps `FIXTURE_FILES` through `loadFixture`)
- Modify: `packages/store/test/property-elements.test.ts:781-786` (`loadFixture`) and the corpus replay at `:822-845`

**Interfaces:**
- Consumes: `decryptEnvelope`, `importWorkspaceKey`, `b64uDecode` from `@notees/protocol`; fixture `crypto` block.
- Produces: nothing new — existing replays now cover the encrypted fixture (decrypted before `applyMany`).

- [ ] **Step 1: Write the failing test**

No new test file — the existing corpus tests are the test. First demonstrate the failure: temporarily run

Run: `pnpm --filter @notees/store test`
Expected: FAIL — `envelope-encrypted.json` enters the all-fixtures replay and its `$e` payloads cannot apply (store quarantines/throws on unknown payload shapes), breaking `store.test.ts` fixture-replay and the `property-elements.test.ts` corpus-convergence tests.

- [ ] **Step 2: Implement the harness decryption**

In `packages/store/test/store.test.ts`, extend `loadFixture` (and make sure `allFixtureEnvelopes()` routes through it):

```ts
import { b64uDecode, decryptEnvelope, importWorkspaceKey, type Envelope } from "@notees/protocol";

/** Encrypted fixtures carry their (public, test-only) workspace key; the
 *  harness opens the envelopes before replay — same contract the GTK/Flutter
 *  ports implement natively. */
async function openFixtureEnvelopes(
  raw: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const envelopes = Array.isArray(raw.envelopes) ? raw.envelopes : [raw];
  const cryptoBlock = (raw as { crypto?: { workspaceKey: string } }).crypto;
  if (!cryptoBlock) return envelopes as Record<string, unknown>[];
  const key = await importWorkspaceKey(b64uDecode(cryptoBlock.workspaceKey));
  return Promise.all(
    (envelopes as Envelope[]).map((envelope) => decryptEnvelope(key, envelope) as Promise<Record<string, unknown>>),
  );
}
```

`loadFixture` becomes async and returns `openFixtureEnvelopes(raw)`. Update `allFixtureEnvelopes()` (and the `REPLAY_EXCLUDED_FIXTURES` filtering around it) to `await` each load — check how `allFixtureEnvelopes` is built (if it's a sync module-level const, make it an async function or pre-resolve with `beforeAll`; follow the existing call sites — there are several `store.applyMany(allFixtureEnvelopes())` calls, so an async helper called per test is simplest: `await allFixtureEnvelopes()`). `it(…, async () => { … })` where needed.

Apply the same change to `packages/store/test/property-elements.test.ts` — its local `loadFixture` plus the FORWARD_ONLY test (`it.each` — make the callback async and `await loadFixture(name)`) and the corpus replay test at `:822`.

- [ ] **Step 3: Run tests to verify they pass**

```bash
pnpm --filter @notees/protocol build && pnpm --filter @notees/store test
```
Expected: PASS — including "the whole corpus replays into all adapters" (now covering the encrypted fixture decrypted).

- [ ] **Step 4: Commit**

```bash
git add packages/store/test/store.test.ts packages/store/test/property-elements.test.ts
git commit -m "test(store): fixture harnesses open encrypted envelopes before replay"
```

---

### Task 5: `EnvelopeCrypto` boundary in the sync engine

**Files:**
- Modify: `packages/sync/src/types.ts` (add interface)
- Create: `packages/sync/src/crypto-provider.ts`
- Modify: `packages/sync/src/sync-engine.ts` (crypto field, push/applyRemote/snapshot paths, drainWsBuffer async)
- Modify: `packages/sync/src/index.ts` (export)
- Modify: `packages/sync/test/sync.test.ts` — no changes expected; existing tests must stay green (crypto is opt-in via options)

**Interfaces:**
- Consumes: Task 2 primitives from `@notees/protocol`.
- Produces:
```ts
// packages/sync/src/types.ts
export interface EnvelopeCrypto {
  encryptEnvelope(envelope: Envelope): Promise<Envelope>;
  decryptEnvelope(envelope: Envelope): Promise<Envelope>;
  encryptSnapshot(bytes: Uint8Array): Promise<Uint8Array>;
  decryptSnapshot(bytes: Uint8Array): Promise<Uint8Array>;
}
// packages/sync/src/crypto-provider.ts
export function keyCryptoProvider(workspaceKey: CryptoKey): EnvelopeCrypto;
// SyncEngine: options.crypto?: EnvelopeCrypto; setCrypto(provider: EnvelopeCrypto | null): void
```

- [ ] **Step 1: Write the failing test**

Create `packages/sync/test/crypto.test.ts` with the engine-level tests from Task 6 (write the full file now — see Task 6 for the complete code). Run it:

Run: `pnpm --filter @notees/sync test`
Expected: FAIL — `keyCryptoProvider` / `crypto` option do not exist.

- [ ] **Step 2: Implement the interface + provider**

In `packages/sync/src/types.ts` (where `SyncEngineCallbacks` lives), append:

```ts
/**
 * E2EE boundary (spec §2): encrypt at the push boundary, decrypt after
 * receive/before apply, seal snapshot blobs. The engine is key-agnostic —
 * the client owns custody and passes a provider (or null to disable).
 */
export interface EnvelopeCrypto {
  encryptEnvelope(envelope: Envelope): Promise<Envelope>;
  decryptEnvelope(envelope: Envelope): Promise<Envelope>;
  encryptSnapshot(bytes: Uint8Array): Promise<Uint8Array>;
  decryptSnapshot(bytes: Uint8Array): Promise<Uint8Array>;
}
```

Create `packages/sync/src/crypto-provider.ts`:

```ts
import { decryptBytes, decryptEnvelope, encryptBytes, encryptEnvelope } from "@notees/protocol";
import type { EnvelopeCrypto } from "./types.js";

/** An EnvelopeCrypto backed by a workspace key (WebCrypto CryptoKey). */
export function keyCryptoProvider(workspaceKey: CryptoKey): EnvelopeCrypto {
  return {
    encryptEnvelope: (envelope) => encryptEnvelope(workspaceKey, envelope),
    decryptEnvelope: (envelope) => decryptEnvelope(workspaceKey, envelope),
    encryptSnapshot: (bytes) => encryptBytes(workspaceKey, bytes),
    decryptSnapshot: (bytes) => decryptBytes(workspaceKey, bytes),
  };
}
```

Export both from `packages/sync/src/index.ts` (`export * from "./crypto-provider.js";` and ensure `types.js` is exported — check current exports; add `export type { EnvelopeCrypto } from "./types.js";` if types aren't already re-exported).

- [ ] **Step 3: Wire the engine**

In `packages/sync/src/sync-engine.ts`:

1. Import `type EnvelopeCrypto` from `./types.js`; add to `SyncEngineOptions`: `crypto?: EnvelopeCrypto;`.
2. Private field `private crypto: EnvelopeCrypto | null;` set in the constructor (`this.crypto = options.crypto ?? null;`); add `setCrypto(provider: EnvelopeCrypto | null): void { this.crypto = provider; }`.
3. `push()` — encrypt before send (the outbox stays plaintext in memory; wire gets ciphertext):

```ts
const wireEnvelopes = this.crypto
  ? await Promise.all(chunk.map((entry) => this.crypto!.encryptEnvelope(entry.envelope)))
  : chunk.map((entry) => entry.envelope);
await this.transport.sendBatch(wireEnvelopes);
```

4. `applyRemote` — make it `private async applyRemote(...)`; decrypt right after the ordering sort, before `applyMany`:

```ts
const ordered = /* existing sort */;
const plain = this.crypto
  ? await Promise.all(ordered.map((envelope) => this.crypto!.decryptEnvelope(envelope)))
  : ordered;
```
and use `plain` everywhere below (applyMany, summaries zip, detectConflicts, HLC loop, seq loop). Update the doc comment: decrypt-before-apply is what keeps conflict detection and change-info payload reads correct under crypto.

5. Call sites of `applyRemote`: in `pullInternal` — `const pageResult = await this.applyRemote(envelopes, null);`.

6. Snapshot download in `pullInternal`:

```ts
const data = await this.transport.getSnapshotData();
const bytes = this.crypto ? await this.decryptSnapshotOrThrow(data) : data;
await this.store.restoreAsync(bytes);
```

with:

```ts
private async decryptSnapshotOrThrow(data: Uint8Array): Promise<Uint8Array> {
  try {
    return await this.crypto!.decryptSnapshot(data);
  } catch (error) {
    throw new Error(
      `snapshot decryption failed: wrong workspace key or corrupted snapshot (${(error as Error).message})`,
    );
  }
}
```

7. Snapshot upload in `maybeUploadSnapshot`: when `this.crypto` is set, bypass the streaming path (it would upload plaintext) and upload the sealed buffered snapshot:

```ts
if (this.crypto) {
  const bytes = this.store.snapshot();
  const sealed = await this.crypto.encryptSnapshot(bytes);
  await upload(sealed, this.receivedHlc);
  this.uploadedSnapshotHlc = this.receivedHlc;
  this.snapshotOversizeReported = false;
  this.snapshotQuarantineReported = false;
  return;
}
```
Insert this block immediately after the `newerThanServer/newerThanUploaded` gate passes (reuse the existing size-guard: check `sealed.byteLength >= this.snapshotUploadLimit` with the same report-once latch pattern).

8. `drainWsBuffer` becomes `private async drainWsBuffer(): Promise<void>` — the body already calls `this.applyRemote(...)`; add `await`. Update the three call sites to fire-and-forget: `void this.drainWsBuffer();` (in `pull`'s `finally`, in `onRemoteBatch`, in `onHello`).

9. Header comment: update the "single-user: no E2EE decryption" line — the engine now supports an optional E2EE boundary; key custody lives in the client.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @notees/protocol build && pnpm --filter @notees/sync test
```
Expected: PASS — all existing sync tests (crypto opt-in leaves them unchanged) plus the new crypto tests from Step 1.

- [ ] **Step 5: Typecheck + full gate**

```bash
pnpm --filter @notees/sync typecheck && pnpm test
```
Expected: green across the repo (store harness changes included).

- [ ] **Step 6: Commit**

```bash
git add packages/sync/src/types.ts packages/sync/src/crypto-provider.ts packages/sync/src/sync-engine.ts packages/sync/src/index.ts packages/sync/test/crypto.test.ts
git commit -m "feat(sync): EnvelopeCrypto boundary — sealed wire/snapshots, decrypt-before-apply"
```

---

### Task 6: Engine crypto-mode tests (the full `crypto.test.ts` from Task 5 Step 1)

**Files:**
- Create: `packages/sync/test/crypto.test.ts`

**Interfaces:**
- Consumes: `keyCryptoProvider`, `SyncEngine`, `MemoryRelay`, `MemoryTransport` from `../src/index.js`; `importWorkspaceKey` from `@notees/protocol`; the `makeEnvelope`/`baseEnvelopes`/`makeDevice` patterns from `sync.test.ts` (copy the helpers into this file — tests must stand alone).

- [ ] **Step 1: Write the tests**

Create `packages/sync/test/crypto.test.ts`:

```ts
/**
 * E2EE boundary tests: the wire and relay see only $e payloads; the local
 * store converges on plaintext; conflict detection and structural
 * classification stay exact (decrypt-before-apply); snapshots are sealed on
 * upload and opened on download; tampering fails loud.
 */

import { describe, expect, it } from "vitest";

import { importWorkspaceKey, isEncryptedPayload, newEnvelope, type Envelope } from "@notees/protocol";
import { Store } from "@notees/store";

import {
  MemoryRelay,
  MemoryTransport,
  SyncEngine,
  keyCryptoProvider,
  type SyncConflict,
} from "../src/index.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const DEVICE_A = "device-a";
const DEVICE_B = "device-b";
const PARENT = "0192a000-0000-7000-8000-000000000010";
const NODE = "0192a000-0000-7000-8000-000000000011";
const NODE2 = "0192a000-0000-7000-8000-000000000012";
const T0 = 1_727_200_000_000;
const KEY_BYTES = new Uint8Array(32).fill(0x42);

function makeEnvelope(
  deviceId: string,
  physical: number,
  opType: string,
  payload: Record<string, unknown>,
): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId,
    hlc: { physical, logical: 0 },
    opType,
    payload,
    timestamp: new Date(physical).toISOString(),
  });
}

function baseEnvelopes(deviceId: string): Envelope[] {
  return [
    makeEnvelope(deviceId, T0 + 10, "object.create", {
      objectId: PARENT,
      contentAst: [{ type: "text", text: "Parent" }],
    }),
    makeEnvelope(deviceId, T0 + 20, "object.create", {
      objectId: NODE,
      parentId: PARENT,
      contentAst: [{ type: "text", text: "Node" }],
    }),
  ];
}

function titleOf(store: Store, id: string): string {
  const row = store.getNode(id);
  if (row === undefined) return "";
  const ast = JSON.parse(row.content) as Array<{ type?: string; text?: string }>;
  return ast.map((t) => t.text ?? "").join(" ");
}

interface Device {
  store: Store;
  engine: SyncEngine;
  relay: MemoryRelay;
}

async function makeCryptoDevice(relay: MemoryRelay, deviceId: string, now: () => number): Promise<Device> {
  const store = new Store();
  const key = await importWorkspaceKey(KEY_BYTES);
  const engine = new SyncEngine(store, new MemoryTransport(relay), new (await import("@notees/protocol")).Clock(deviceId), {
    workspaceId: WS,
    now,
    crypto: keyCryptoProvider(key),
  });
  return { store, engine, relay };
}

describe("E2EE sync boundary", () => {
  it("push sends only $e envelopes; the local store holds plaintext; ack drains", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const a = await makeCryptoDevice(relay, DEVICE_A, () => nowMs);

    for (const envelope of baseEnvelopes(DEVICE_A)) a.engine.enqueue(envelope);
    await a.engine.push();

    const sent = relay.envelopes(); // whatever the MemoryRelay exposes; see note below
    expect(sent.length).toBe(2);
    for (const envelope of sent) {
      expect(isEncryptedPayload(envelope.payload)).toBe(true);
      expect(envelope.id).toBeDefined(); // ids preserved on the wire
    }
    // Local projection is plaintext and correct.
    expect(titleOf(a.store, PARENT)).toBe("Parent");
    expect(a.engine.getOutboxCounts().pending).toBe(0);
  });

  it("pull decrypts before apply: second device converges; structural classification stays exact", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const a = await makeCryptoDevice(relay, DEVICE_A, () => nowMs);
    const b = await makeCryptoDevice(relay, DEVICE_B, () => nowMs);

    for (const envelope of baseEnvelopes(DEVICE_A)) a.engine.enqueue(envelope);
    // An object.update carrier (icon) — structural flag must survive encryption.
    a.engine.enqueue(makeEnvelope(DEVICE_A, T0 + 30, "object.update", { objectId: NODE, icon: "book" }));
    await a.engine.syncOnce();

    let structuralSeen = false;
    b.engine.setCallbacks({
      onRemoteBatch: (_applied, info) => {
        if (info.structural) structuralSeen = true;
      },
    });
    await b.engine.pull();

    expect(titleOf(b.store, NODE)).toBe("Node");
    expect(structuralSeen).toBe(true); // decrypt-before-summarize
    // The relay never saw plaintext.
    for (const envelope of relay.envelopes()) {
      expect(isEncryptedPayload(envelope.payload)).toBe(true);
    }
  });

  it("conflict detection still fires when both sides are encrypted", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const a = await makeCryptoDevice(relay, DEVICE_A, () => nowMs);
    const b = await makeCryptoDevice(relay, DEVICE_B, () => nowMs);
    for (const envelope of baseEnvelopes(DEVICE_A)) {
      a.engine.enqueue(envelope);
      b.engine.enqueue(envelope);
    }
    // Concurrent reparents of NODE to two different parents.
    a.engine.enqueue(makeEnvelope(DEVICE_A, T0 + 30, "object.create", { objectId: NODE, parentId: PARENT }));
    b.engine.enqueue(makeEnvelope(DEVICE_B, T0 + 30, "object.create", { objectId: NODE, parentId: NODE2 }));
    const conflicts: SyncConflict[] = [];
    a.engine.setCallbacks({ onConflict: (c) => conflicts.push(...c) });
    await a.engine.push();
    await a.engine.pull(); // receives b's encrypted reparent
    expect(conflicts.some((c) => c.conflictType === "move_move" && c.nodeId === NODE)).toBe(true);
  });

  it("snapshot round-trip is sealed on the wire and opened on restore", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const a = await makeCryptoDevice(relay, DEVICE_A, () => nowMs);
    const b = await makeCryptoDevice(relay, DEVICE_B, () => nowMs);
    for (const envelope of baseEnvelopes(DEVICE_A)) a.engine.enqueue(envelope);
    await a.engine.syncOnce(); // uploads a snapshot if the relay had none/older

    // The stored snapshot blob must not be the raw image.
    const key = await importWorkspaceKey(KEY_BYTES);
    const { decryptBytes } = await import("@notees/protocol");
    const raw = a.store.snapshot();
    const blob = relay.snapshotBlob(); // see note below
    expect(blob).toBeDefined();
    expect([...blob]).not.toEqual([...raw]);
    expect([...(await decryptBytes(key, blob!))]).toEqual([...raw]);

    // A fresh device restores through the sealed blob.
    const c = await makeCryptoDevice(relay, DEVICE_C_PLACEHOLDER, () => nowMs);
    await c.engine.pull();
    expect(titleOf(c.store, PARENT)).toBe("Parent");
  });

  it("tampered remote payload fails the pull loud, applying nothing", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const a = await makeCryptoDevice(relay, DEVICE_A, () => nowMs);
    a.engine.enqueue(baseEnvelopes(DEVICE_A)[0]!);
    await a.engine.push();

    // Corrupt the ciphertext in the relay (flip a payload byte).
    const victim = relay.envelopes()[0]!;
    const ct = victim.payload as { $e: { iv: string; ct: string } };
    relay.replacePayload(victim.id, { $e: { iv: ct.$e.iv, ct: ct.$e.ct.slice(0, -4) + "AAAA" } });

    const b = await makeCryptoDevice(relay, DEVICE_B, () => nowMs);
    await expect(b.engine.pull()).rejects.toThrow();
    expect(b.store.getNode(PARENT)).toBeUndefined();
  });

  it("snapshot with the wrong key fails the pull with a clear error", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const a = await makeCryptoDevice(relay, DEVICE_A, () => nowMs);
    for (const envelope of baseEnvelopes(DEVICE_A)) a.engine.enqueue(envelope);
    await a.engine.syncOnce();

    const wrongKey = await importWorkspaceKey(new Uint8Array(32).fill(0x99));
    const cStore = new Store();
    const cEngine = new SyncEngine(cStore, new MemoryTransport(relay), new Clock("device-c"), {
      workspaceId: WS,
      now: () => nowMs,
      crypto: keyCryptoProvider(wrongKey),
    });
    await expect(cEngine.pull()).rejects.toThrow(/snapshot decryption failed/);
  });
});
```

**Important — check the actual `MemoryRelay` API in `packages/sync/src/transport.ts` before finalizing** (methods used above: `envelopes()`, `snapshotBlob()`, `replacePayload(id, payload)`; and `DEVICE_C` constant). Adapt the tests to whatever accessors exist — add small read-only accessors to `MemoryRelay` if genuinely missing (they are test-support surface; keep them minimal and documented). Also import `Clock` statically at the top instead of the dynamic import shown above.

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @notees/sync test`
Expected: PASS (Task 5 implemented them).

- [ ] **Step 3: Commit** (fold into Task 5's commit if preferred — keep one commit for the boundary + its tests)

---

### Task 7: Changelog + docs touch-up

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/developers/architecture.md:81-84` (the "designed, not shipped" E2EE line — primitives now shipped; custody still designed-not-shipped)

- [ ] **Step 1: CHANGELOG entry** — prepend under a `2026-11-03` heading (create it if absent), after skimming the file's entry format:

```markdown
### E2EE crypto core (TS reference)

- `@notees/protocol` crypto module: scrypt master-key record (server-format parity), master/workspace key wrap-unwrap (WebCrypto AES-GCM, `wrapKey`), envelope payload encryption into the reserved `{"$e": {iv, ct}}` slot with `id.workspaceId` AAD binding, and snapshot-byte sealing. New canonical fixture `envelope-encrypted.json` extends the lockstep corpus — the gate asserts the slot shape and that the fixture key opens a payload validating against the op schema.
- `@notees/sync`: optional `EnvelopeCrypto` boundary (`keyCryptoProvider(workspaceKey)`) — encrypts at the push boundary, decrypts before remote apply (keeps conflict detection and change-info exact), seals client snapshot uploads (streaming path bypassed under crypto) and opens snapshot downloads. Opt-in via `SyncEngineOptions.crypto`; no behavior change without it.
- Store test harnesses open encrypted fixtures before replay. Verification: +N protocol tests, +N sync tests, full `pnpm test` gate green. GTK/Flutter convergence on `envelope-encrypted.json` is tracked lockstep debt due before any workspace enables encryption (key custody is a later phase).
```

(Replace +N with the actual added test counts.)

- [ ] **Step 2: architecture.md** — update `docs/developers/architecture.md:81-84`: the E2EE slot paragraph becomes "**Shipped (2026-11-03):** the E2EE slot and client crypto primitives (`@notees/protocol` `crypto.ts`: scrypt KDF record, key wrap, envelope/snapshot sealing) plus the optional `EnvelopeCrypto` boundary in `@notees/sync`. **Designed, not shipped:** key custody in clients (unwrapping at login, workspace-key storage), which is what turns the boundary on for real workspaces; encryption is opt-in until then."

- [ ] **Step 3: Full gate + commit**

```bash
pnpm test
git add CHANGELOG.md docs/developers/architecture.md
git commit -m "docs: E2EE crypto core changelog + architecture status"
```

---

## Self-review record

- Spec coverage: §1 (Task 1–2 key hierarchy + envelope encryption), §2 (Task 5 boundary; amendment applied to the spec — durable log plaintext), §5 envelope half (Task 2/5; CAS asset bytes are a later phase), §7 fixture + TS reference (Tasks 3–6; GTK/Flutter ports tracked as lockstep debt). Server slimming, client-side seeding, key custody UI, migration script: later plans.
- Placeholder scan: no TBD/TODO; all code shown inline. Task 6 has an explicit instruction to reconcile with the actual `MemoryRelay` accessor surface (a deliberate adaptation point, not a content gap).
- Type consistency: `EnvelopeCrypto` methods match `keyCryptoProvider` and engine call sites; `encryptEnvelope`/`decryptEnvelope` signatures identical in protocol and the provider adapter; fixture `crypto.workspaceKey` block read identically in protocol test and store harnesses.
- Review focus: all five items pinned — tamper/wrong-key (Task 2, Task 6), AAD transplant (Task 2), id stability (Task 2), exact payload reads (Task 6 pull/conflict/structural tests), snapshot paths (Task 6 round-trip + wrong-key tests).
