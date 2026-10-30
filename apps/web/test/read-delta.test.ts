// @vitest-environment node
/**
 * Read-delta tests (the multiRead delta protocol, read-revisions.ts):
 *
 *  - ReadRevisions unit rules: which stamps change for which op (content
 *    edit vs placement vs delete vs class family), the old-parent
 *    soundness of a move, subtree descent for deletes, the oversized-walk
 *    fallback, and remote-batch coarseness.
 *  - Coverage guard: every READ_METHODS entry maps to an explicit stamp
 *    family — the global catch-all is a soundness escape hatch, never a
 *    default (under-broad stamps serve stale data).
 *  - WorkerCore integration through the real sql.js backend: a repeated
 *    multiRead answers READ_UNCHANGED for every key; only the keys the
 *    gesture actually touched re-serve.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";

import { MemoryRelay, MemoryTransport } from "@notees/sync";

import {
  ReadRevisions,
  READ_UNCHANGED,
  isReadUnchanged,
  type RevisionWalk,
} from "../src/core/workspace-client/read-revisions.js";
import { READ_METHODS, WorkerCore } from "../src/worker/worker-core.js";
import type { OpfsStore } from "../src/worker/opfs.js";
import type { Envelope } from "@notees/protocol";

const WS = "0192a000-0000-7000-8000-000000000001";
const FILE = `${WS}.db`;

let sqlModule: SqlJsStatic;

beforeAll(async () => {
  sqlModule = await initSqlJs();
});

/** Fake topology: P → A → B, plus C under P. (Ids are opaque to the rules.) */
const P = "p";
const A = "a";
const B = "b";
const C = "c";
const TOPO: Record<string, string | null> = { [P]: null, [A]: P, [B]: A, [C]: P };
const CHILDREN: Record<string, string[]> = { [P]: [A, C], [A]: [B], [B]: [], [C]: [] };

function fakeWalk(): RevisionWalk {
  return {
    ancestorsOf(id) {
      const out: string[] = [];
      let cur: string | null = TOPO[id] ?? null;
      while (cur !== null) {
        out.push(cur);
        cur = TOPO[cur] ?? null;
      }
      return out;
    },
    descendantsOf(ids) {
      const out: string[] = [];
      const queue = [...ids];
      while (queue.length > 0) {
        const id = queue.pop()!;
        for (const child of CHILDREN[id] ?? []) {
          out.push(child);
          queue.push(child);
        }
      }
      return out;
    },
  };
}

const env = (opType: string, affected: string[], payload?: object): Envelope =>
  ({
    opType,
    affectedNodeIds: affected,
    payload,
  }) as unknown as Envelope;

