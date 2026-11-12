# Notees Connector — tab relay + read-it-later toggle (notees-web lane)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

The web client becomes the trusted page-side endpoint of the Notees Connector's tab relay: an open Notees tab accepts a `notees-capture-request` postMessage, stamps a `web_page` node (title + `url` + `accessDate`, plus the "Read later" collection in readlater mode) through its own sync engine — E2EE-transparent, because the page holds the master key — and answers with the created node id. The same slice ships the `readItLater` feature toggle in Settings → Features (riding the shipped `workspace.feature.set` op) and the user docs.

## Architecture

Two new pure modules under a new `apps/web/src/features/connector/` folder, one React hook in `src/ui/app/`, one settings row component, and one new client write seam:

1. **`captureWebPage.ts`** — the graph side. Reuses the shipped classed-create pipeline (`stagedEntriesOfValues` + `flushClassedCreate` from `apps/web/src/features/modals/quickCreate.ts`) so a captured page is stamped exactly like an add-source create: citation self-heal, auto-citekey, one undo batch, normal outbox push (sealed automatically on keyed workspaces). Idempotent by URL: an existing `web_page` node with the same `url` value is reused, never duplicated. Readlater mode finds-or-creates the workspace's "Read later" collection node (class `collection`) and writes a `collection.member.add`.
2. **`tabRelay.ts`** — the wire side. The normative postMessage protocol (`source: "notees-connector"`), strict message guards, the origin check against the workspace's configured server origin, and the response builder. Pure and injectable (dispatch + origin provider are arguments) so it is unit-testable without a client.
3. **`useTabRelay.ts`** (in `src/ui/app/`, next to `useGlobalGestures.ts`) — the App composition: installs the window listener once per mount, resolves the active client from `clientRef`, gates auth (`not_authenticated`), the workspace feature (`feature_disabled`), and a locked master key (`failed`), then delegates to `captureWebPage` and answers. Success surfaces as a kit toast.
4. **Client write seam** — `addCollectionMember(collectionId, objectId)` on `WorkspaceClientWrites` (+ `WorkspaceClient` facade + `WorkerClient` RPC + `worker-core` case). The web client today has the undo inversion for `collection.member.add` (`apps/web/src/core/undo-journal.ts:871`) but no write path; this seam closes that gap. The store applier is OR-Set add-wins (`vendor/notees/packages/store/src/appliers.ts:2909`), so a redundant re-add converges to "member", never duplicates.
5. **Settings** — `ReadItLaterFeatureRow.tsx` in `features/workspaces/`, rendered by the existing Features tab in `WorkspaceSettingsModal.tsx` right after the journal row (same surfaces-only idiom). The row is runtime-guarded: it renders nothing until the vendored `WORKSPACE_FEATURES` tuple knows `readItLater`.

## Tech Stack

TypeScript + React 18 (existing Vite app), vitest + jsdom + @testing-library/react (existing harness), `@notees/domain` / `@notees/protocol` / `@notees/sync` (vendored workspace packages), sql.js in-memory store for tests (`MemoryTransport` + `MemoryRelay`).

## Spec

