/**
 * E2EE boundary tests: the wire and relay see only $e payloads; the local
 * store converges on plaintext; conflict detection and structural
 * classification stay exact (decrypt-before-apply); snapshots are sealed on
 * upload and opened on download; tampering fails loud.
 */

import { describe, expect, it, vi } from "vitest";

import {
  Clock,
  importWorkspaceKey,
  isEncryptedPayload,
  newEnvelope,
  type Envelope,
} from "@notees/protocol";
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
const DEVICE_C = "device-c";
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
  const engine = new SyncEngine(store, new MemoryTransport(relay), new Clock(deviceId), {
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

    const sent = relay.envelopes();
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
    // Skip the snapshot upload so b applies through the catch-up path — the
    // change-info (structural) assertions below observe the pull pipeline.
    await a.engine.syncOnce({ skipSnapshotUpload: true });

    let structuralSeen = false;
    b.engine.setCallbacks({
      onPull: (_count, info) => {
        if (info?.structural) structuralSeen = true;
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
    // Concurrent reparents of NODE to two different parents. b's must reach
    // the relay while a's reparent is still unacknowledged — that is the
    // only window in which detectConflicts can see them as concurrent.
    a.engine.enqueue(makeEnvelope(DEVICE_A, T0 + 30, "object.create", { objectId: NODE, parentId: PARENT }));
    b.engine.enqueue(makeEnvelope(DEVICE_B, T0 + 30, "object.create", { objectId: NODE, parentId: NODE2 }));
    const conflicts: SyncConflict[] = [];
    a.engine.setCallbacks({ onConflict: (c) => conflicts.push(...c) });
    await b.engine.push();
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
    const blob = relay.snapshotBlob();
    expect(blob).toBeDefined();
    expect([...blob!]).not.toEqual([...raw]);
    expect([...(await decryptBytes(key, blob!))]).toEqual([...raw]);

    // A fresh device restores through the sealed blob.
    const c = await makeCryptoDevice(relay, DEVICE_C, () => nowMs);
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
    const cEngine = new SyncEngine(cStore, new MemoryTransport(relay), new Clock(DEVICE_C), {
      workspaceId: WS,
      now: () => nowMs,
      crypto: keyCryptoProvider(wrongKey),
    });
    await expect(cEngine.pull()).rejects.toThrow(/snapshot decryption failed/);
  });
});

describe("locked skip (no crypto provider)", () => {
  it("a keyless engine pulls a mixed batch: plaintext applies, $e skips with a warning, sync stays green", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    // A keyed device sealed two envelopes; a plaintext device wrote one.
    const keyed = await makeCryptoDevice(relay, DEVICE_A, () => nowMs);
    for (const envelope of baseEnvelopes(DEVICE_A)) keyed.engine.enqueue(envelope);
    await keyed.engine.push();

    const plainStore = new Store();
    const plainEngine = new SyncEngine(plainStore, new MemoryTransport(relay), new Clock("device-plain"), {
      workspaceId: WS,
      now: () => nowMs,
    });
    const openId = "0192a000-0000-7000-8000-000000000020";
    plainEngine.enqueue(
      makeEnvelope("device-plain", T0 + 40, "object.create", {
        objectId: openId,
        contentAst: [{ type: "text", text: "Open page" }],
      }),
    );
    await plainEngine.push();

    // The locked device: no provider. Pull applies the plaintext envelope,
    // skips the two sealed ones, and does NOT error-loop.
    const locked = new Store();
    const lockedEngine = new SyncEngine(locked, new MemoryTransport(relay), new Clock(DEVICE_B), {
      workspaceId: WS,
      now: () => nowMs,
    });
    await expect(lockedEngine.pull()).resolves.toBeUndefined();
    expect(titleOf(locked, openId)).toBe("Open page");
    expect(titleOf(locked, PARENT)).toBe(""); // sealed envelopes skipped, not applied

    // Sync stays green: the cursor advanced past the skipped envelopes, so
    // the next pull is an empty no-op instead of re-fetching and re-skipping.
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    await expect(lockedEngine.pull()).resolves.toBeUndefined();
    warnSpy.mockRestore();
    const skipWarnings = warnings.filter((w) => w.includes("skipped"));
    expect(skipWarnings).toHaveLength(0); // nothing re-fetched, nothing re-skipped
  });

  it("the pull-path skip records the rewind marker: a fresh engine with constructor crypto (the W2 unlock re-open) re-fetches and applies", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const keyed = await makeCryptoDevice(relay, DEVICE_A, () => nowMs);
    for (const envelope of baseEnvelopes(DEVICE_A)) keyed.engine.enqueue(envelope);
    await keyed.engine.push();

    // Locked pull (seqs === null, as catch-up pages are): plaintext-free
    // batch here — everything sealed — so NOTHING applies and the cursor
    // advances to the end. This is the live migration repro: the pull path
    // must persist the rewind marker, or the unlock re-open finds nothing.
    const locked = new Store();
    const lockedEngine = new SyncEngine(locked, new MemoryTransport(relay), new Clock(DEVICE_B), {
      workspaceId: WS,
      now: () => nowMs,
    });
    await expect(lockedEngine.pull()).resolves.toBeUndefined();
    expect(titleOf(locked, PARENT)).toBe(""); // sealed, skipped

    // W2 unlock re-open: a FRESH engine on the SAME store, crypto via the
    // CONSTRUCTOR options — the rewind must fire from the persisted marker.
    const unlocked = new Store();
    const key = await importWorkspaceKey(KEY_BYTES);
    const reopened = new SyncEngine(unlocked, new MemoryTransport(relay), new Clock(DEVICE_B), {
      workspaceId: WS,
      now: () => nowMs,
      crypto: keyCryptoProvider(key),
    });
    await expect(reopened.pull()).resolves.toBeUndefined();
    expect(titleOf(unlocked, PARENT)).toBe("Parent"); // previously skipped sealed op now applies
  });

  it("a locked engine advances the cursor past skipped $e frames (realtime path)", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const keyed = await makeCryptoDevice(relay, DEVICE_A, () => nowMs);
    keyed.engine.enqueue(baseEnvelopes(DEVICE_A)[0]!);
    await keyed.engine.push();

    const plainStore = new Store();
    const plainEngine = new SyncEngine(plainStore, new MemoryTransport(relay), new Clock("device-plain"), {
      workspaceId: WS,
      now: () => nowMs,
    });
    const openId = "0192a000-0000-7000-8000-000000000021";
    const openEnv = makeEnvelope("device-plain", T0 + 40, "object.create", {
      objectId: openId,
      contentAst: [{ type: "text", text: "Realtime open" }],
    });
    plainEngine.enqueue(openEnv);
    await plainEngine.push();

    const locked = new Store();
    const lockedEngine = new SyncEngine(locked, new MemoryTransport(relay), new Clock(DEVICE_B), {
      workspaceId: WS,
      now: () => nowMs,
    });
    const page = await new MemoryTransport(relay).catchUp(0);
    const envelopes = page.envelopes as Envelope[];
    const seqs: Record<string, number> = {};
    for (const [index, envelope] of envelopes.entries()) seqs[envelope.id] = index + 1;

    await expect(
      Promise.resolve().then(() => lockedEngine.onRemoteBatch(envelopes, seqs)),
    ).resolves.toBeUndefined();
    // Microtask flush: the drain is fire-and-forget.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(titleOf(locked, openId)).toBe("Realtime open"); // plaintext applied
    expect(titleOf(locked, PARENT)).toBe(""); // sealed frame skipped
    expect(lockedEngine.getCursorSeq()).toBe(envelopes.length); // cursor covers the skipped seq
  });
});

