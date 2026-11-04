// @vitest-environment node
/**
 * Chunked + compacted snapshot uploads (the engine's crypto path):
 *
 * - A raw image at/above the compact threshold is VACUUMed before sealing
 *   (replay-derived free pages don't ride along), then re-serialized.
 * - A sealed image over the chunk threshold rides the multipart flow —
 *   ordered part uploads under one upload id, then a commit declaring the
 *   part count and the sealed flag.
 * - A small sealed image keeps the single PUT (sealed=1).
 * - Any upload failure keeps the best-effort contract: sync resolves, no
 *   checkpoint lands, and the NEXT pull retries (no permanent latch).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Clock,
  importWorkspaceKey,
  newEnvelope,
  type Envelope,
} from "@notees/protocol";
import { Store } from "@notees/store";

import {
  MemoryRelay,
  MemoryTransport,
  SyncEngine,
  keyCryptoProvider,
} from "../src/index.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const DEVICE = "device-a";
const T0 = 1_727_200_000_000;
const KEY_BYTES = new Uint8Array(32).fill(0x42);

function makeEnvelope(physical: number, text: string): Envelope {
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: DEVICE,
    hlc: { physical, logical: 0 },
    opType: "object.create",
    payload: {
      objectId: `0192a000-0000-7000-8000-0000000000${physical.toString(16).slice(-2)}`,
      contentAst: [{ type: "text", text }],
      isEmbedded: false,
    },
    timestamp: new Date(physical).toISOString(),
  });
}

/** A big-enough node so the sealed image clears the test's tiny chunk threshold. */
const BIG_TEXT = "chunk-me ".repeat(2048); // ~18 KiB → sealed ~18 KiB

interface SpiedTransport {
  transport: MemoryTransport;
  single: ReturnType<typeof vi.spyOn>;
  part: ReturnType<typeof vi.spyOn>;
  commit: ReturnType<typeof vi.spyOn>;
}

function spiedTransport(relay: MemoryRelay): SpiedTransport {
  const transport = new MemoryTransport(relay);
  return {
    transport,
    single: vi.spyOn(transport, "uploadSnapshot"),
    part: vi.spyOn(transport, "uploadSnapshotPart"),
    commit: vi.spyOn(transport, "commitSnapshot"),
  };
}