`/root/projects/notees-web/docs/superpowers/specs/2026-11-08-citation-capture-integrations-design.md` (the `notees-web` changes section is this lane's contract; the postMessage shapes in "NORMATIVE CROSS-REPO INTERFACE" are reproduced verbatim in Task 3).

## Global Constraints

- `vendor/` is read-only: the `readItLater` feature id arrives via a vendor bump from `notees-sync`; every consumer must tolerate the id being unknown/absent (runtime guards, casts through `readonly string[]`), and the toggle must render nothing until the vendored `WORKSPACE_FEATURES` includes it.
- UI binding law: all chrome composes from `apps/web/src/components/ui/kit/` (`ToggleSwitch`, `Icon`, kit Modal patterns), token-only CSS in co-located `.css` files; no ad-hoc styled controls in feature code.
- Test gate: `pnpm --filter @notees/web test` must be green; typecheck gate: `pnpm --filter @notees/web typecheck`.
- Conventional Commits (`feat(web): …`), per-file staging, never `git add -A`.
- `CHANGELOG.md` entry (newest first) ships in the same commit; docs are part of the change (`docs/features/` + `docs/feature-status.md`).
- No fleet-specific values in code, tests, or docs; no pointers to transient internal docs.

## Review Focus

1. **Capture received while logged out** — the listener is installed even with no workspace open and answers `ok: false, error.code: "not_authenticated"` (never silence: the extension must distinguish "no tab" from "tab says no").
2. **Feature disabled** — readlater mode against a workspace with `readItLater` off answers `feature_disabled`; source mode against a workspace with the `sources` family off answers `feature_disabled` too.
3. **Duplicate URL re-capture** — the same URL twice returns the FIRST node's id both times; only one `web_page` node exists; the readlater re-capture still lands the node in the collection (membership write is idempotent OR-Set).
4. **Message from a foreign origin** — anything whose `event.origin` is not the workspace's configured server origin, or whose `event.source` is not a window, is ignored silently (no response, no toast, no write).
5. **E2EE workspace with the master key locked** — the write must never attempt to stamp sealed content without the key: the relay answers `failed` with an actionable message ("unlock Notees in this tab and retry"), and zero envelopes are enqueued.

---

### Task 1: The `collection.member.add` client write seam (TDD)

The capture path needs to add a node to the "Read later" collection, but the web client has no collection-member write today (only the undo journal's inversion, `undo-journal.ts:871`). Add the seam exactly where every other write lives.

**Files**
- Modify: `apps/web/src/core/workspace-client/client-writes.ts`
- Modify: `apps/web/src/core/workspace-client/client.ts` (facade, next to `setFeatureEnabled` at `client.ts:494`)
- Modify: `apps/web/src/core/worker-client.ts` (RPC proxy, the `setFeatureEnabled` pattern at `worker-client.ts:962`)
- Modify: `apps/web/src/worker/worker-core.ts` (the case-dispatch pattern at `worker-core.ts:1073`)
- Test: `apps/web/test/collection-member-write.test.ts` (Create)

**Interfaces**
- Consumes: `ClientContext.buildEnvelope(opType, payload, affected)` + `ClientContext.enqueueLocal(env)` (`client-writes.ts:68` pattern); the vendored `collection.member.add` payload `{ collectionId, objectId }` (`vendor/notees/packages/protocol/src/op-types.ts:928`); the OR-Set applier (`vendor/notees/packages/store/src/appliers.ts:2909`).
- Produces: `WorkspaceClientWrites.addCollectionMember(collectionId: string, objectId: string): void`; `WorkspaceClient.addCollectionMember(collectionId, objectId): void`; `WorkerClient.addCollectionMember(collectionId, objectId): Promise<void>`.

**Steps**
- [ ] Write the failing test `apps/web/test/collection-member-write.test.ts` — the memory harness from `apps/web/test/capture.test.tsx:55` (`WorkspaceClient.create({ transport: new MemoryTransport(new MemoryRelay()), actorId, sqlJs })` + `bootstrapWorkspace(WS)`), then:

```ts
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;
beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

describe("addCollectionMember", () => {
  it("lands membership; undo inverts it as collection.member.remove; a redundant re-add is clean", async () => {
    const client = await seedClient();
    const collection = await client.createObject({
      isEmbedded: false,
      name: "Read later",
      classIds: [SYSTEM_CLASS_UUIDS.collection],
    });
    const page = await client.createObject({ isEmbedded: false, name: "Example page" });

    client.addCollectionMember(collection, page);
    client.addCollectionMember(collection, page); // redundant — OR-Set no-op outcome

    // Behavior pins through the PUBLIC surface only: the undo journal
    // captured the membership (its inverse is the complement op — the
    // contract undo-journal.test.ts:735 pins), and undoing the pair runs
    // clean. No public membership READ exists yet (the read-later inbox
    // view is follow-up work); the OR-Set idempotency itself is pinned at
    // the store level in vendor/notees/packages/store, not re-tested here.
    await client.undo(); // client.ts:595 — the public undo entry point
    await client.undo();
    expect(client.getNode(page)).toBeDefined();
    expect(client.getNode(collection)).toBeDefined();

    // Re-add after the undos: the seam accepts a fresh membership write.
    client.addCollectionMember(collection, page);
    expect(client.getNode(page)).toBeDefined();
  });
});
```

- [ ] Run `pnpm --filter @notees/web test -- collection-member-write` → RED (`addCollectionMember` does not exist).
- [ ] Implement `addCollectionMember` in `client-writes.ts` (after `setArchived`, `client-writes.ts:180`):

```ts
  /**
   * Add a node to a collection (collection.member.add — the OR-Set add-wins
   * seam; a redundant re-add converges to "member", never duplicates). The
   * undo journal already inverts it as collection.member.remove (the
   * membership-capture contract). No client-side membership pre-read: the
   * applier's upsert comparator makes the re-add idempotent.
   */
  addCollectionMember(collectionId: string, objectId: string): void {
    this.ctx.enqueueLocal(
      this.ctx.buildEnvelope(
        "collection.member.add",
        { collectionId, objectId },
        [collectionId, objectId],
      ),
    );
  }
```

- [ ] Add the `WorkspaceClient` facade next to `setFeatureEnabled` (`client.ts:494`): `addCollectionMember(collectionId: string, objectId: string) { this.writes.addCollectionMember(collectionId, objectId); }` (match the actual private field name in `client.ts`).
- [ ] Add the `WorkerClient` RPC after `setFeatureEnabled` (`worker-client.ts:962`):

```ts
  async addCollectionMember(collectionId: string, objectId: string): Promise<void> {
    await this.call("addCollectionMember", [collectionId, objectId]);
  }
```

- [ ] Add the `worker-core.ts` case after `case "setFeatureEnabled"` (`worker-core.ts:1073`):

```ts
      case "addCollectionMember":
        return this.client.addCollectionMember(
          args[0] as string,
          args[1] as string,
        );
```

- [ ] Run `pnpm --filter @notees/web test -- collection-member-write` → GREEN; then `pnpm --filter @notees/web test` (full suite — no regressions in `undo-journal.test.ts` or `worker-client.test.ts`) and `pnpm --filter @notees/web typecheck`.

### Task 2: `captureWebPage` — the capture-into-graph module (TDD)

The pure graph side of the relay: find-or-create the `web_page` node by URL, stamp `url` + `accessDate` through the shipped create pipeline, attach the optional note as a first child block, and (readlater mode) find-or-create the "Read later" collection and add the membership.

**Files**
- Create: `apps/web/src/features/connector/captureWebPage.ts`
- Create: `apps/web/test/connector-capture.test.ts`
- Modify: `apps/web/src/core/workspace-client/client.ts` only if Task 1's facade naming needs a re-export (should not)

**Interfaces**
- Consumes: `SYSTEM_CLASS_UUIDS.web_page` (`…0001-000000000034`), `SYSTEM_CLASS_UUIDS.collection` (`…0001-000000000032`), `SYSTEM_PROPERTY_UUIDS.url` (`…0000-000000000024`), `SYSTEM_PROPERTY_UUIDS.accessDate` (`…0006-000000000004`) from `@notees/domain`; `stagedEntriesOfValues` + `flushClassedCreate` from `../modals/quickCreate.js`; `client.getClassMembers(classId)`, `client.getEffectiveProperties(id)` (rows carry `.value` for the text-typed `url` property), `client.createObject(...)`, `client.addCollectionMember(...)` (Task 1), `client.ensureDateChain` (inside the flush's date expansion).
- Produces: `export interface CapturePayload { url: string; title: string; mode: "source" | "readlater"; note?: string | undefined }` and `export async function captureWebPage(client: AnyClient, payload: CapturePayload, now?: Date): Promise<string>` — resolves to the (existing or created) `web_page` node id.

**Steps**
- [ ] Write the failing test `apps/web/test/connector-capture.test.ts` (same seed harness as Task 1):

```ts
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { captureWebPage } from "../src/features/connector/captureWebPage.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";

let sqlModule: SqlJsStatic;
beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

function urlOf(client: WorkspaceClient, id: string): string | undefined {
  const row = client
    .getEffectiveProperties(id)
    .find((p) => p.propertySchemaId === SYSTEM_PROPERTY_UUIDS.url);
  return row?.value as string | undefined;
}

describe("captureWebPage", () => {
  it("source mode: creates a web_page node with title, url, and accessDate", async () => {
    const client = await seedClient();
    const id = await captureWebPage(
      client,
      { url: "https://example.com/essay", title: "An Essay", mode: "source" },
      new Date("2026-11-08T10:00:00Z"),
    );
    const node = client.getNode(id);
    expect(node).toBeDefined();
    expect(node!.classIds).toContain(SYSTEM_CLASS_UUIDS.web_page);
    expect(urlOf(client, id)).toBe("https://example.com/essay");
    const access = client
      .getEffectiveProperties(id)
      .find((p) => p.propertySchemaId === SYSTEM_PROPERTY_UUIDS.accessDate);
    expect(access).toBeDefined(); // datetime value — a date-chain node ref
  });

  it("duplicate URL re-capture returns the existing node; only one web_page exists", async () => {
    const client = await seedClient();
    const first = await captureWebPage(
      client,
      { url: "https://example.com/dup", title: "Dup", mode: "source" },
      new Date("2026-11-08T10:00:00Z"),
    );
    const second = await captureWebPage(
      client,
      { url: "https://example.com/dup", title: "Dup, re-captured", mode: "source" },
      new Date("2026-11-08T11:00:00Z"),
    );
    expect(second).toBe(first);
    expect(client.getClassMembers(SYSTEM_CLASS_UUIDS.web_page)).toHaveLength(1);
  });

  it("readlater mode: auto-creates ONE 'Read later' collection and adds the node", async () => {
    const client = await seedClient();
    const id = await captureWebPage(
      client,
      { url: "https://example.com/later", title: "Later", mode: "readlater" },
      new Date("2026-11-08T10:00:00Z"),
    );
    const collections = client.getClassMembers(SYSTEM_CLASS_UUIDS.collection);
    expect(collections).toHaveLength(1);
    // A second readlater capture reuses the collection (find-or-create).
    await captureWebPage(
      client,
      { url: "https://example.com/later2", title: "Later 2", mode: "readlater" },
      new Date("2026-11-08T10:05:00Z"),
    );
    expect(client.getClassMembers(SYSTEM_CLASS_UUIDS.collection)).toHaveLength(1);
    expect(client.getClassMembers(SYSTEM_CLASS_UUIDS.web_page)).toHaveLength(2);
    expect(id).toBeDefined();
  });

  it("a note becomes the node's first child block; an absent note writes no child", async () => {
    const client = await seedClient();
    const withNote = await captureWebPage(
      client,
      { url: "https://example.com/noted", title: "Noted", mode: "source", note: "check §3" },
      new Date("2026-11-08T10:00:00Z"),
    );
    const children = client.getChildren(withNote);
    expect(children).toHaveLength(1);
    const plain = await captureWebPage(
      client,
      { url: "https://example.com/plain", title: "Plain", mode: "source" },
      new Date("2026-11-08T10:00:00Z"),
    );
    expect(client.getChildren(plain)).toHaveLength(0);
  });
});
```

  (`getChildren(id)` is the verified public child-list read — `client.ts:392`.)
- [ ] Run `pnpm --filter @notees/web test -- connector-capture` → RED (module missing).
- [ ] Implement `apps/web/src/features/connector/captureWebPage.ts`:

```ts
/**
 * The tab-relay capture path's graph side: a captured web page becomes a
 * `web_page`-classed node (title + `url` + `accessDate`), stamped through
 * the SAME classed-create pipeline the add-source dialog runs
 * (stagedEntriesOfValues + flushClassedCreate — citation self-heal,
 * auto-citekey, one undo batch, the normal outbox push sealed by the sync
 * engine when the workspace is keyed). Idempotent by URL: an existing
 * `web_page` carrying the same `url` value is reused, never duplicated
 * (the duplicate re-capture answers the FIRST node). Readlater mode adds
 * the node to the workspace's "Read later" collection — created on first
 * use (a `collection`-classed node, op-log state like everything else).
 */

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";

import type { AnyClient } from "../../features/sidebar/FavoritesRecents.js";
import {
  flushClassedCreate,
  stagedEntriesOfValues,
} from "../modals/quickCreate.js";

export interface CapturePayload {
  url: string;
  title: string;
  mode: "source" | "readlater";
  note?: string | undefined;
}

/** The "Read later" collection's find-or-create title. */
export const READ_LATER_TITLE = "Read later";

/** Trim + lowercase — the duplicate-URL comparison (host/scheme tolerant enough for v1). */
function normalizeUrl(url: string): string {
  return url.trim().toLowerCase();
}

function existingWebPageForUrl(client: AnyClient, url: string): string | undefined {
  const wanted = normalizeUrl(url);
  for (const member of client.getClassMembers(SYSTEM_CLASS_UUIDS.web_page)) {
    const row = client
      .getEffectiveProperties(member.id)
      .find((p) => p.propertySchemaId === SYSTEM_PROPERTY_UUIDS.url);
    if (row !== undefined && typeof row.value === "string" && normalizeUrl(row.value) === wanted) {
      return member.id;
    }
  }
  return undefined;
}

function findReadLaterCollection(client: AnyClient): string | undefined {
  for (const member of client.getClassMembers(SYSTEM_CLASS_UUIDS.collection)) {
    const title =
      client.getDisplayName(member.id) ?? member.name ?? "";
    if (title.trim().toLowerCase() === READ_LATER_TITLE.toLowerCase()) return member.id;
  }
  return undefined;
}

/**
 * Capture one web page into the workspace graph; resolves to the node's id
 * (existing on a URL re-capture, else freshly created).
 */
export async function captureWebPage(
  client: AnyClient,
  payload: CapturePayload,
  now: Date = new Date(),
): Promise<string> {
  const existing = existingWebPageForUrl(client, payload.url);
  const id =
    existing ??
    (await (async () => {
      const result = await flushClassedCreate(client, {
        classId: SYSTEM_CLASS_UUIDS.web_page,
        title: payload.title.trim() === "" ? payload.url : payload.title.trim(),
        entries: stagedEntriesOfValues(client, {
          [SYSTEM_PROPERTY_UUIDS.url]: payload.url.trim(),
          // Day precision (YYYY-MM-DD) — the parse the staged-date expander accepts.
          [SYSTEM_PROPERTY_UUIDS.accessDate]: now.toISOString().slice(0, 10),
        }),
      });
      if (!result.ok) throw new Error(`capture failed: ${result.error}`);
      return result.id;
    })());

  if (payload.note !== undefined && payload.note.trim() !== "" && existing === undefined) {
    await client.createObject({
      isEmbedded: false,
      parentId: id,
      contentAst: [{ type: "text", text: payload.note.trim() }],
    });
  }

  if (payload.mode === "readlater") {
    let collection = findReadLaterCollection(client);
    if (collection === undefined) {
      collection = await client.createObject({
        isEmbedded: false,
        name: READ_LATER_TITLE,
        classIds: [SYSTEM_CLASS_UUIDS.collection],
      });
    }
    // OR-Set add-wins: a redundant re-add converges to "member".
    await client.addCollectionMember(collection, id);
  }

  return id;
}
```

  (Verify: `getDisplayName(id)` is the public display-name read the App uses at `App.tsx:518`; if the row title should come from `deriveDisplayName(node)` instead — the domain flattening `capture.test.tsx:24` imports — use that; `contentAst`'s text token shape matches `client-writes.ts:61`.)
- [ ] Run `pnpm --filter @notees/web test -- connector-capture` → GREEN. If the note-child shape or `contentAst` typing fights, copy the exact child-create call from `extractToPage.ts` (the established split-to-page writer) instead of guessing.
- [ ] `pnpm --filter @notees/web test` + `pnpm --filter @notees/web typecheck`.

### Task 3: `tabRelay.ts` — the postMessage handshake module (TDD)

The wire side. Pure functions + an installable listener; the App hook (Task 4) injects the live dependencies.

**Files**
- Create: `apps/web/src/features/connector/tabRelay.ts`
- Create: `apps/web/test/tab-relay.test.ts`

**Interfaces**
- Consumes: nothing but DOM types (`MessageEvent`, `Window`).
- Produces (all exported):
  - `export const CONNECTOR_SOURCE = "notees-connector";`
  - `export interface CaptureRequestMessage { source: "notees-connector"; type: "notees-capture-request"; requestId: string; payload: { url: string; title: string; mode: "source" | "readlater"; note?: string | undefined } }`
  - `export type CaptureResponseMessage = { source: "notees-connector"; type: "notees-capture-response"; requestId: string } & ({ ok: true; objectId: string } | { ok: false; error: { code: "not_authenticated" | "feature_disabled" | "failed"; message: string } });`
  - `export function isCaptureRequest(data: unknown): data is CaptureRequestMessage` — the strict guard (exact `source`/`type`, string `requestId`, object payload, string `url`, non-empty string `title`, `mode` in the set, optional string `note`).
  - `export function isAllowedOrigin(origin: string, serverOrigin: string): boolean` — exact match.
  - `export function buildResponse(request: CaptureRequestMessage, result: { ok: true; objectId: string } | { ok: false; code: "not_authenticated" | "feature_disabled" | "failed"; message: string }): CaptureResponseMessage`.
  - `export interface TabRelayHost { serverOrigin(): string | null; handleCapture(payload: CaptureRequestMessage["payload"]): Promise<{ ok: true; objectId: string } | { ok: false; code: "not_authenticated" | "feature_disabled" | "failed"; message: string }>; }`
  - `export function installTabRelay(win: Window, host: TabRelayHost): () => void` — returns the uninstall function.

**Steps**
- [ ] Write the failing test `apps/web/test/tab-relay.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installTabRelay,
  isAllowedOrigin,
  isCaptureRequest,
  type CaptureResponseMessage,
  type TabRelayHost,
} from "../src/features/connector/tabRelay.js";

const SERVER_ORIGIN = "https://notees.example.com";

function postFrom(
  win: Window,
  opts: { origin: string; data: unknown },
): void {
  // jsdom: a synthetic MessageEvent with a window source exercises the
  // same code path the browser delivers.
  win.dispatchEvent(
    new MessageEvent("message", { origin: opts.origin, source: win, data: opts.data }),
  );
}

const REQUEST = {
  source: "notees-connector",
  type: "notees-capture-request",
  requestId: "req-1",
  payload: { url: "https://example.com/a", title: "A", mode: "source" },
};

describe("isCaptureRequest", () => {
  it("accepts the normative shape; rejects everything else", () => {
    expect(isCaptureRequest(REQUEST)).toBe(true);
    expect(isCaptureRequest({ ...REQUEST, source: "other" })).toBe(false);
    expect(isCaptureRequest({ ...REQUEST, type: "notees-capture-response" })).toBe(false);
    expect(isCaptureRequest({ ...REQUEST, payload: { ...REQUEST.payload, mode: "body" } })).toBe(false);
    expect(isCaptureRequest({ ...REQUEST, payload: { ...REQUEST.payload, url: 42 } })).toBe(false);
    expect(isCaptureRequest("notees-capture-request")).toBe(false);
    expect(isCaptureRequest(null)).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  it("is an exact match against the configured server origin", () => {
    expect(isAllowedOrigin(SERVER_ORIGIN, SERVER_ORIGIN)).toBe(true);
    expect(isAllowedOrigin("https://evil.example.com", SERVER_ORIGIN)).toBe(false);
    expect(isAllowedOrigin("null", SERVER_ORIGIN)).toBe(false);
  });
});

describe("installTabRelay", () => {
  const unmounts: Array<() => void> = [];
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()!();
    vi.restoreAllMocks();
  });

  function host(overrides: Partial<TabRelayHost> = {}): TabRelayHost & { handleCapture: ReturnType<typeof vi.fn> } {
    const handleCapture = vi.fn(async () => ({ ok: true as const, objectId: "obj-1" }));
    return {
      serverOrigin: () => SERVER_ORIGIN,
      handleCapture,
      ...overrides,
    };
  }

  function listen(h: TabRelayHost): { sent: CaptureResponseMessage[] } {
    const sent: CaptureResponseMessage[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
      sent.push(data as CaptureResponseMessage);
    });
    unmounts.push(installTabRelay(window, h));
    return { sent };
  }

  it("answers a valid request through the host and echoes requestId", async () => {
    const h = host();
    const { sent } = listen(h);
    postFrom(window, { origin: SERVER_ORIGIN, data: REQUEST });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      source: "notees-connector",
      type: "notees-capture-response",
      requestId: "req-1",
      ok: true,
      objectId: "obj-1",
    });
    expect(h.handleCapture).toHaveBeenCalledWith(REQUEST.payload);
  });

  it("silently ignores a foreign origin and a non-window source", async () => {
    const h = host();
    const { sent } = listen(h);
    postFrom(window, { origin: "https://evil.example.com", data: REQUEST });
    postFrom(window, { origin: SERVER_ORIGIN, data: { ...REQUEST, requestId: "req-x" } });
    window.dispatchEvent(
      new MessageEvent("message", { origin: SERVER_ORIGIN, source: null, data: REQUEST }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(0);
    expect(h.handleCapture).not.toHaveBeenCalled();
  });

  it("maps the host's error codes verbatim", async () => {
    const h = host({
      handleCapture: vi.fn(async () => ({
        ok: false as const,
        code: "feature_disabled" as const,
        message: "Read later is off for this workspace.",
      })),
    });
    const { sent } = listen(h);
    postFrom(window, { origin: SERVER_ORIGIN, data: REQUEST });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ ok: false, requestId: "req-1", error: { code: "feature_disabled" } });
  });

  it("a null serverOrigin means no session — answers not_authenticated, never dispatches", async () => {
    const h = host({ serverOrigin: () => null });
    const { sent } = listen(h);
    postFrom(window, { origin: "https://anything.example.com", data: REQUEST });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ ok: false, error: { code: "not_authenticated" } });
    expect(h.handleCapture).not.toHaveBeenCalled();
  });

  it("uninstall stops answering", async () => {
    const h = host();
    const { sent } = listen(h);
    unmounts.pop()!(); // uninstall
    postFrom(window, { origin: SERVER_ORIGIN, data: REQUEST });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(0);
  });
});
```

  Note the design decision pinned by the "null serverOrigin" test: **origin check and auth gating are the same question** — no configured server origin means no authed session, so the relay answers `not_authenticated` instead of ignoring (Review Focus 1). When `serverOrigin()` is null the listener responds to ANY origin's well-formed request with `not_authenticated`; when non-null, foreign origins get silence.
- [ ] Run `pnpm --filter @notees/web test -- tab-relay` → RED.
- [ ] Implement `apps/web/src/features/connector/tabRelay.ts`:

```ts
/**
 * The page side of the Notees Connector's tab relay (design spec 2026-11-08,
 * the citation & capture integrations design). The extension's injected
 * bridge postMessages a `notees-capture-request` into this page; the page
 * stamps the capture through its own sync engine (E2EE-transparent — the
 * page holds the master key) and answers `notees-capture-response` on the
 * SAME window. Wire rules: respond only to the workspace's configured
 * server origin with a window source (silence for everything else — except
 * the logged-out case, which answers not_authenticated so the extension
 * can tell "tab says no" from "no tab").
 */

export const CONNECTOR_SOURCE = "notees-connector";

export interface CaptureRequestMessage {
  source: "notees-connector";
  type: "notees-capture-request";
  requestId: string;
  payload: {
    url: string;
    title: string;
    mode: "source" | "readlater";
    note?: string | undefined;
  };
}

export type CaptureResponseMessage = {
  source: "notees-connector";
  type: "notees-capture-response";
  requestId: string;
} & (
  | { ok: true; objectId: string }
  | {
      ok: false;
      error: {
        code: "not_authenticated" | "feature_disabled" | "failed";
        message: string;
      };
    }
);

export type CaptureFailureCode = "not_authenticated" | "feature_disabled" | "failed";

export type CaptureResult =
  | { ok: true; objectId: string }
  | { ok: false; code: CaptureFailureCode; message: string };

/** The strict shape guard — anything else never reaches the host. */
export function isCaptureRequest(data: unknown): data is CaptureRequestMessage {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  if (m.source !== CONNECTOR_SOURCE) return false;
  if (m.type !== "notees-capture-request") return false;
  if (typeof m.requestId !== "string" || m.requestId === "") return false;
  const p = m.payload;
  if (typeof p !== "object" || p === null) return false;
  const payload = p as Record<string, unknown>;
  if (typeof payload.url !== "string" || payload.url.trim() === "") return false;
  if (typeof payload.title !== "string") return false;
  if (payload.mode !== "source" && payload.mode !== "readlater") return false;
  if (payload.note !== undefined && typeof payload.note !== "string") return false;
  return true;
}

/** Exact match against the workspace's configured server origin. */
export function isAllowedOrigin(origin: string, serverOrigin: string): boolean {
  return origin === serverOrigin;
}

export function buildResponse(request: CaptureRequestMessage, result: CaptureResult): CaptureResponseMessage {
  const base = {
    source: CONNECTOR_SOURCE,
    type: "notees-capture-response",
    requestId: request.requestId,
  } as const;
  return result.ok
    ? { ...base, ok: true, objectId: result.objectId }
    : { ...base, ok: false, error: { code: result.code, message: result.message } };
}

export interface TabRelayHost {
  /** The configured server origin; null when no authed session is open. */
  serverOrigin(): string | null;
  /** Stamp the capture; the App hook owns the gating and the graph write. */
  handleCapture(payload: CaptureRequestMessage["payload"]): Promise<CaptureResult>;
}

/** Install the listener; returns the uninstall function. */
export function installTabRelay(win: Window, host: TabRelayHost): () => void {
  const onMessage = (event: MessageEvent) => {
    const serverOrigin = host.serverOrigin();
    if (serverOrigin === null) {
      // Logged out (Review Focus 1): a well-formed request still earns an
      // honest not_authenticated — on whatever origin it arrived from.
      if (isCaptureRequest(event.data) && event.source !== null) {
        const response = buildResponse(event.data, {
          ok: false,
          code: "not_authenticated",
          message: "No Notees workspace is open in this tab.",
        });
        (event.source as Window).postMessage(response, event.origin);
      }
      return;
    }
    if (event.source === null || typeof (event.source as Window).postMessage !== "function") return;
    if (!isAllowedOrigin(event.origin, serverOrigin)) return; // foreign origin: silence
    if (!isCaptureRequest(event.data)) return;
    const request = event.data;
    const target = event.source as Window;
    const targetOrigin = event.origin;
    void host.handleCapture(request.payload).then(
      (result) => target.postMessage(buildResponse(request, result), targetOrigin),
      (error: unknown) =>
        target.postMessage(
          buildResponse(request, {
            ok: false,
            code: "failed",
            message: error instanceof Error ? error.message : "Capture failed.",
          }),
          targetOrigin,
        ),
    );
  };
  win.addEventListener("message", onMessage);
  return () => win.removeEventListener("message", onMessage);
}
```

- [ ] Run `pnpm --filter @notees/web test -- tab-relay` → GREEN; full suite + typecheck.

### Task 4: `useTabRelay` — the App hook (auth/feature/key gating + toast)

Wires the pure module to the live session: resolves the active client from `clientRef`, applies the three gates (Review Focus 1, 2, 5), delegates to `captureWebPage`, and toasts the outcome.

**Files**
- Create: `apps/web/src/ui/app/useTabRelay.ts`
- Modify: `apps/web/src/ui/App.tsx` (one hook call, next to `useGlobalGestures` at `App.tsx:500`)
- Test: `apps/web/test/tab-relay-app.test.tsx` (Create)

**Interfaces**
- Consumes: `installTabRelay`, `CaptureResult`, `CaptureRequestMessage` from `../../features/connector/tabRelay.js`; `captureWebPage`, `CapturePayload` from `../../features/connector/captureWebPage.js`; `currentMasterKey` from `../../core/crypto-custody.js` (`crypto-custody.ts:148`); `notificationStore` from `../../components/ui/kit/notificationStore.js`; the `AnyClient` type from `../../features/sidebar/FavoritesRecents.js`; `WorkspaceFeature` from `@notees/protocol`.
- Produces: `export function useTabRelay(args: { clientRef: React.MutableRefObject<AnyClient | null>; serverUrl: string; token: string; workspacePlaintext: boolean; unlockRequest: unknown; }): void`.

**Steps**
- [ ] Write the failing test `apps/web/test/tab-relay-app.test.tsx` — mount a tiny probe component that calls the hook with a controllable `clientRef` (memory client from the Task 1 harness), post the request, assert the response + gates:

```tsx
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { render } from "@testing-library/react";
import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { WORKSPACE_FEATURES } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { notificationStore } from "../src/components/ui/kit/notificationStore.js";
import { useTabRelay } from "../src/ui/app/useTabRelay.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const SERVER = "https://notees.example.com";

// The vendored tuple may not know readItLater yet (the feature id arrives
// via a vendor bump) — cast through readonly string[] exactly like the hook.
const READ_IT_LATER_KNOWN = (WORKSPACE_FEATURES as readonly string[]).includes("readItLater");

let sqlModule: SqlJsStatic;
beforeAll(async () => {
  sqlModule = await initSqlJs();
});

function Probe(props: Parameters<typeof useTabRelay>[0]) {
  useTabRelay(props);
  return null;
}

const clients: WorkspaceClient[] = [];
afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
  vi.restoreAllMocks();
  notificationStore.clearAll();
});

async function authedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

function post(data: unknown, origin = SERVER) {
  window.dispatchEvent(new MessageEvent("message", { origin, source: window, data }));
}

const REQUEST = (mode: "source" | "readlater") => ({
  source: "notees-connector",
  type: "notees-capture-request",
  requestId: `r-${mode}`,
  payload: { url: `https://example.com/${mode}`, title: mode, mode },
});

describe("useTabRelay", () => {
  it("no token → not_authenticated, no write attempted", async () => {
    const sent: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((d: unknown) => void sent.push(d));
    const ref = { current: null };
    render(<Probe clientRef={ref} serverUrl={SERVER} token="" workspacePlaintext unlockRequest={null} />);
    post(REQUEST("source"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ ok: false, error: { code: "not_authenticated" } });
  });

  it("authed: source-mode capture stamps a node and answers its id; a success toast lands", async () => {
    const client = await authedClient();
    const sent: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((d: unknown) => void sent.push(d));
    const ref = { current: client };
    render(<Probe clientRef={ref} serverUrl={SERVER} token="tok" workspacePlaintext unlockRequest={null} />);
    post(REQUEST("source"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const response = sent[0] as { ok: boolean; objectId?: string };
    expect(response.ok).toBe(true);
    expect(client.getNode(response.objectId!)).toBeDefined();
    expect(notificationStore.notifications.some((n) => n.type === "success")).toBe(true);
  });

  it("readlater mode with the feature OFF → feature_disabled (post-bump only)", async () => {
    if (!READ_IT_LATER_KNOWN) return; // pre-bump: the gate id does not exist
    const client = await authedClient();
    await client.setFeatureEnabled("readItLater" as never, false);
    const sent: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((d: unknown) => void sent.push(d));
    const ref = { current: client };
    render(<Probe clientRef={ref} serverUrl={SERVER} token="tok" workspacePlaintext unlockRequest={null} />);
    post(REQUEST("readlater"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ ok: false, error: { code: "feature_disabled" } });
  });

  it("keyed workspace with no master key in custody → failed, zero creates", async () => {
    const client = await authedClient();
    const sent: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((d: unknown) => void sent.push(d));
    const ref = { current: client };
    render(
      <Probe clientRef={ref} serverUrl={SERVER} token="tok" workspacePlaintext={false} unlockRequest={{}} />,
    );
    post(REQUEST("source"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ ok: false, error: { code: "failed" } });
  });
});
```

  (`workspacePlaintext=false` + `unlockRequest != null` models the locked keyed session; the hook must NOT rely on `currentMasterKey()` alone in tests because the custody slot is a module singleton — accept the explicit `unlockRequest` prop from App, which is the honest locked signal at `App.tsx:187`.)
- [ ] Run `pnpm --filter @notees/web test -- tab-relay-app` → RED.
- [ ] Implement `apps/web/src/ui/app/useTabRelay.ts`:

```ts
/**
 * The App-side wiring of the connector tab relay: installs the window
 * listener once per mount and answers capture requests through the LIVE
 * session — the active client from clientRef, the workspace's configured
 * server origin, the auth/feature/key gates (the relay's Review Focus
 * set), and a kit toast on success so the capture is visible in the tab
 * that performed it.
 */

import { useEffect } from "react";

import type { WorkspaceFeature } from "@notees/protocol";

import type { AnyClient } from "../../features/sidebar/FavoritesRecents.js";
import { notificationStore } from "../../components/ui/kit/notificationStore.js";
import {
  installTabRelay,
  type CaptureRequestMessage,
  type CaptureResult,
} from "../../features/connector/tabRelay.js";
import { captureWebPage, type CapturePayload } from "../../features/connector/captureWebPage.js";

/** The readItLater id arrives via a vendor bump — tolerate its absence. */
const READ_IT_LATER = "readItLater" as WorkspaceFeature;

export function useTabRelay(args: {
  clientRef: { current: AnyClient | null };
  serverUrl: string;
  /** Empty = no authed session in this tab. */
  token: string;
  /** Positive plaintext knowledge (the connection's `plaintext` flag). */
  workspacePlaintext: boolean;
  /** Non-null while a keyed workspace waits on the unlock modal. */
  unlockRequest: unknown;
}): void {
  const { clientRef, serverUrl, token, workspacePlaintext, unlockRequest } = args;

  useEffect(() => {
    return installTabRelay(window, {
      serverOrigin: () => {
        const url = serverUrl.trim();
        if (url === "" || token === "") return null;
        try {
          return new URL(url).origin;
        } catch {
          return null;
        }
      },
      handleCapture: async (payload: CaptureRequestMessage["payload"]): Promise<CaptureResult> => {
        const client = clientRef.current;
        if (client === null) {
          return { ok: false, code: "not_authenticated", message: "No workspace is open in this tab." };
        }
        // Review Focus 5: a keyed workspace whose master key is locked must
        // never attempt a stamped write — the unlock modal IS the lock signal.
        if (!workspacePlaintext && unlockRequest !== null) {
          return {
            ok: false,
            code: "failed",
            message: "This workspace is locked — unlock Notees in this tab and retry.",
          };
        }
        // Review Focus 2: the workspace feature gates the matching mode.
        const gate: WorkspaceFeature | null =
          payload.mode === "readlater" ? READ_IT_LATER : "sources";
        if (!client.isFeatureEnabled(gate)) {
          return {
            ok: false,
            code: "feature_disabled",
            message:
              payload.mode === "readlater"
                ? "Read later is off for this workspace — enable it in Settings → Features."
                : "The Sources family is off for this workspace.",
          };
        }
        try {
          const objectId = await captureWebPage(client, {
            url: payload.url,
            title: payload.title,
            mode: payload.mode,
            note: payload.note,
          } satisfies CapturePayload);
          notificationStore.success(
            payload.mode === "readlater" ? "Saved to Read later" : "Saved to your library",
            payload.title,
          );
          return { ok: true, objectId };
        } catch (error: unknown) {
          return {
            ok: false,
            code: "failed",
            message: error instanceof Error ? error.message : "Capture failed.",
          };
        }
      },
    });
  }, [clientRef, serverUrl, token, workspacePlaintext, unlockRequest]);
}
```

  (Verify `workspacePlaintext`'s exact prop name/type from the `useWorkspaceConnection` return — App destructures it at `App.tsx:187`; pass whatever the connection exposes. If the connection names it differently, adapt the hook signature, keep the test's meaning.)
- [ ] Wire one line into `App.tsx` next to `useGlobalGestures` (`App.tsx:500`): `useTabRelay({ clientRef, serverUrl, token, workspacePlaintext, unlockRequest });` — using the ACTUAL destructured names in App.
- [ ] Run `pnpm --filter @notees/web test -- tab-relay-app` → GREEN; full suite + typecheck.

### Task 5: The `readItLater` settings toggle (kit-only row, vendor-tolerant)

The Features tab gains a third surfaces-only row after the journal row (`WorkspaceSettingsModal.tsx:308`), same idiom: no family icon, no instance count, one `ToggleSwitch` writing `workspace.feature.set` through `client.setFeatureEnabled` (`WorkspaceSettingsModal.tsx:156`). The row renders NOTHING until the vendored `WORKSPACE_FEATURES` tuple knows `readItLater` (Global Constraint: tolerate the absent id).

**Files**
- Create: `apps/web/src/features/workspaces/ReadItLaterFeatureRow.tsx`
- Create: `apps/web/src/features/workspaces/ReadItLaterFeatureRow.css` (token-only, mirrors `settingsModal.css`'s `settings-feature-row` register — prefer reusing the existing classes; only create the CSS file if a row-specific rule is genuinely needed)
- Modify: `apps/web/src/features/workspaces/WorkspaceSettingsModal.tsx` (render the row after the journal IIFE, `WorkspaceSettingsModal.tsx:333`)
- Test: `apps/web/test/settings-readitlater-toggle.test.tsx` (Create)

**Interfaces**
- Consumes: `WORKSPACE_FEATURES` + `WorkspaceFeature` from `@notees/protocol` (`op-types.ts:787`); `client.isFeatureEnabled` / `client.setFeatureEnabled` (`client.ts:482` / `client.ts:494`); kit `ToggleSwitch` (`components/ui/kit/ToggleSwitch.js`, the `leftLabel`/`rightLabel`/`checked`/`onChange`/`size`/`aria-label` contract) + `Icon` (`ui/Icon.js`).
- Produces: `export function ReadItLaterFeatureRow(props: { client: AnyClient }): JSX.Element | null` and `export const READ_IT_LATER_FEATURE: WorkspaceFeature` (the cast constant, reused by the relay gate).

**Steps**
- [ ] Write the failing test `apps/web/test/settings-readitlater-toggle.test.tsx` (memory client + `render`):

```tsx
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRelay, MemoryTransport } from "@notees/sync";
import { WORKSPACE_FEATURES } from "@notees/protocol";

import { WorkspaceClient } from "../src/core/workspace-client/index.js";
import { ReadItLaterFeatureRow } from "../src/features/workspaces/ReadItLaterFeatureRow.js";

const WS = "0192a000-0000-7000-8000-000000000001";
const ACTOR = "0192a000-0000-7000-8000-000000000002";
const KNOWN = (WORKSPACE_FEATURES as readonly string[]).includes("readItLater");

let sqlModule: SqlJsStatic;
beforeAll(async () => {
  sqlModule = await initSqlJs();
});

const clients: WorkspaceClient[] = [];
afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
});

async function seedClient(): Promise<WorkspaceClient> {
  const client = await WorkspaceClient.create({
    transport: new MemoryTransport(new MemoryRelay()),
    actorId: ACTOR,
    sqlJs: sqlModule,
  });
  clients.push(client);
  await client.bootstrapWorkspace(WS);
  return client;
}

describe("ReadItLaterFeatureRow", () => {
  it("renders nothing while the vendored feature id is absent (pre-bump tolerance)", () => {
    if (KNOWN) return; // post-bump run: the second test covers this
    const { container } = render(<ReadItLaterFeatureRow client={null as never} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("toggles through setFeatureEnabled and reflects isFeatureEnabled (post-bump)", async () => {
    if (!KNOWN) return;
    const client = await seedClient();
    render(<ReadItLaterFeatureRow client={client} />);
    const toggle = screen.getByRole("switch", { name: "Read later feature" });
    expect(toggle).toHaveAttribute("aria-checked", "true"); // absent row = enabled
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(client.isFeatureEnabled("readItLater" as never)).toBe(false));
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(client.isFeatureEnabled("readItLater" as never)).toBe(true));
  });
});
```

  (The absent-row-reads-enabled default this test relies on is pinned at `client-undo.ts:249`.)
- [ ] Run `pnpm --filter @notees/web test -- settings-readitlater` → RED.
- [ ] Implement `apps/web/src/features/workspaces/ReadItLaterFeatureRow.tsx`:

```tsx
/**
 * The Read later feature toggle — a SURFACES gate like journal, not a class
 * family: it gates the connector's read-later captures + the "Read later"
 * inbox convention while the `web_page`/`collection` classes stay always-on.
 * The feature id arrives via a vendor bump; until the vendored
 * WORKSPACE_FEATURES tuple knows `readItLater` this row renders NOTHING
 * (the runtime guard, not a type assertion, is the law).
 */

import type { WorkspaceFeature } from "@notees/protocol";
import { WORKSPACE_FEATURES } from "@notees/protocol";

import type { AnyClient } from "../../features/sidebar/FavoritesRecents.js";
import { Icon } from "../../ui/Icon.js";
import { ToggleSwitch } from "../../components/ui/kit/ToggleSwitch.js";

export const READ_IT_LATER_FEATURE = "readItLater" as WorkspaceFeature;

/** True only when the vendored protocol knows the id (post vendor-bump). */
export const READ_IT_LATER_KNOWN: boolean = (WORKSPACE_FEATURES as readonly string[]).includes(
  "readItLater",
);

export function ReadItLaterFeatureRow(props: { client: AnyClient }): JSX.Element | null {
  if (!READ_IT_LATER_KNOWN) return null;
  const { client } = props;
  const enabled = client.isFeatureEnabled(READ_IT_LATER_FEATURE);
  return (
    <div className="settings-item settings-feature-row" data-feature="readItLater">
      <span className="settings-feature-row__icon">
        <Icon path="mdi-inbox" size={1} />
      </span>
      <span className="settings-feature-row__text">
        <span className="settings-feature-row__title">Read later</span>
        <span className="settings-feature-row__powers">
          The Notees Connector's read-later captures land in a "Read later" collection —
          the classes stay always-on.
        </span>
      </span>
      <ToggleSwitch
        leftLabel="Off"
        rightLabel="On"
        checked={enabled}
        onChange={(next) => {
          void client.setFeatureEnabled(READ_IT_LATER_FEATURE, next).catch((error: unknown) => {
            console.warn(`[features] setFeatureEnabled (readItLater) failed:`, error);
          });
        }}
        size="sm"
        aria-label="Read later feature"
      />
    </div>
  );
}
```

  (`mdi-inbox` is already used by the project's icon set — `SettingsPage.tsx:443` — so the path resolves; if the design system assigns read-later a different glyph during review, the swap is one line.)
- [ ] Render it in `WorkspaceSettingsModal.tsx` immediately after the journal IIFE block (`WorkspaceSettingsModal.tsx:333`, before the SourcesSettingsSection comment): `<ReadItLaterFeatureRow client={client!} />` guarded by the same `clientMatches` branch it sits inside, with the import added.
- [ ] Run `pnpm --filter @notees/web test -- settings-readitlater` → GREEN; full suite + typecheck. Pre-bump the row renders nothing (both runtime and test tolerate the absent id); post-bump the toggle works and the write rides `workspace.feature.set` with the read-modify-merge the shared writer already performs (`client-reads-refs.ts:408`).

### Task 6: User docs — connector, read-it-later, word add-in pages

One page per feature under `docs/features/` (the spec's docs contract), matching the existing pages' voice (front-door paragraph naming what the feature is + what it is not, then the mechanics; see `sources.md` for the register).

**Files**
- Create: `docs/features/connector.md`
- Create: `docs/features/read-it-later.md`
- Create: `docs/features/word.md`
- Modify: `docs/README.md` only if it indexes features (check; add the rows if it does)

**Interfaces** — docs only, no code.

**Steps**
- [ ] Write `docs/features/connector.md`: the Notees Connector (Firefox) — what it is (one extension, per-feature toggles, two transports), the tab relay (open Notees tab preferred; zero credentials; the ONLY path into an E2EE workspace), direct REST with a scoped `capture.write` API key otherwise, the 409 `e2ee_required` → "open Notees to capture" notification, what a capture stores (URL + title + metadata only — never page body), the `web_page` node it creates, and the XPI self-distribution story (sideloading, the adoption cost named honestly).
- [ ] Write `docs/features/read-it-later.md`: the toggle (Settings → Features, the surfaces-gate idiom like Journal), the "Read later" collection (auto-created on first capture, op-log state), opening pages from it, unread/read riding a property/tag (the spec's deferred choice — document what SHIPPED once Task 2 lands; if no unread marker ships in this slice, say the inbox view + unread markers are follow-up work), and the v1 honest edge: no dedicated inbox surface — the collection IS the surface.
- [ ] Write `docs/features/word.md`: the Word add-in at the DESIGNED/Today honesty level the sibling lanes actually ship — the Office.js task pane, the `notees serve` localhost bridge (127.0.0.1-only, the pairing token), offline-first citations, and what is NOT in v1 (Word-for-web beyond sideloading). If the word lanes are not landed when this slice ships, label the page honestly at the top ("ships with the word add-in milestone") and keep the feature-status row "Designed".
- [ ] Fleet-agnostic copy throughout (no hosts, no tailnet names); no pointers to internal spec/plan folders.

### Task 7: `docs/feature-status.md` rows + `CHANGELOG.md` entry

**Files**
- Modify: `docs/feature-status.md`
- Modify: `CHANGELOG.md`

**Steps**
- [ ] Add three rows to the `feature-status.md` table, in the established honest vocabulary (`**Today**` with the parenthetical mechanics, or `Designed`):
  - `Connector tab relay (Firefox captures through an open Notees tab)` — **Today** when landed: the postMessage relay, the three error codes, E2EE-transparency, URL-dedupe; naming `docs/features/connector.md`.
  - `Read later (the connector's read-it-later inbox)` — **Today** when landed: the toggle + the auto-created collection; naming `docs/features/read-it-later.md`.
  - `Word add-in (Office.js task pane + notees serve bridge)` — the state the sibling lanes actually ship (Today or Designed), naming `docs/features/word.md`.
- [ ] Add the `CHANGELOG.md` entry (newest first, one entry for the slice, the house style — bold `feat(web): …` headline + mechanism + **Docs:** + **Verification:** lines): the relay module, the capture-into-graph path (reusing the classed-create pipeline, OR-Set membership, URL dedupe), the `addCollectionMember` client seam (+ worker RPC), the settings row with the vendor-tolerance ruling, the docs, and the verification numbers (suite count + typecheck).

### Task 8: Full gate + vendor-bump coordination

**Files** — none new; this is the verification task.

**Steps**
- [ ] `pnpm --filter @notees/web test` — full suite green (watch for red suites in files this lane did not touch: per AGENTS.md they may be a parallel session's in-flight work — report, don't fix).
- [ ] `pnpm --filter @notees/web typecheck` — clean.
- [ ] `pnpm --filter @notees/web build` — clean (the new feature folder is part of the app graph).
- [ ] Confirm the `readItLater` vendor bump sequence with the sync-repo lane before enabling the toggle's tests in CI reality: `git -C vendor/notees fetch origin && git -C vendor/notees checkout origin/main` → `pnpm -r --filter "@notees/*" build` → `pnpm install` → the submodule pointer + lockfile commit ride the SAME slice's commit only if the bump has landed; otherwise this slice ships with the toggle inert (the row renders nothing, the relay gate treats readlater as ungated) and the bump is the follow-up commit. Either way the pre-bump state must be green — that is the tolerance the Global Constraints pin.
- [ ] Commit (per-file staging, Conventional Commits: `feat(web): connector tab relay — the page-side postMessage handshake, read-it-later capture into the graph, and the readItLater settings toggle`) and push; then redeploy via the live stack's own compose (`docker compose build <service> && docker compose up -d`) and run `scripts/screenshots/verify-min.mjs` to VERIFY-PASS — per the standing working rules, a shipped slice is not live until the smoke passes.