describe("locked snapshot skip + cursor rewind", () => {
  it("a keyless engine skips a sealed snapshot (counted warning) and catch-up keeps sync green", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    // A keyed device uploads a SEALED snapshot (its syncOnce seals the blob).
    const keyed = await makeCryptoDevice(relay, DEVICE_A, () => nowMs);
    for (const envelope of baseEnvelopes(DEVICE_A)) keyed.engine.enqueue(envelope);
    await keyed.engine.syncOnce();
    expect(relay.snapshotBlob()).toBeDefined();

    // A plaintext device adds catch-up-visible content.
    const plainStore = new Store();
    const plainEngine = new SyncEngine(plainStore, new MemoryTransport(relay), new Clock("device-plain"), {
      workspaceId: WS,
      now: () => nowMs,
    });
    const openId = "0192a000-0000-7000-8000-000000000030";
    plainEngine.enqueue(
      makeEnvelope("device-plain", T0 + 40, "object.create", {
        objectId: openId,
        contentAst: [{ type: "text", text: "Catch-up page" }],
      }),
    );
    await plainEngine.push();

    const locked = new Store();
    const lockedEngine = new SyncEngine(locked, new MemoryTransport(relay), new Clock(DEVICE_B), {
      workspaceId: WS,
      now: () => nowMs,
    });
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    await expect(lockedEngine.pull()).resolves.toBeUndefined();
    warnSpy.mockRestore();

    // Sealed snapshot skipped with a counted warning; catch-up covered the
    // plaintext content; sync is green (before this fix the garbage restore
    // threw and the pull error-looped).
    expect(warnings.some((w) => w.includes("sealed snapshot"))).toBe(true);
    expect(titleOf(locked, openId)).toBe("Catch-up page");
    await expect(lockedEngine.pull()).resolves.toBeUndefined();
  });

  it("installing a key after locked realtime skips rewinds the cursor so the next pull applies the sealed frames", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const keyed = await makeCryptoDevice(relay, DEVICE_A, () => nowMs);
    for (const envelope of baseEnvelopes(DEVICE_A)) keyed.engine.enqueue(envelope);
    await keyed.engine.push();

    const locked = new Store();
    const lockedEngine = new SyncEngine(locked, new MemoryTransport(relay), new Clock(DEVICE_B), {
      workspaceId: WS,
      now: () => nowMs,
    });
    const page = await new MemoryTransport(relay).catchUp(0);
    const envelopes = page.envelopes as Envelope[];
    const seqs: Record<string, number> = {};
    for (const [index, envelope] of envelopes.entries()) seqs[envelope.id] = index + 1;

    lockedEngine.onRemoteBatch(envelopes, seqs);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lockedEngine.getCursorSeq()).toBe(envelopes.length);
    expect(titleOf(locked, PARENT)).toBe(""); // sealed frames skipped while locked

    // Unlock: the cursor rewinds before the first skipped seq…
    const key = await importWorkspaceKey(KEY_BYTES);
    lockedEngine.setCrypto(keyCryptoProvider(key));
    expect(lockedEngine.getCursorSeq()).toBe(0);

    // …and the next pull re-fetches + applies the sealed frames.
    await lockedEngine.pull();
    expect(titleOf(locked, PARENT)).toBe("Parent");
    expect(titleOf(locked, NODE)).toBe("Node");
  });
});