async function makeEngine(
  relay: MemoryRelay,
  transport: MemoryTransport,
  tuning: {
    snapshotCompactThreshold?: number;
    snapshotChunkThreshold?: number;
    snapshotPartSize?: number;
  } = {},
): Promise<SyncEngine> {
  const key = await importWorkspaceKey(KEY_BYTES);
  return new SyncEngine(new Store(), transport, new Clock(DEVICE), {
    workspaceId: WS,
    now: () => 100_000,
    crypto: keyCryptoProvider(key),
    ...tuning,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("compaction before upload", () => {
  it("a raw image at/above the compact threshold is vacuumed and re-serialized before sealing", async () => {
    const relay = new MemoryRelay();
    const spied = spiedTransport(relay);
    const compact = vi.spyOn(Store.prototype, "compact");
    const engine = await makeEngine(relay, spied.transport, {
      snapshotCompactThreshold: 1, // any image compacts
    });
    engine.enqueue(makeEnvelope(T0 + 10, "Compact me"));
    await engine.syncOnce({ skipSnapshotUpload: false });

    expect(compact).toHaveBeenCalled();
    expect(spied.single).toHaveBeenCalledTimes(1);
  });

  it("a raw image below the compact threshold uploads WITHOUT vacuuming", async () => {
    const relay = new MemoryRelay();
    const spied = spiedTransport(relay);
    const compact = vi.spyOn(Store.prototype, "compact");
    const engine = await makeEngine(relay, spied.transport, {
      snapshotCompactThreshold: 64 * 1024 * 1024, // way above the tiny test image
    });
    engine.enqueue(makeEnvelope(T0 + 20, "Too small to compact"));
    await engine.syncOnce();

    expect(compact).not.toHaveBeenCalled();
    expect(spied.single).toHaveBeenCalledTimes(1);
  });
});

describe("chunked upload over the threshold", () => {
  it("uploads ordered parts under one upload id, then commits with the count and sealed flag", async () => {
    const relay = new MemoryRelay();
    const spied = spiedTransport(relay);
    const engine = await makeEngine(relay, spied.transport, {
      snapshotChunkThreshold: 1024, // 18 KiB sealed image → chunked
      snapshotPartSize: 4096,
    });
    engine.enqueue(makeEnvelope(T0 + 30, BIG_TEXT));
    await engine.syncOnce();

    // Single PUT was bypassed; parts ran in index order under ONE upload id.
    expect(spied.single).not.toHaveBeenCalled();
    const partCalls = spied.part.mock.calls as Array<[Uint8Array, string, number]>;
    expect(partCalls.length).toBeGreaterThan(1);
    const indexes = partCalls.map(([, , index]) => index);
    expect(indexes).toEqual([...partCalls.keys()]);
    const uploadIds = new Set(partCalls.map(([, upload]) => upload));
    expect(uploadIds.size).toBe(1);

    // The commit declares the part count and the sealed flag, and the
    // reassembled relay blob is a SEALED image of the whole store.
    expect(spied.commit).toHaveBeenCalledTimes(1);
    const [commitUpload, commitParts, , commitSealed] = spied.commit.mock.calls[0] as [
      string,
      number,
      unknown,
      boolean,
    ];
    expect(commitUpload).toBe(partCalls[0]![1]);
    expect(commitParts).toBe(partCalls.length);
    expect(commitSealed).toBe(true);

    const key = await importWorkspaceKey(KEY_BYTES);
    const { decryptBytes } = await import("@notees/protocol");
    const engineStore = (engine as unknown as { store: Store }).store;
    const raw = engineStore.snapshot();
    expect([...(await decryptBytes(key, relay.snapshotBlob()!))]).toEqual([...raw]);
  });
});

describe("single PUT below the threshold", () => {
  it("a small sealed image rides the existing single PUT (sealed=1), no parts", async () => {
    const relay = new MemoryRelay();
    const spied = spiedTransport(relay);
    const engine = await makeEngine(relay, spied.transport); // default 48 MiB threshold
    engine.enqueue(makeEnvelope(T0 + 40, "Small"));
    await engine.syncOnce();

    expect(spied.single).toHaveBeenCalledTimes(1);
    expect(spied.single.mock.calls[0]![2]).toBe(true); // sealed flag
    expect(spied.part).not.toHaveBeenCalled();
    expect(spied.commit).not.toHaveBeenCalled();
  });
});

describe("failure semantics", () => {
  it("a failing part upload resolves sync, lands no checkpoint, and retries on the next pull", async () => {
    const relay = new MemoryRelay();
    const spied = spiedTransport(relay);
    spied.part.mockRejectedValueOnce(new Error("relay restarted mid-upload"));
    const engine = await makeEngine(relay, spied.transport, {
      snapshotChunkThreshold: 1024,
      snapshotPartSize: 4096,
    });
    engine.enqueue(makeEnvelope(T0 + 50, BIG_TEXT));
    await expect(engine.syncOnce()).resolves.toBeUndefined(); // best-effort: no throw

    expect(spied.commit).not.toHaveBeenCalled();
    expect(relay.snapshotBlob()).toBeNull(); // no checkpoint landed

    // Not latched: the next sync pass retries the upload from scratch.
    await engine.syncOnce();
    expect(spied.part.mock.calls.length).toBeGreaterThan(1);
    expect(spied.commit).toHaveBeenCalledTimes(1);
    expect(relay.snapshotBlob()).not.toBeNull();
  });
});
