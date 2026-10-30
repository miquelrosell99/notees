/**
 * forward-paths.ts tests — the "Forward path" page-section read: a directed,
 * cycle-safe trace over the node's CONSUMER edges (the forward/derived
 * direction: where an idea went next — embedded-in → synthesis → plan).
 *
 * Hop semantics (all traversed target→source against the edge table's
 * mention-authorship direction):
 *
 *  - embed  — a consumer carries the node as an `embed_ref` token, or via a
 *    mention edge with the per-link transclusion flag (edge.is_embedded = 1);
 *  - mention — a mention edge without the flag;
 *  - typed_link — a typed-link mark whose FIRST candidateSpan (nearest
 *    mention target, record-don't-resolve) is the node; the row carries the
 *    verb.
 *
 * One path per simple chain, anchor row first ({kind: null} = terminal row),
 * depth-capped (default 3), cycle-safe (visited set per branch), live
 * consumers only. Isolated / unknown anchors read [].
 */

import { describe, expect, it } from "vitest";

import { newEnvelope, type Envelope } from "@notees/protocol";

import { forwardPaths } from "../src/forward-paths.js";
import { Store } from "../src/index.js";
import { betterSqlite3Backend } from "../src/adapters/better-sqlite3.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

const PAGE_A = "0192a000-0000-7000-8000-0000000000a1";
const PAGE_B = "0192a000-0000-7000-8000-0000000000a2";
const PAGE_C = "0192a000-0000-7000-8000-0000000000a3";
const PAGE_D = "0192a000-0000-7000-8000-0000000000a4";
const PAGE_E = "0192a000-0000-7000-8000-0000000000a5";
const BLOCK_B1 = "0192a000-0000-7000-8000-0000000000b1";

let clock = 1_000;

function env(opType: string, payload: Record<string, unknown>): Envelope {
  clock += 10;
  return newEnvelope({
    workspaceId: WS,
    actorId: ACTOR,
    deviceId: "test-device-forward-paths",
    hlc: { physical: clock, logical: 0 },
    opType,
    payload,
    timestamp: new Date(clock).toISOString(),
  });
}

function createPage(id: string): Envelope {
  return env("object.create", { objectId: id });
}

function createBlock(id: string, parentId: string): Envelope {
  return env("object.create", { objectId: id, parentId, isEmbedded: true });
}

/** Rich content rides object.update (create flattens document-chrome nodes). */
function setContent(id: string, contentAst: unknown): Envelope {
  return env("object.update", { objectId: id, contentAst });
}

function embedRef(target: string): Record<string, unknown> {
  return { type: "embed_ref", nodeId: target };
}

function mention(target: string, isEmbedded = false): Record<string, unknown> {
  return isEmbedded
    ? { type: "mention", targetNodeId: target, isEmbedded: true }
    : { type: "mention", targetNodeId: target };
}

function typedLink(verb: string, text: string, candidateSpans: string[]): Record<string, unknown> {
  return { type: "typed_link", verb, text, metadata: { candidateSpans } };
}

/** Apply envelopes to a fresh in-memory store. */
function setup(...envelopes: Envelope[]): Store {
  const store = Store.open(betterSqlite3Backend());
  for (const envelope of envelopes) store.apply(envelope);
  return store;
}

/** Compact path shape for assertions: [nodeId, kind, verb] tuples. */
function compact(paths: ReturnType<typeof forwardPaths>): string[][] {
  return paths.map((path) => path.map((row) => [row.nodeId, row.kind ?? "-", row.verb ?? "-"].join(":")));
}