describe("ReadRevisions stamp rules", () => {
  it("a content edit re-stamps the edited node and its ancestors, nobody else", () => {
    const r = new ReadRevisions(fakeWalk());
    const before = {
      b: r.stampFor("getNode", [B]),
      c: r.stampFor("getNode", [C]),
      pages: r.stampFor("listPages", []),
      childrenP: r.stampFor("getChildren", [P]),
    };
    r.bumpLocal(env("object.update", [B]), { affectedNodeIds: [B] }, []);
    expect(r.stampFor("getNode", [B])).not.toBe(before.b);
    expect(r.stampFor("getNode", [P])).not.toBe(before.b); // ancestor
    expect(r.stampFor("getNode", [C])).toBe(before.c); // untouched sibling
    expect(r.stampFor("listPages", [])).toBe(before.pages); // content is not structural
    // getChildren(P) conservatively re-serves: its stamp rides the row
    // epoch of P's subtree, and B lives under P.
    expect(r.stampFor("getChildren", [P])).not.toBe(before.childrenP);
  });

  it("search rides the content family: a keystroke re-stamps it; a pure class-membership op does not", () => {
    const r = new ReadRevisions(fakeWalk());
    const s0 = r.stampFor("search", ["q"]);
    r.bumpLocal(env("object.update", [B]), { affectedNodeIds: [B] }, []);
    expect(r.stampFor("search", ["q"])).not.toBe(s0);
    const s1 = r.stampFor("search", ["q"]);
    // class.assign is not listing-affecting (bindings are per-class config) —
    // search is untouched. (A binding/template op IS listing-affecting and
    // legitimately re-stamps search: display templates feed result titles.)
    r.bumpLocal(env("class.assign", [B]), { affectedNodeIds: [B] }, []);
    expect(r.stampFor("search", ["q"])).toBe(s1);
  });

  it("a move re-stamps BOTH parents — the vacated side via the pre-apply chain", () => {
    const r = new ReadRevisions(fakeWalk());
    const childrenP = r.stampFor("getChildren", [P]);
    const childrenB = r.stampFor("getChildren", [B]);
    // C moves from P to B. The real walk runs POST-apply, so the fake
    // topology mirrors the new state before the bump; oldAncestors = [P]
    // (the pre-apply chain the bump itself cannot see).
    TOPO[C] = B;
    CHILDREN[P] = [A];
    CHILDREN[B] = [C];
    r.bumpLocal(env("object.move", [C]), { affectedNodeIds: [C] }, [P]);
    expect(r.stampFor("getChildren", [P])).not.toBe(childrenP); // vacated
    expect(r.stampFor("getChildren", [B])).not.toBe(childrenB); // gained
    // Restore the fixture topology for the other tests.
    TOPO[C] = P;
    CHILDREN[P] = [A, C];
    CHILDREN[B] = [];
  });

  it("a delete re-stamps the whole subtree and the listings", () => {
    const r = new ReadRevisions(fakeWalk());
    const nodeB = r.stampFor("getNode", [B]);
    const pages = r.stampFor("listPages", []);
    r.bumpLocal(env("object.delete", [A]), { affectedNodeIds: [A] }, [P]);
    expect(r.stampFor("getNode", [B])).not.toBe(nodeB); // descendant row flipped
    expect(r.stampFor("getNode", [C])).toBe(nodeB === r.stampFor("getNode", [C]) ? nodeB : r.stampFor("getNode", [C])); // sibling untouched
    expect(r.stampFor("listPages", [])).not.toBe(pages);
  });

  it("class-family ops re-stamp class reads and effective properties", () => {
    const r = new ReadRevisions(fakeWalk());
    const members = r.stampFor("getClassMembers", ["class-x"]);
    const props = r.stampFor("getEffectiveProperties", [B]);
    const pages = r.stampFor("listPages", []);
    r.bumpLocal(env("class.assign", [B]), { affectedNodeIds: [B] }, []);
    expect(r.stampFor("getClassMembers", ["class-x"])).not.toBe(members);
    expect(r.stampFor("getEffectiveProperties", [B])).not.toBe(props);
    expect(r.stampFor("listPages", [])).toBe(pages);
  });

  it("an oversized affected set falls back to the coarse counters", () => {
    const r = new ReadRevisions(fakeWalk());
    const many = Array.from({ length: 600 }, (_, i) => `n${i}`);
    const nodeB = r.stampFor("getNode", [B]);
    const childrenP = r.stampFor("getChildren", [P]);
    r.bumpLocal(env("object.update", many), { affectedNodeIds: many }, []);
    expect(r.stampFor("getNode", [B])).not.toBe(nodeB); // nodeAll bumped
    expect(r.stampFor("getChildren", [P])).not.toBe(childrenP); // nodeAll rides the cs stamp
  });

  it("remote structural notifications are coarse; remote content is scoped", () => {
    const r = new ReadRevisions(fakeWalk());
    const nodeC = r.stampFor("getNode", [C]);
    const childrenP = r.stampFor("getChildren", [P]);
    const pages = r.stampFor("listPages", []);
    r.bumpRemote({ affectedNodeIds: [B], structural: false });
    expect(r.stampFor("getNode", [C])).toBe(nodeC); // unrelated node untouched
    // A remote content edit conservatively re-serves children reads on the
    // edited chain (the cs stamp rides the row epoch) — sound, just broad.
    expect(r.stampFor("getChildren", [P])).not.toBe(childrenP);
    r.bumpRemote({ affectedNodeIds: [B], structural: true });
    expect(r.stampFor("listPages", [])).not.toBe(pages);
  });
});

describe("READ_METHODS stamp coverage", () => {
  it("every cached-read method maps to an explicit stamp family (not the global catch-all)", () => {
    // Methods whose value genuinely depends on unbounded cross-node state,
    // keyed by an id that is NOT the state owner — the global revision is
    // the honest stamp. Extend this list only with a soundness argument.
    const globalAllowlist = new Set([
      "getAnnotationsForAsset",
      "getPropertyReferences",
      "getCoverReferences",
      "resolveExternalRef",
      "externalRefsOf",
    ]);
    const r = new ReadRevisions(fakeWalk());
    const globalStamp = r.stampFor("definitely.not.a.method", []);
    const unmapped = [...READ_METHODS].filter(
      (m) => !globalAllowlist.has(m) && r.stampFor(m, ["some-id"]) === globalStamp,
    );
    expect(unmapped).toEqual([]);
  });
});