describe("constructor crypto rewinds a persisted locked-skip marker (W2 unlock re-open)", () => {
  it("the live repro: locked pull skips + persists the marker; a FRESH engine with constructor crypto re-fetches and applies the skipped history", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;
    const keyed = await makeCryptoDevice(relay, DEVICE_A, () => nowMs);
    for (const envelope of baseEnvelopes(DEVICE_A)) keyed.engine.enqueue(envelope);
    await keyed.engine.push();

    // 1. A session that reloaded without its master key: locked realtime
    //    frames skip every sealed envelope; the cursor advances over the
    //    skipped seqs and the marker persists (SyncMeta, app_meta).
    const locked = new Store();
    const lockedEngine = new SyncEngine(locked, new MemoryTransport(relay), new Clock(DEVICE_B), {
      workspaceId: WS,
      now: () => nowMs,
    });
    const page = await new MemoryTransport(relay).catchUp(0);
    const envelopes = page.envelopes as Envelope[];
    const seqs: Record<string, number> = {};
    for (const [index, envelope] of envelopes.entries()) seqs[envelope.id] = index + 1;
    lockedEngine.onRemoteBatch(envelopes, seqs);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lockedEngine.getCursorSeq()).toBe(envelopes.length);
    expect(titleOf(locked, PARENT)).toBe(""); // everything skipped

    // 2. The W2 unlock: the workspace RE-OPENS — a FRESH SyncEngine with
    //    crypto in the CONSTRUCTOR options (setCrypto never runs).
    const key = await importWorkspaceKey(KEY_BYTES);
    const reopened = new SyncEngine(locked, new MemoryTransport(relay), new Clock(DEVICE_B), {
      workspaceId: WS,
      now: () => nowMs,
      crypto: keyCryptoProvider(key),
    });

    // The constructor rewind: the durable cursor drops before the marker and
    // the marker clears.
    expect(reopened.getCursorSeq()).toBe(0);

    // 3. The next pull re-fetches and applies the previously skipped frames.
    await reopened.pull();
    expect(titleOf(locked, PARENT)).toBe("Parent");
    expect(titleOf(locked, NODE)).toBe("Node");

    // 4. And the re-open is stable: a second pull is a no-op (the marker is
    //    gone, the cursor honest).
    await expect(reopened.pull()).resolves.toBeUndefined();
    expect(titleOf(locked, PARENT)).toBe("Parent");
  });

  it("constructor crypto with NO marker does not touch the cursor (setCrypto(null) semantics unchanged)", async () => {
    const relay = new MemoryRelay();
    let nowMs = 100_000;

    // A plaintext-only relay: the keyless pull has nothing sealed to skip, so
    // NO rewind marker is recorded (a batch WITH skips now correctly records
    // one from the pull path — see the W2 re-open test above).
    const plain = new Store();
    const plainEngine = new SyncEngine(plain, new MemoryTransport(relay), new Clock(DEVICE_B), {
      workspaceId: WS,
      now: () => nowMs,
    });
    plainEngine.enqueue(baseEnvelopes(DEVICE_A)[0]!);
    await plainEngine.push();
    await plainEngine.pull();
    const advanced = plainEngine.getCursorSeq();
    expect(advanced).toBeGreaterThan(0);

    // A fresh engine WITH constructor crypto but no marker keeps the cursor.
    const key = await importWorkspaceKey(KEY_BYTES);
    const fresh = new SyncEngine(plain, new MemoryTransport(relay), new Clock(DEVICE_B), {
      workspaceId: WS,
      now: () => nowMs,
      crypto: keyCryptoProvider(key),
    });
    expect(fresh.getCursorSeq()).toBe(advanced);
  });
});