describe("forwardPaths", () => {
  it("reads empty for an isolated node (no consumers)", () => {
    const store = setup(createPage(PAGE_A), createPage(PAGE_B));
    expect(forwardPaths(store, PAGE_A)).toEqual([]);
  });

  it("reads empty for an unknown node id", () => {
    const store = setup(createPage(PAGE_A));
    expect(forwardPaths(store, "0192a000-0000-7000-8000-0000000000ff")).toEqual([]);
  });

  it("traces an embed chain one hop per level, naming the edge kind per row", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createPage(PAGE_C),
      setContent(PAGE_B, [embedRef(PAGE_A)]),
      setContent(PAGE_C, [embedRef(PAGE_B)]),
    );
    expect(compact(forwardPaths(store, PAGE_A))).toEqual([
      [`${PAGE_A}:embed:-`, `${PAGE_B}:embed:-`, `${PAGE_C}:-:-`],
    ]);
  });

  it("respects a custom depth cap", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createPage(PAGE_C),
      setContent(PAGE_B, [embedRef(PAGE_A)]),
      setContent(PAGE_C, [embedRef(PAGE_B)]),
    );
    expect(compact(forwardPaths(store, PAGE_A, { depthCap: 1 }))).toEqual([
      [`${PAGE_A}:embed:-`, `${PAGE_B}:-:-`],
    ]);
  });

  it("the default cap is 3 hops — a 5-node chain stops at the fourth node", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createPage(PAGE_C),
      createPage(PAGE_D),
      createPage(PAGE_E),
      setContent(PAGE_B, [embedRef(PAGE_A)]),
      setContent(PAGE_C, [embedRef(PAGE_B)]),
      setContent(PAGE_D, [embedRef(PAGE_C)]),
      setContent(PAGE_E, [embedRef(PAGE_D)]),
    );
    expect(compact(forwardPaths(store, PAGE_A))).toEqual([
      [`${PAGE_A}:embed:-`, `${PAGE_B}:embed:-`, `${PAGE_C}:embed:-`, `${PAGE_D}:-:-`],
    ]);
  });

  it("traces a verb-marked typed-link hop (first candidateSpan, verb on the row)", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      setContent(PAGE_B, [
        { type: "text", text: "this supports " },
        mention(PAGE_A),
        typedLink("supports", "supports", [PAGE_A]),
      ]),
    );
    expect(compact(forwardPaths(store, PAGE_A))).toEqual([
      [`${PAGE_A}:typed_link:supports`, `${PAGE_B}:-:-`],
    ]);
  });

  it("a typed link whose nearest candidate is ANOTHER node hops only as a plain mention", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createPage(PAGE_C),
      setContent(PAGE_C, [
        mention(PAGE_B),
        mention(PAGE_A),
        typedLink("supports", "supports", [PAGE_B, PAGE_A]),
      ]),
    );
    // A is the verb's SECOND candidate — no verb-marked hop; the plain
    // mention edge still honestly claims the consumer.
    expect(compact(forwardPaths(store, PAGE_A))).toEqual([
      [`${PAGE_A}:mention:-`, `${PAGE_C}:-:-`],
    ]);
    // …while the nearest candidate gets the verb.
    expect(compact(forwardPaths(store, PAGE_B))).toEqual([
      [`${PAGE_B}:typed_link:supports`, `${PAGE_C}:-:-`],
    ]);
  });

  it("distinguishes plain mentions from embedded ones", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createPage(PAGE_C),
      setContent(PAGE_B, [mention(PAGE_A)]),
      setContent(PAGE_C, [mention(PAGE_A, true)]),
    );
    // Both consumers are reachable; embed ranks ahead of mention.
    expect(compact(forwardPaths(store, PAGE_A))).toEqual([
      [`${PAGE_A}:embed:-`, `${PAGE_C}:-:-`],
      [`${PAGE_A}:mention:-`, `${PAGE_B}:-:-`],
    ]);
  });

  it("an embed_ref carried on a block lands on the block (the authored carrier)", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createBlock(BLOCK_B1, PAGE_B),
      setContent(BLOCK_B1, [embedRef(PAGE_A)]),
    );
    expect(compact(forwardPaths(store, PAGE_A))).toEqual([
      [`${PAGE_A}:embed:-`, `${BLOCK_B1}:-:-`],
    ]);
  });

  it("cycle safety: a→b→a terminates with the finite path", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      setContent(PAGE_B, [embedRef(PAGE_A)]),
      setContent(PAGE_A, [embedRef(PAGE_B)]),
    );
    expect(compact(forwardPaths(store, PAGE_A))).toEqual([
      [`${PAGE_A}:embed:-`, `${PAGE_B}:-:-`],
    ]);
    expect(compact(forwardPaths(store, PAGE_B))).toEqual([
      [`${PAGE_B}:embed:-`, `${PAGE_A}:-:-`],
    ]);
  });

  it("branching yields one path per reachable chain", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createPage(PAGE_C),
      createPage(PAGE_D),
      setContent(PAGE_B, [embedRef(PAGE_A)]),
      setContent(PAGE_C, [mention(PAGE_A)]),
      // PAGE_D consumes BOTH B and C — one continuation per branch.
      setContent(PAGE_D, [mention(PAGE_B), mention(PAGE_C)]),
    );
    expect(compact(forwardPaths(store, PAGE_A))).toEqual([
      [`${PAGE_A}:embed:-`, `${PAGE_B}:mention:-`, `${PAGE_D}:-:-`],
      [`${PAGE_A}:mention:-`, `${PAGE_C}:mention:-`, `${PAGE_D}:-:-`],
    ]);
  });

  it("trashed consumers do not claim a hop", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      setContent(PAGE_B, [embedRef(PAGE_A)]),
      env("object.update", { objectId: PAGE_B, active: false }),
    );
    expect(forwardPaths(store, PAGE_A)).toEqual([]);
  });

  it("alias-terminal mentions count (resolved_target_id roll-up)", () => {
    const store = setup(
      createPage(PAGE_A),
      createPage(PAGE_B),
      createPage(PAGE_C),
      // C is an alias page of B; the mention targets C but resolves to B.
      env("object.update", { objectId: PAGE_C, aliasedNodeId: PAGE_B }),
      setContent(PAGE_A, [mention(PAGE_C)]),
    );
    expect(compact(forwardPaths(store, PAGE_B))).toEqual([
      [`${PAGE_B}:mention:-`, `${PAGE_A}:-:-`],
    ]);
  });
});