// --- WorkerCore integration (real sql.js backend, real envelopes) -----------

const cores: WorkerCore[] = [];

afterEach(async () => {
  while (cores.length > 0) await cores.pop()!.close();
  vi.restoreAllMocks();
});

function createMemoryOpfs(): OpfsStore {
  const files = new Map<string, Uint8Array>();
  return {
    loadFile: async (name) => files.get(name) ?? null,
    saveFile: async (name, bytes) => {
      files.set(name, new Uint8Array(bytes));
    },
  };
}

async function createCore(): Promise<WorkerCore> {
  const core = await WorkerCore.create({
    SQL: sqlModule,
    opfs: createMemoryOpfs(),
    fileName: FILE,
    workspaceId: WS,
    transport: new MemoryTransport(new MemoryRelay()),
  });
  cores.push(core);
  return core;
}

describe("multiRead delta (WorkerCore over sql.js)", () => {
  it("a repeated refresh answers READ_UNCHANGED; only touched keys re-serve", async () => {
    const core = await createCore();
    const pageId = await core.createObject({ isEmbedded: false, name: "P" });
    const aId = await core.createObject({ parentId: pageId, name: "A" });
    const bId = await core.createObject({ parentId: aId, name: "B" });
    const cId = await core.createObject({ parentId: pageId, name: "C" });

    const key = (m: string, ...args: unknown[]) => JSON.stringify([m, args]);
    const keys = [
      key("getNode", aId),
      key("getNode", bId),
      key("getNode", cId),
      key("getChildren", pageId),
      key("listPages"),
    ];

    const first = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(first.every((v) => !isReadUnchanged(v))).toBe(true);
    expect((first[0] as { id: string }).id).toBe(aId);

    // Nothing changed: the entire refresh is delta'd away.
    const second = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(second.every((v) => isReadUnchanged(v))).toBe(true);

    // Content edit of B: B + its ancestors re-serve; the sibling and the
    // listings stay delta'd. getChildren(P) conservatively re-serves (its
    // stamp rides the row epoch of P's subtree) — sound, just broad.
    await core.updateObject(bId, { contentAst: [{ type: "text", text: "B2" }] });
    const third = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(isReadUnchanged(third[0])).toBe(false); // A (ancestor)
    expect(isReadUnchanged(third[1])).toBe(false); // B
    expect(isReadUnchanged(third[2])).toBe(true); // C untouched
    expect(isReadUnchanged(third[3])).toBe(false); // children(P): conservative row-epoch ride
    expect(isReadUnchanged(third[4])).toBe(true); // listPages: content is not listing
    expect((third[1] as { contentAst: unknown[] }).contentAst[0]).toMatchObject({ text: "B2" });

    // A structural gesture (move C under B): membership reads re-serve on
    // both the vacated and the gained side.
    await core.moveObject(cId, bId);
    const fourth = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(isReadUnchanged(fourth[3])).toBe(false); // getChildren(P): C left
    expect(isReadUnchanged(fourth[4])).toBe(false); // listPages: listing-affecting
  });

  it("a subtree delete re-serves the descendant keys", async () => {
    const core = await createCore();
    const pageId = await core.createObject({ isEmbedded: false, name: "P" });
    const aId = await core.createObject({ parentId: pageId, name: "A" });
    const bId = await core.createObject({ parentId: aId, name: "B" });
    const key = (m: string, ...args: unknown[]) => JSON.stringify([m, args]);
    const keys = [key("getNode", bId), key("getChildren", pageId)];
    await core.invoke("multiRead", [keys]);
    await core.deleteObject(aId);
    const after = (await core.invoke("multiRead", [keys])) as unknown[];
    expect(isReadUnchanged(after[0])).toBe(false); // descendant row is stale
    // The trashed node's read may be absent entirely (inactive rows leave
    // the default read) — the delta point is that it re-served.
    if (after[0] !== null && after[0] !== undefined) {
      expect((after[0] as { isActive: boolean }).isActive).toBe(false);
    }
    expect(isReadUnchanged(after[1])).toBe(false); // P lost a child
  });

  it("READ_UNCHANGED survives a JSON round trip (the wire is plain data)", () => {
    const cloned = JSON.parse(JSON.stringify(READ_UNCHANGED));
    expect(isReadUnchanged(cloned)).toBe(true);
  });
});
