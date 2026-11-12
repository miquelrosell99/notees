/**
 * Recovery codes — the client module (`core/recovery.ts`):
 *
 * - buildRecoveryRecords derives a per-code key (fast scrypt), wraps the
 *   master with it, and produces OPAQUE records (id/salt/wrap/verifier) —
 *   the plaintext codes ride the return value, shown once.
 * - generateAndInstallRecoveryCodes posts the records and returns the codes.
 * - redeemRecoveryCode fetches the record by b64u(SHA256(code)), unwraps the
 *   master with the code-derived key, re-wraps under the new password, and
 *   posts the verifier + new record. A WRONG code throws at the unwrap
 *   BEFORE anything is burned.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createKdfRecord, generateMasterKey, recoveryCodeIdOf } from "@notees/protocol";

import {
  buildRecoveryRecords,
  generateAndInstallRecoveryCodes,
  redeemRecoveryCode,
} from "../src/core/recovery.js";

const SERVER = "https://notees.example.com";
const PASSWORD = "account-password-1";

async function realKdf() {
  return createKdfRecord(await generateMasterKey(), PASSWORD);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recovery code records", () => {
  it("buildRecoveryRecords wraps the master and yields 8 opaque records + the codes", async () => {
    const kdf = await realKdf();
    const built = await buildRecoveryRecords(PASSWORD, kdf);
    expect(built).toHaveLength(8);
    const ids = new Set(built.map((b) => b.record.id));
    expect(ids.size).toBe(8); // distinct codes → distinct ids
    for (const { code, record } of built) {
      expect(record.id).toBe(recoveryCodeIdOf(code)); // the id IS derivable from the code
      expect(record.salt.length).toBeGreaterThan(10);
      expect(record.wrappedRecovery.length).toBeGreaterThan(20);
      expect(record.verifier.length).toBeGreaterThan(20);
    }
  });

  it("generateAndInstall posts the opaque records and returns the codes", async () => {
    const calls: Array<{ url: string; body: { records: unknown[] } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/auth/unlock")) {
          return Response.json({ kdf: await realKdf() });
        }
        if (url.endsWith("/api/auth/recovery-codes")) {
          calls.push({ url, body: JSON.parse(String(init!.body)) });
          return Response.json({ ok: true, count: 8 });
        }
        return Response.json({});
      }),
    );

    const codes = await generateAndInstallRecoveryCodes(SERVER, "session-token", PASSWORD, await realKdf());
    expect(codes).toHaveLength(8);
    expect(calls).toHaveLength(1);
    const records = calls[0]!.body.records as Array<Record<string, string>>;
    expect(records).toHaveLength(8);
    // The plaintext code appears in NEITHER the records nor the request.
    for (const record of records) {
      for (const code of codes) {
        expect(JSON.stringify(record)).not.toContain(code);
      }
    }
  });

  it("redeemRecoveryCode unwraps with the code and posts the verifier + new record", async () => {
    const master = await generateMasterKey();
    const kdf = await createKdfRecord(master, PASSWORD);
    const built = await buildRecoveryRecords(PASSWORD, kdf, 1);
    const { code, record } = built[0]!;

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/api/auth/recovery/${record.id}`)) {
          return Response.json({ salt: record.salt, wrappedRecovery: record.wrappedRecovery });
        }
        if (url.endsWith("/api/auth/redeem-recovery")) {
          calls.push({ url, body: JSON.parse(String(init!.body)) });
          return Response.json({ ok: true });
        }
        return Response.json({});
      }),
    );

    await redeemRecoveryCode(SERVER, code, "brand-new-password");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.id).toBe(record.id);
    expect(calls[0]!.body.verifier).toBe(record.verifier);
    const newRecord = calls[0]!.body.newKdfRecord as { keyFp?: string };
    expect(newRecord.keyFp).toBeDefined();
    // The unwrap actually recovered the SAME master: the new record's fp
    // matches the original kdf's fp.
    expect(newRecord.keyFp).toBe(kdf.keyFp);
  });

  it("a WRONG code throws at the unwrap — before any redeem POST (nothing burned)", async () => {
    const kdf = await realKdf();
    const built = await buildRecoveryRecords(PASSWORD, kdf, 1);
    const { record } = built[0]!;

    let redeemPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith(`/api/auth/recovery/${record.id}`)) {
          return Response.json({ salt: record.salt, wrappedRecovery: record.wrappedRecovery });
        }
        if (url.endsWith("/api/auth/redeem-recovery")) redeemPosts += 1;
        return Response.json({});
      }),
    );

    await expect(redeemRecoveryCode(SERVER, "not-the-right-code", "whatever-123")).rejects.toThrow();
    expect(redeemPosts).toBe(0);
  });
});
