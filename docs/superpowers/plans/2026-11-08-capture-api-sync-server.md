# Capture API — notees-sync server lane (readItLater feature + `POST /api/capture/web-page` + add-in statics)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `readItLater` workspace feature to the protocol (fixture-gated), ship `POST /api/capture/web-page` (session or `capture.write`-scoped API key) that stamps `object.create`/`property.set`/`collection.member.add` envelopes through the one write path (`ctx.submit`), auto-creates and remembers a "Read later" collection per workspace, rejects E2EE workspaces with 409 `e2ee_required`, gates on the feature toggle with 403 `feature_disabled`, and serves the Word add-in statics from `NOTEES_WORD_ADDIN_DIR` at `/word/`.

**Architecture:** The capture endpoint is an ordinary object-API route registered in the authenticated `/api` group in `apps/server/src/app.ts` (the same group as `registerObjectRoutes`), so `resolvePrincipal` + `authorizeWorkspace` + `enforceRouteScope` (driven by the OpenAPI `x-required-scope` table) handle auth exactly like every other object route. The handler itself validates a strict zod body, gates on the `readItLater` feature row, rejects keyed workspaces, resolves identifiers through the existing `resolve-source.ts` resolver, and stamps envelopes through `ctx.submit` — the same one-write-path used by `routes-objects.ts` and the workflows engine. The read-later collection id is server-local bookkeeping in the relay.db `workspace` row (the prefs/shares/plugins ruling: coordination state, never log state).

**Tech Stack:** TypeScript (Node 22), Fastify 5, zod 3, better-sqlite3 (relay.db), vitest 2, `@notees/{protocol,domain,store}` workspace packages (dev-condition exports: vitest reads `src`, `tsc` reads `dist`).

**Spec:** `/root/projects/notees-web/docs/superpowers/specs/2026-11-08-citation-capture-integrations-design.md` (the `notees-sync` section; this plan is the whole `notees-sync` lane).

**Repo:** `/root/projects/notees-sync` (all file paths below are relative to it).

## Global Constraints

- Conventional Commits, per-file staging only (never `git add -A`): `feat(protocol): …`, `feat(server): …`, `test(server): …`.
- `CHANGELOG.md` (repo root) gains one entry per shipped slice, newest first under the current date heading.
- The fixture gate is law: `pnpm --filter @notees/protocol test` must pass (it asserts the exact fixture file set); `pnpm --filter @notees/store test` replays every fixture through both store adapters; the full blocking gate is `pnpm test` at the repo root (what CI runs).
- Server test command: `pnpm --filter @notees/server test` (vitest run); run one file with `pnpm --filter @notees/server exec vitest run test/capture.test.ts`.
- After changing the public API of `@notees/protocol` or `@notees/domain`, rebuild dist before typechecking dependents: `pnpm build`, then `pnpm -r typecheck` must pass.
- Existing endpoints, the error taxonomy, and the OpenAPI coverage contract (`test/openapi-coverage.test.ts`) must never regress.
- GTK/Flutter lockstep: the new fixture must be copied byte-identical into `notees-gtk` (`tests/fixtures/wire/`) and `notees-flutter` (`test/fixtures/wire/`) replay sets — the applier is already generic (`isFamilyFeature` returns false for `readItLater`, so no client applier code changes), but the fixture bytes are shared law. Record the follow-up in the CHANGELOG entry.

## Review Focus — five input classes the task tests must pin

1. **Capture into an E2EE workspace** — a keyed workspace must get 409 `e2ee_required` and ZERO envelopes persisted (no plaintext channel into encrypted stores; the extension falls back to the tab relay).
2. **Capture when the feature is disabled** — a `workspace.feature.set {feature:"readItLater", enabled:false}` row must answer 403 `feature_disabled` for both modes; absent row (F2 default) must allow.
3. **Re-capture of the same URL** — same URL in the same mode returns the existing node id with no duplicate node; a `readlater` capture of a URL already captured as `source` promotes the existing node into the collection rather than duplicating it.
4. **API-key vs session auth** — a scoped key WITHOUT `capture.write` gets 403 `scope_denied`; a scoped key WITH `capture.write` succeeds; a Bearer session succeeds; no credentials gets 401. The relay rule (scoped keys rejected) does NOT apply here — capture is object API.
5. **Oversized/malformed URL** — a non-URL string, a `ftp:` URL, and a URL over 2048 chars all get 422 `validation_failed` and persist nothing.

---

## Task 1: Protocol — the `readItLater` workspace feature id (fixture-gated)

**Files**
- Modify: `packages/protocol/src/op-types.ts`
- Modify: `packages/protocol/SCHEMA.md`
- Modify: `packages/protocol/test/protocol.test.ts`
- Create: `packages/protocol/fixtures/workspace-feature-readitlater.json`
- Modify: `packages/domain/src/features.ts`

**Interfaces**
- Consumes: `workspaceFeatureSetPayload` (`op-types.ts:798`) — no payload change, only the enum.
- Produces: `WORKSPACE_FEATURES` gains `"readItLater"` (`WorkspaceFeature` type widens); `FamilyFeature = Exclude<WorkspaceFeature, "journal" | "readItLater">` in domain.

**Steps**

- [ ] Write the failing gate test edits in `packages/protocol/test/protocol.test.ts`:
  - In the exact-list assertion (`it("has exactly the fifty required fixtures")`, line 54), rename to `"has exactly the fifty-one required fixtures"` and add `"workspace-feature-readitlater.json",` to the sorted list (after `workspace-feature-set.json`).
  - Add a scenario test after the `workspace-feature-set.json` block:
    ```ts
    it("workspace-feature-readitlater.json toggles the readItLater surface feature", () => {
      const fixture = fixtures.find((f) => f.name === "workspace-feature-readitlater.json")!;
      expect(fixture.envelopes.length).toBeGreaterThan(0);
      for (const env of fixture.envelopes) {
        expect(env.opType).toBe("workspace.feature.set");
        expect((env.payload as { feature: string }).feature).toBe("readItLater");
      }
      const hlcOf = (env: Record<string, unknown>) =>
        (env.hlc as { physical: number; logical: number }) ?? { physical: 0, logical: 0 };
      const [first, second] = fixture.envelopes;
      expect(compareHlc(hlcOf(first!), hlcOf(second!))).toBeLessThan(0);
      expect((second!.payload as { enabled: boolean }).enabled).toBe(false);
    });
    ```
    (`compareHlc` is already imported in this file — see the `property-set-lww.json` test.)
- [ ] Run `pnpm --filter @notees/protocol test` → the new test fails: fixture not found / list mismatch (expected failure).
- [ ] Create `packages/protocol/fixtures/workspace-feature-readitlater.json` (envelope shape verbatim from `workspace-feature-set.json`, ids continuing its `0192a000-…061x` run):
  ```json
  {
    "envelopes": [
      {
        "id": "0192a000-0000-7000-8000-000000000611",
        "protocolVersion": 3,
        "workspaceId": "0192a000-0000-7000-8000-000000000001",
        "actorId": "0192a000-0000-7000-8000-000000000002",
        "deviceId": "test-device-laptop",
        "client": "web",
        "hlc": { "physical": 1727200011000, "logical": 0 },
        "affectedNodeIds": [],
        "opType": "workspace.feature.set",
        "timestamp": "2026-09-24T12:00:11.000Z",
        "payload": { "feature": "readItLater", "enabled": true }
      },
      {
        "id": "0192a000-0000-7000-8000-000000000612",
        "protocolVersion": 3,
        "workspaceId": "0192a000-0000-7000-8000-000000000001",
        "actorId": "0192a000-0000-7000-8000-000000000002",
        "deviceId": "test-device-phone",
        "client": "flutter",
        "hlc": { "physical": 1727200011100, "logical": 0 },
        "affectedNodeIds": [],
        "opType": "workspace.feature.set",
        "timestamp": "2026-09-24T12:00:11.100Z",
        "payload": { "feature": "readItLater", "enabled": false }
      }
    ]
  }
  ```
- [ ] In `packages/protocol/src/op-types.ts` add the id to the enum (line 787-794), with the doc comment above it extended:
  ```ts
  export const WORKSPACE_FEATURES = [
    "tasks",
    "events",
    "meetings",
    "sources",
    "persons",
    "journal",
    /**
     * The read-it-later capture surface (the Firefox connector's "Read later"
     * mode + POST /api/capture/web-page gating): a SURFACE toggle like
     * `journal`, not a class family — no classes derive from it, disabling it
     * archives nothing. The capture endpoint answers 403 feature_disabled
     * when the winning row is disabled.
     */
    "readItLater",
  ] as const;
  ```
- [ ] In `packages/protocol/SCHEMA.md` "Workspace features" section (the `journal` bullet at line 139), add a sibling bullet:
  > `- **readItLater** — the seventh toggle gates the read-it-later capture surface (the connector/extension capture endpoint): like `journal` it manages no class family — `web_page`/`collection` keep riding the sources toggle; the server capture route answers 403 `feature_disabled` on a disabled row. Same LWW row, same absent-row-means-enabled default (F2).`
- [ ] In `packages/domain/src/features.ts` line 63, change the exclusion so the new id is not treated as a family (the applier's `isFamilyFeature` check routes on `WORKSPACE_FEATURE_MAP` membership — a missing map key would be a type error otherwise):
  ```ts
  export type FamilyFeature = Exclude<WorkspaceFeature, "journal" | "readItLater">;
  ```
  and extend the comment above `WORKSPACE_FEATURE_MAP` (line 58-62) with one sentence: "The `readItLater` toggle (2026-11-08) is the same kind of surface gate: it manages no classes and derives no archival bits; the server capture endpoint reads its row."
- [ ] Run `pnpm --filter @notees/protocol test` → green. Run `pnpm --filter @notees/store test` → green (the store replays the new fixture on both adapters; `applyWorkspaceFeatureSet` handles non-family features generically — `appliers.ts:3132` writes just the LWW row).
- [ ] `pnpm build` (rebuild dist — the server typecheck reads it) then `pnpm -r typecheck` → green.
- [ ] Commit (per-file staging): `feat(protocol): readItLater workspace feature id + fixture` for `op-types.ts`, `SCHEMA.md`, the fixture, `protocol.test.ts`, and `feat(domain): readItLater is a surface feature, not a class family` for `features.ts`.

## Task 2: `capture.write` scope + the two new error codes

**Files**
- Modify: `apps/server/src/scopes.ts`
- Modify: `apps/server/src/errors.ts`
- Modify: `apps/server/test/error-taxonomy.test.ts` (only if it pins the code count — check first)
- Test: `apps/server/test/scopes.test.ts` (new — or fold assertions into `test/capture.test.ts` in Task 4; choose one, see below)

**Interfaces**
- Produces: `ApiScope` gains `"capture.write"` (valid in `POST /api/api-keys` bodies); `ErrorCode` gains `"feature_disabled"` (403) and `"e2ee_required"` (409).

**Steps**

- [ ] Write the failing test in `apps/server/test/capture-scope.test.ts`:
  ```ts
  import { afterEach, describe, expect, it } from "vitest";
  import { closeTestServer, makeTestServer, type TestServer } from "./helpers";
  import { API_SCOPES } from "../src/scopes.js";
  import { ERROR_TAXONOMY } from "../src/errors.js";

  let server: TestServer | null = null;
  afterEach(async () => {
    if (server !== null) { await closeTestServer(server); server = null; }
  });

  describe("capture vocabulary", () => {
    it("capture.write is a mintable API-key scope", () => {
      expect(API_SCOPES).toContain("capture.write");
    });
    it("feature_disabled and e2ee_required are pinned taxonomy codes", () => {
      expect(ERROR_TAXONOMY.feature_disabled?.status).toBe(403);
      expect(ERROR_TAXONOMY.e2ee_required?.status).toBe(409);
    });
    it("an api-key mint request accepts the capture.write scope", async () => {
      server = await makeTestServer();
      await server.app.inject({ method: "POST", url: "/api/setup", payload: { email: "admin@example.com", password: "admin-password-1" } });
      const login = await server.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "admin-password-1" } });
      const created = await server.app.inject({
        method: "POST",
        url: "/api/api-keys",
        headers: { authorization: `Bearer ${login.json().token}` },
        payload: { name: "connector", scopes: ["capture.write"] },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().apiKey.scopes).toEqual(["capture.write"]);
    });
  });
  ```
- [ ] Run `pnpm --filter @notees/server exec vitest run test/capture-scope.test.ts` → 3 failures (expected: scope unknown, codes missing).
- [ ] In `apps/server/src/scopes.ts` add `"capture.write"` to `API_SCOPES` (after `"collections.write"`, line 33) and extend the header comment: the capture endpoint is the first route enforcing `capture.write`; `collections.write`/`citations` remain reserved.
- [ ] In `apps/server/src/errors.ts`:
  - Add to the `ErrorCode` union (after `"resolver_disabled"`): `"feature_disabled"` and `"e2ee_required"`.
  - Add to `ERROR_TAXONOMY` (after the `no_identifier_found` entry):
    ```ts
    // POST /api/capture/web-page: the workspace's readItLater feature row is
    // disabled (F2: an absent row means enabled, so only an explicit
    // disabled row answers this).
    feature_disabled: { status: 403, description: "the workspace's readItLater feature is disabled" },
    // POST /api/capture/web-page: the workspace carries a workspace_key row —
    // the server holds no plaintext channel into encrypted stores; the
    // client captures through the tab relay instead.
    e2ee_required: { status: 409, description: "workspace is end-to-end encrypted — capture through an open client" },
    ```
- [ ] Re-run the test → green. Run `pnpm --filter @notees/server exec vitest run test/error-taxonomy.test.ts` — it scans `src/` emissions against the taxonomy, the new codes are taxonomy-only until Task 9/10 emit them (the "every taxonomy code is emitted somewhere" direction, if asserted, may fail — if so, note it pins until Task 10 lands; do NOT weaken the test).
- [ ] Commit: `feat(server): capture.write scope + feature_disabled/e2ee_required error codes`.

## Task 3: Read-later inbox bookkeeping (relay.db `workspace` row)

**Files**
- Modify: `apps/server/src/auth.ts`
- Test: `apps/server/test/capture-inbox.test.ts` (new)

**Interfaces**
- Produces (on `AuthStorage`):
  ```ts
  /** The remembered "Read later" collection node id, if the workspace has one. */
  getReadLaterCollectionId(workspaceId: string): string | undefined;
  /** Remember the auto-created "Read later" collection (server-local bookkeeping). */
  setReadLaterCollectionId(workspaceId: string, collectionId: string): void;
  ```

**Steps**

- [ ] Write the failing test `apps/server/test/capture-inbox.test.ts`:
  ```ts
  import { afterEach, describe, expect, it } from "vitest";
  import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

  let server: TestServer | null = null;
  afterEach(async () => {
    if (server !== null) { await closeTestServer(server); server = null; }
  });

  describe("read-later inbox bookkeeping", () => {
    it("remembers the collection id per workspace and defaults to undefined", async () => {
      server = await makeTestServer();
      const ws = server.ctx.defaultWorkspace;
      expect(server.ctx.auth.getReadLaterCollectionId(ws)).toBeUndefined();
      server.ctx.auth.setReadLaterCollectionId(ws, "11111111-2222-4333-8444-555555555555");
      expect(server.ctx.auth.getReadLaterCollectionId(ws)).toBe("11111111-2222-4333-8444-555555555555");
      // A second workspace is independent.
      server.ctx.auth.setReadLaterCollectionId("99999999-8888-4777-8666-555555555555", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
      expect(server.ctx.auth.getReadLaterCollectionId(ws)).toBe("11111111-2222-4333-8444-555555555555");
      // Upsert, not insert-once.
      server.ctx.auth.setReadLaterCollectionId(ws, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
      expect(server.ctx.auth.getReadLaterCollectionId(ws)).toBe("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
    });
  });
  ```
- [ ] Run → fails (methods missing).
- [ ] Implement in `apps/server/src/auth.ts`, following the additive-column idiom at `auth.ts:505-545` (the `user_prefs`/`api_key` pattern): in the constructor's migration block add
  ```ts
  const workspaceColumns = new Set(
    (this.db.pragma("table_info(workspace)") as { name: string }[]).map((c) => c.name),
  );
  if (!workspaceColumns.has("read_later_collection_id")) {
    this.db.exec("ALTER TABLE workspace ADD COLUMN read_later_collection_id TEXT");
  }
  ```
  and the two methods next to `renameWorkspace` (`auth.ts:729`):
  ```ts
  /** The remembered "Read later" collection node id (server-local bookkeeping). */
  getReadLaterCollectionId(workspaceId: string): string | undefined {
    const row = this.db
      .prepare("SELECT read_later_collection_id FROM workspace WHERE id = ?")
      .get(workspaceId) as { read_later_collection_id: string | null } | undefined;
    return row?.read_later_collection_id ?? undefined;
  }

  /** Upsert the remembered "Read later" collection id. */
  setReadLaterCollectionId(workspaceId: string, collectionId: string): void {
    this.db
      .prepare(
        `INSERT INTO workspace (id, read_later_collection_id) VALUES (?, ?)
         ON CONFLICT (id) DO UPDATE SET read_later_collection_id = excluded.read_later_collection_id`,
      )
      .run(workspaceId, collectionId);
  }
  ```
- [ ] Run → green. Also run `pnpm --filter @notees/server test` to catch regressions in suites that construct `AuthStorage` (the ALTER is additive CREATE-IF-NOT-EXISTS; existing suites must stay green).
- [ ] Commit: `feat(server): remember the read-later collection id in the relay.db workspace row`.

## Task 4: Route skeleton — registration, auth, body validation, first envelope

**Files**
- Create: `apps/server/src/routes-capture.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/openapi.ts`
- Test: `apps/server/test/capture.test.ts` (new — grows through Tasks 4-10)

**Interfaces**
- Consumes: `workspaceFor` (`routes-objects.ts:217`), `ctx.submit` (`context.ts:175`), `requireCredential`-style group auth via the `/api` group preHandler in `app.ts:196-216`, `SYSTEM_CLASS_UUIDS.web_page` (`@notees/domain`).
- Produces: `POST /api/capture/web-page` — `201 {objectId}` on success; registered in the same `/api` authed group as the object routes, so scoped keys are checked against `capture.write` from the OpenAPI table.

**Steps**

- [ ] Add the OpenAPI operation entry in `apps/server/src/openapi.ts` `ROUTES` table (after the assets block, ~line 840):
  ```ts
  ["post", "/api/capture/web-page", {
    summary: "Capture a web page as a web_page source or into the read-it-later inbox",
    description:
      "Stamps object.create (class web_page) + property.set (url, accessDate, resolver fields) envelopes through the one write path; readlater mode additionally stamps collection.member.add into the workspace's auto-created 'Read later' collection. Session Bearer or a capture.write-scoped API key. Idempotent: re-capturing the same URL returns the existing node. 409 e2ee_required for encrypted workspaces (capture through an open client); 403 feature_disabled when the workspace's readItLater toggle is off.",
    tags: ["Capture"],
    requestBody: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["url", "title", "mode"],
            properties: {
              url: { type: "string", format: "uri", maxLength: 2048 },
              title: { type: "string", minLength: 1, maxLength: 500 },
              mode: { type: "string", enum: ["source", "readlater"] },
              identifiers: {
                type: "object",
                additionalProperties: false,
                properties: { doi: { type: "string" }, isbn: { type: "string" } },
              },
              note: { type: "string", maxLength: 10000 },
            },
          },
        },
      },
    },
    success: {
      status: 201,
      description: `{ "objectId": "<node id>", "collectionId?": "<read-later collection id, readlater mode only>" }`,
    },
    requiredScope: "capture.write",
    errors: ["validation_failed", "feature_disabled", "e2ee_required"],
  }],
  ```
  and in the `x-api-key-scopes` description map (~line 1254) add `"capture.write": "POST /api/capture/web-page"`.
- [ ] Create `apps/server/src/routes-capture.ts` (skeleton — property stamping lands in Task 5):
  ```ts
  /**
   * Capture endpoint (the Firefox connector's direct-REST transport):
   * POST /api/capture/web-page — stamps object.create (class web_page) +
   * property.set + (readlater) collection.member.add envelopes through the
   * one write path. Session Bearer or a capture.write-scoped API key; E2EE
   * workspaces are rejected (409 e2ee_required — no plaintext channel into
   * encrypted stores); the readItLater feature row gates the route (403
   * feature_disabled).
   */

  import type { FastifyInstance } from "fastify";
  import { z } from "zod";
  import { uuidv7 } from "uuidv7";

  import { SYSTEM_CLASS_UUIDS } from "@notees/domain";

  import type { ServerContext } from "./context.js";
  import { AppError } from "./errors.js";
  import { workspaceFor } from "./routes-objects.js";

  export const captureBodySchema = z
    .object({
      url: z.string().url().max(2048),
      title: z.string().trim().min(1).max(500),
      mode: z.enum(["source", "readlater"]),
      identifiers: z
        .object({
          doi: z.string().trim().min(1).max(255).optional(),
          isbn: z.string().trim().min(1).max(32).optional(),
        })
        .strict()
        .optional(),
      note: z.string().trim().max(10_000).optional(),
    })
    .strict();

  export function registerCaptureRoutes(app: FastifyInstance, ctx: ServerContext): void {
    app.post("/capture/web-page", async (request, reply) => {
      const parsed = captureBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError(
          422,
          "validation_failed",
          parsed.error.issues[0]?.message ?? "invalid capture body",
        );
      }
      const workspaceId = workspaceFor(ctx, request);
      await ctx.ensureSeeded(workspaceId);
      const objectId = uuidv7();
      await ctx.submit({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId,
          classIds: [SYSTEM_CLASS_UUIDS.web_page],
          contentAst: [{ type: "text", text: parsed.data.title }],
          isEmbedded: false,
        },
        affectedNodeIds: [objectId],
        client: "capture",
      });
      reply.code(201);
      return { objectId };
    });
  }
  ```
- [ ] Register it in `apps/server/src/app.ts`: import `registerCaptureRoutes` and add `registerCaptureRoutes(api, ctx);` inside the `/api` authed group next to `registerObjectRoutes(api, ctx);` (line 211). The group preHandler already runs `resolvePrincipal` (401), `authorizeWorkspace(…, "write")`, and `enforceRouteScope` — the OpenAPI `x-required-scope: capture.write` entry makes the scope check automatic.
- [ ] Write the Task-4 slice of `apps/server/test/capture.test.ts`:
  ```ts
  /**
   * POST /api/capture/web-page — auth classes, validation, envelope stamping,
   * read-later inbox, idempotency, E2EE rejection, feature gating.
   */
  import { afterEach, describe, expect, it } from "vitest";

  import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

  const CAPTURE_URL = "https://example.com/article";
  const CAPTURE_BODY = { url: CAPTURE_URL, title: "Example article", mode: "source" };

  let server: TestServer | null = null;
  afterEach(async () => {
    if (server !== null) { await closeTestServer(server); server = null; }
  });

  async function sessionHeaders(s: TestServer): Promise<Record<string, string>> {
    await s.app.inject({ method: "POST", url: "/api/setup", payload: { email: "admin@example.com", password: "admin-password-1" } });
    const login = await s.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "admin-password-1" } });
    return { authorization: `Bearer ${login.json().token}` };
  }

  async function scopedKey(s: TestServer, scopes: string[]): Promise<string> {
    const created = await s.app.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: await sessionHeaders(s),
      payload: { name: "connector", scopes },
    });
    expect(created.statusCode).toBe(201);
    return created.json().token;
  }

  function capture(s: TestServer, body: unknown, headers: Record<string, string>) {
    return s.app.inject({ method: "POST", url: "/api/capture/web-page", headers: { "content-type": "application/json", ...headers }, payload: body });
  }

  describe("POST /api/capture/web-page — skeleton (task 4)", () => {
    it("rejects unauthenticated calls with 401", async () => {
      server = await makeTestServer();
      const res = await capture(server, CAPTURE_BODY, {});
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthenticated");
    });

    it("rejects a scoped key without capture.write (403 scope_denied)", async () => {
      server = await makeTestServer();
      const key = await scopedKey(server, ["objects.read"]);
      const res = await capture(server, CAPTURE_BODY, { "x-api-key": key });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("scope_denied");
    });

    it("accepts a capture.write-scoped key and a session", async () => {
      server = await makeTestServer();
      const key = await scopedKey(server, ["capture.write"]);
      const viaKey = await capture(server, CAPTURE_BODY, { "x-api-key": key });
      expect(viaKey.statusCode).toBe(201);
      expect(viaKey.json().objectId).toMatch(/^[0-9a-f-]{36}$/);
      const viaSession = await capture(server, { ...CAPTURE_BODY, url: "https://example.com/other" }, await sessionHeaders(server));
      expect(viaSession.statusCode).toBe(201);
    });

    it("rejects malformed bodies with 422 and persists nothing", async () => {
      server = await makeTestServer();
      const bad = await capture(server, { url: "not a url", title: "T", mode: "source" }, server.authHeaders);
      expect(bad.statusCode).toBe(422);
      const oversized = await capture(server, { url: `https://example.com/${"a".repeat(2100)}`, title: "T", mode: "source" }, server.authHeaders);
      expect(oversized.statusCode).toBe(422);
      const ftp = await capture(server, { url: "ftp://example.com/x", title: "T", mode: "readlater" }, server.authHeaders);
      expect(ftp.statusCode).toBe(422);
      const before = server.ctx.relay.envelopeCount(server.ctx.defaultWorkspace);
      expect(before).toBe(0);
    });
  });
  ```
- [ ] Run `pnpm --filter @notees/server exec vitest run test/capture.test.ts` → all 4 pass; run `pnpm --filter @notees/server exec vitest run test/openapi-coverage.test.ts` → green (the new route is documented); run `pnpm --filter @notees/server exec vitest run test/error-taxonomy.test.ts` → green (no new emissions yet).
- [ ] Commit: `feat(server): POST /api/capture/web-page skeleton — auth, validation, object.create stamping`.

## Task 5: Property stamping — `url`, `accessDate`, `note` — and the envelope-shape pin

**Files**
- Modify: `apps/server/src/routes-capture.ts`
- Test: `apps/server/test/capture.test.ts` (extend)

**Interfaces**
- Consumes: `SYSTEM_PROPERTY_UUIDS` (`url` = `…0000-…0024`, `accessDate` = `…0006-…0004` — `packages/domain/src/seeds.ts:542,650`).
- Produces: for every capture, envelope sequence `object.create` → `property.set (url)` → `property.set (accessDate)` (+ `object.create` note child when `note` present).

**Steps**

- [ ] Write the failing tests (add to `capture.test.ts`):
  ```ts
  describe("property stamping (task 5)", () => {
    it("stamps url + accessDate and a note child block", async () => {
      server = await makeTestServer();
      const res = await capture(server, { ...CAPTURE_BODY, note: "read this" }, server.authHeaders);
      expect(res.statusCode).toBe(201);
      const { objectId } = res.json();
      const store = server.ctx.workspaces.storeFor(server.ctx.defaultWorkspace);
      const urlRow = store.database
        .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
        .get(objectId, SYSTEM_PROPERTY_UUIDS.url) as { value: string } | undefined;
      expect(urlRow?.value).toBe(CAPTURE_URL);
      const accessRow = store.database
        .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
        .get(objectId, SYSTEM_PROPERTY_UUIDS.accessDate) as { value: string } | undefined;
      expect(accessRow?.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The note becomes an embedded child block.
      const child = store.database
        .prepare("SELECT id, content FROM node WHERE parent_id = ? AND is_embedded = 1")
        .get(objectId) as { id: string; content: string } | undefined;
      expect(child?.content).toBe("read this");
    });

    it("envelope sequence rides the one write path with client capture", async () => {
      server = await makeTestServer();
      await capture(server, CAPTURE_BODY, server.authHeaders);
      const ops = await server.app.inject({ method: "GET", url: "/api/operations?limit=50", headers: server.authHeaders });
      const opTypes = ops.json().operations.map((o: { opType: string }) => o.opType);
      expect(opTypes).toEqual(["object.create", "property.set", "property.set"]);
      const envs = ops.json().operations as Array<{ client: string; actorId: string }>;
      expect(envs.every((e) => e.client === "capture")).toBe(true);
      expect(envs.every((e) => e.actorId === server!.ctx.actorId)).toBe(true);
    });
  });
  ```
  (Add `import { SYSTEM_PROPERTY_UUIDS } from "@notees/domain";` to the test file.)
- [ ] Run → new tests fail (no property.set stamped yet; the envelope-sequence test also fails).
- [ ] Implement in `routes-capture.ts`: after the `object.create` submit, stamp the properties and the note child (note the accessDate day-precision shape — the `accessDate` schema is datetime with day precision default):
  ```ts
  const today = new Date().toISOString().slice(0, 10);
  await ctx.submit({
    workspaceId,
    opType: "property.set",
    payload: { objectId, propertySchemaId: SYSTEM_PROPERTY_UUIDS.url, value: parsed.data.url },
    affectedNodeIds: [objectId],
    client: "capture",
  });
  await ctx.submit({
    workspaceId,
    opType: "property.set",
    payload: { objectId, propertySchemaId: SYSTEM_PROPERTY_UUIDS.accessDate, value: today },
    affectedNodeIds: [objectId],
    client: "capture",
  });
  if (parsed.data.note !== undefined) {
    const noteBlockId = uuidv7();
    await ctx.submit({
      workspaceId,
      opType: "object.create",
      payload: {
        objectId: noteBlockId,
        parentId: objectId,
        isEmbedded: true,
        contentAst: [{ type: "text", text: parsed.data.note }],
      },
      affectedNodeIds: [objectId, noteBlockId],
      client: "capture",
    });
  }
  ```
  (`import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";`)
- [ ] Run → green. Note the ordering contract pinned by the second test: `object.create` first so the properties apply against an existing node.
- [ ] Commit: `feat(server): capture stamps url/accessDate properties and a note child block`.

## Task 6: Resolver enrichment from `identifiers`

**Files**
- Modify: `apps/server/src/routes-capture.ts`
- Test: `apps/server/test/capture.test.ts` (extend)

**Interfaces**
- Consumes: `resolveSourceMetadata(ctx, workspaceId, { doi } | { isbn })` (`resolve-source.ts:823`) → `SourceMetadataRecord` (`classKey, title, authors[], fields{}, doi?, isbn?, url?, year?, publisher?`).
- Produces: on a successful resolve, additional `property.set` envelopes — `authors` (multi: one set per author with a fresh `elementId`), `publicationDate` (`String(year)`), `publisher`, `doi`. The caller's `title` always wins (the user saw the page). A resolver miss/failure (404/502) DEGRADES to an unresolved capture — the page is the artifact; the raw `doi`/`isbn` identifiers are still stamped so the intent is visible.

**Steps**

- [ ] Write the failing test:
  ```ts
  describe("resolver enrichment (task 6)", () => {
    it("fills resolved fields from a DOI and still stamps the raw identifier", async () => {
      server = await makeTestServer();
      vi.stubGlobal("fetch", vi.fn(async () =>
        new Response(JSON.stringify({
          message: {
            type: "journal-article",
            title: "Resolved title",
            author: [{ family: "Doe", given: "Jane" }, { family: "Roe", given: "Richard" }],
            issued: { "date-parts": [[2021]] },
            DOI: "10.1000/xyz",
            publisher: "PubCo",
            "container-title": ["The Journal"],
          },
        }), { status: 200 }),
      ));
      const res = await capture(server, {
        ...CAPTURE_BODY,
        url: "https://example.com/doi-article",
        identifiers: { doi: "10.1000/xyz" },
      }, server.authHeaders);
      expect(res.statusCode).toBe(201);
      const { objectId } = res.json();
      const store = server.ctx.workspaces.storeFor(server.ctx.defaultWorkspace);
      const values = (schemaId: string) =>
        (store.database
          .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? ORDER BY idx")
          .all(objectId, schemaId) as Array<{ value: string }>).map((r) => r.value);
      expect(values(SYSTEM_PROPERTY_UUIDS.doi)).toEqual(["10.1000/xyz"]);
      expect(values(SYSTEM_PROPERTY_UUIDS.authors)).toEqual(["Doe, Jane", "Roe, Richard"]);
      expect(values(SYSTEM_PROPERTY_UUIDS.publicationDate)).toEqual(["2021"]);
      expect(values(SYSTEM_PROPERTY_UUIDS.publisher)).toEqual(["PubCo"]);
      // The caller's title wins over the resolved one.
      const node = store.database.prepare("SELECT content FROM node WHERE id = ?").get(objectId) as { content: string };
      expect(node.content).toBe("Example article");
      vi.unstubAllGlobals();
    });

    it("degrades gracefully when the provider 404s — capture still lands", async () => {
      server = await makeTestServer();
      vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
      const res = await capture(server, {
        url: "https://example.com/missing-doi",
        title: "Missing",
        mode: "source",
        identifiers: { doi: "10.9999/nothing" },
      }, server.authHeaders);
      expect(res.statusCode).toBe(201);
      const { objectId } = res.json();
      const store = server.ctx.workspaces.storeFor(server.ctx.defaultWorkspace);
      const doiRow = store.database
        .prepare("SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ?")
        .get(objectId, SYSTEM_PROPERTY_UUIDS.doi) as { value: string } | undefined;
      expect(doiRow?.value).toBe("10.9999/nothing");
      vi.unstubAllGlobals();
    });
  });
  ```
  (`import { vi } from "vitest";` — merge into the existing vitest import.)
- [ ] Run → fails (identifiers ignored).
- [ ] Implement in `routes-capture.ts` — a helper that resolves (best-effort) and stamps:
  ```ts
  async function stampResolvedFields(
    ctx: ServerContext,
    workspaceId: string,
    objectId: string,
    identifiers: { doi?: string; isbn?: string },
  ): Promise<void> {
    const setProp = (propertySchemaId: string, value: string, elementId?: string) =>
      ctx.submit({
        workspaceId,
        opType: "property.set",
        payload: { objectId, propertySchemaId, value, ...(elementId ? { elementId } : {}) },
        affectedNodeIds: [objectId],
        client: "capture",
      });
    // The raw identifiers are stamped regardless — the capture is the artifact.
    if (identifiers.doi !== undefined) {
      await setProp(SYSTEM_PROPERTY_UUIDS.doi, normalizeIdentifier("doi", identifiers.doi));
    }
    if (identifiers.isbn !== undefined) {
      await setProp(SYSTEM_PROPERTY_UUIDS.isbn, normalizeIdentifier("isbn", identifiers.isbn));
    }
    const params = identifiers.doi !== undefined ? { doi: identifiers.doi } : { isbn: identifiers.isbn! };
    let record: SourceMetadataRecord;
    try {
      record = await resolveSourceMetadata(ctx, workspaceId, params);
    } catch {
      // Resolver miss/failure degrades to an unresolved capture — the URL
      // capture itself is never held hostage by Crossref/OpenLibrary.
      return;
    }
    for (const author of record.authors) {
      await setProp(SYSTEM_PROPERTY_UUIDS.authors, author, uuidv7());
    }
    if (record.year !== undefined) {
      await setProp(SYSTEM_PROPERTY_UUIDS.publicationDate, String(record.year));
    }
    if (record.publisher !== undefined) {
      await setProp(SYSTEM_PROPERTY_UUIDS.publisher, record.publisher);
    }
    if (record.doi !== undefined) {
      await setProp(SYSTEM_PROPERTY_UUIDS.doi, normalizeIdentifier("doi", record.doi));
    }
  }
  ```
  with imports `import { normalizeIdentifier, resolveSourceMetadata, type SourceMetadataRecord } from "./resolve-source.js";`. Call it after the `accessDate` set when `parsed.data.identifiers` is present.
- [ ] Run → green. Also run the resolve suites (`test/resolve-source.test.ts`) to confirm the shared resolver is untouched.
- [ ] Commit: `feat(server): capture resolves DOI/ISBN identifiers into source properties`.

## Task 7: Read-later collection — auto-create, remember, `collection.member.add`

**Files**
- Modify: `apps/server/src/routes-capture.ts`
- Test: `apps/server/test/capture.test.ts` (extend)

**Interfaces**
- Consumes: `ctx.auth.getReadLaterCollectionId/setReadLaterCollectionId` (Task 3), `SYSTEM_CLASS_UUIDS.collection`, `collection.member.add` payload `{collectionId, objectId}` (`op-types.ts:743`).
- Produces: `201 {objectId, collectionId}` in readlater mode; first readlater capture in a workspace stamps an extra `object.create` (class `collection`, content "Read later") and remembers the id.

**Steps**

- [ ] Write the failing tests:
  ```ts
  describe("read-later inbox (task 7)", () => {
    it("auto-creates the Read later collection once and answers collectionId", async () => {
      server = await makeTestServer();
      const first = await capture(server, { url: "https://a.example/x", title: "A", mode: "readlater" }, server.authHeaders);
      expect(first.statusCode).toBe(201);
      const { objectId, collectionId } = first.json();
      expect(collectionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(server.ctx.auth.getReadLaterCollectionId(server.ctx.defaultWorkspace)).toBe(collectionId);
      const store = server.ctx.workspaces.storeFor(server.ctx.defaultWorkspace);
      const coll = store.database
        .prepare("SELECT content FROM node WHERE id = ?")
        .get(collectionId) as { content: string };
      expect(coll.content).toBe("Read later");
      const member = store.database
        .prepare("SELECT COUNT(*) AS n FROM collection_member WHERE collection_id = ? AND node_id = ? AND present = 1")
        .get(collectionId, objectId) as { n: number };
      expect(member.n).toBe(1);
      // Second capture reuses the remembered collection — no second create.
      const second = await capture(server, { url: "https://b.example/y", title: "B", mode: "readlater" }, server.authHeaders);
      expect(second.statusCode).toBe(201);
      expect(second.json().collectionId).toBe(collectionId);
      const collCount = store.database
        .prepare(
          `SELECT COUNT(*) AS n FROM node n JOIN class_member_set m ON m.node_id = n.id AND m.present = 1
           WHERE m.class_id = ? AND n.workspace_id = ?`,
        )
        .get(SYSTEM_CLASS_UUIDS.collection, server.ctx.defaultWorkspace) as { n: number };
      expect(collCount.n).toBe(1);
    });

    it("source mode answers no collectionId", async () => {
      server = await makeTestServer();
      const res = await capture(server, CAPTURE_BODY, server.authHeaders);
      expect(res.statusCode).toBe(201);
      expect(res.json().collectionId).toBeUndefined();
    });
  });
  ```
  (`import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";` already there.)
- [ ] Run → fails (no collectionId).
- [ ] Implement in `routes-capture.ts` — replace the tail of the handler with the readlater arm:
  ```ts
  let collectionId: string | undefined;
  if (parsed.data.mode === "readlater") {
    collectionId = ctx.auth.getReadLaterCollectionId(workspaceId);
    if (collectionId === undefined) {
      collectionId = uuidv7();
      await ctx.submit({
        workspaceId,
        opType: "object.create",
        payload: {
          objectId: collectionId,
          classIds: [SYSTEM_CLASS_UUIDS.collection],
          contentAst: [{ type: "text", text: "Read later" }],
          isEmbedded: false,
        },
        affectedNodeIds: [collectionId],
        client: "capture",
      });
      ctx.auth.setReadLaterCollectionId(workspaceId, collectionId);
    }
    await ctx.submit({
      workspaceId,
      opType: "collection.member.add",
      payload: { collectionId, objectId },
      affectedNodeIds: [collectionId, objectId],
      client: "capture",
    });
  }
  reply.code(201);
  return collectionId === undefined ? { objectId } : { objectId, collectionId };
  ```
- [ ] Run → green.
- [ ] Commit: `feat(server): read-later capture auto-creates and remembers the inbox collection`.

## Task 8: Idempotent re-capture

**Files**
- Modify: `apps/server/src/routes-capture.ts`
- Test: `apps/server/test/capture.test.ts` (extend)

**Interfaces**
- Consumes: the derived store (`property_value` + `class_member_set` + `collection_member` tables).
- Produces: a capture whose URL already exists on an active `web_page` node in the workspace returns that node (201, same body) and stamps NOTHING new — except that a `readlater` capture of an existing URL node ensures collection membership (promote instead of duplicate).

**Steps**

- [ ] Write the failing tests:
  ```ts
  describe("idempotent re-capture (task 8)", () => {
    it("same URL same mode returns the existing node, no duplicates", async () => {
      server = await makeTestServer();
      const first = await capture(server, { url: "https://dup.example/1", title: "One", mode: "readlater" }, server.authHeaders);
      const second = await capture(server, { url: "https://dup.example/1", title: "One again", mode: "readlater" }, server.authHeaders);
      expect(second.statusCode).toBe(201);
      expect(second.json().objectId).toBe(first.json().objectId);
      const store = server.ctx.workspaces.storeFor(server.ctx.defaultWorkspace);
      const count = store.database
        .prepare(
          `SELECT COUNT(DISTINCT n.id) AS n FROM node n
             JOIN class_member_set m ON m.node_id = n.id AND m.present = 1
             JOIN property_value v ON v.node_id = n.id AND v.property_schema_id = ?
           WHERE n.workspace_id = ? AND m.class_id = ? AND v.value = ?`,
        )
        .get(SYSTEM_PROPERTY_UUIDS.url, server.ctx.defaultWorkspace, SYSTEM_CLASS_UUIDS.web_page, "https://dup.example/1") as { n: number };
      expect(count.n).toBe(1);
    });

    it("readlater capture of an existing source URL promotes the node into the collection", async () => {
      server = await makeTestServer();
      const source = await capture(server, { url: "https://dup.example/2", title: "Two", mode: "source" }, server.authHeaders);
      const later = await capture(server, { url: "https://dup.example/2", title: "Two", mode: "readlater" }, server.authHeaders);
      expect(later.json().objectId).toBe(source.json().objectId);
      const member = server.ctx.workspaces.storeFor(server.ctx.defaultWorkspace).database
        .prepare("SELECT COUNT(*) AS n FROM collection_member WHERE collection_id = ? AND node_id = ? AND present = 1")
        .get(later.json().collectionId, source.json().objectId) as { n: number };
      expect(member.n).toBe(1);
    });
  });
  ```
- [ ] Run → fails (duplicate nodes created).
- [ ] Implement the lookup helpers + short-circuit in `routes-capture.ts` (after seeding, before stamping):
  ```ts
  function findWebPageByUrl(store: Store, workspaceId: string, url: string): string | undefined {
    const row = store.database
      .prepare(
        `SELECT n.id AS id FROM node n
           JOIN class_member_set m ON m.node_id = n.id AND m.present = 1
           JOIN property_value v ON v.node_id = n.id AND v.property_schema_id = ?
         WHERE n.workspace_id = ? AND n.is_class = 0 AND n.is_active = 1
           AND m.class_id = ? AND v.value = ?
         LIMIT 1`,
      )
      .get(SYSTEM_PROPERTY_UUIDS.url, workspaceId, SYSTEM_CLASS_UUIDS.web_page, url) as
      | { id: string }
      | undefined;
    return row?.id;
  }

  function isCollectionMember(store: Store, collectionId: string, objectId: string): boolean {
    const row = store.database
      .prepare(
        "SELECT present FROM collection_member WHERE collection_id = ? AND node_id = ? ORDER BY hlc_physical DESC LIMIT 1",
      )
      .get(collectionId, objectId) as { present: number } | undefined;
    return row?.present === 1;
  }
  ```
  (Import `type Store` from `@notees/store` — the same import `routes-objects.ts` uses.) Then in the handler, after `ensureSeeded` (and before creating anything):
  ```ts
  const store = ctx.workspaces.storeFor(workspaceId);
  const existing = findWebPageByUrl(store, workspaceId, parsed.data.url);
  if (existing !== undefined) {
    let collectionId: string | undefined;
    if (parsed.data.mode === "readlater") {
      collectionId = await ensureReadLaterCollection(ctx, workspaceId); // the create-or-remember arm, extracted from task 7
      if (!isCollectionMember(store, collectionId, existing)) {
        await ctx.submit({
          workspaceId,
          opType: "collection.member.add",
          payload: { collectionId, objectId: existing },
          affectedNodeIds: [collectionId, existing],
          client: "capture",
        });
      }
    }
    reply.code(201);
    return collectionId === undefined ? { objectId: existing } : { objectId: existing, collectionId };
  }
  ```
  (Extract the collection create-or-remember block from Task 7 into `async function ensureReadLaterCollection(ctx, workspaceId): Promise<string>` used by both arms.)
- [ ] Run → green.
- [ ] Commit: `feat(server): capture re-capture is idempotent — same URL returns the existing node`.

## Task 9: E2EE rejection — 409 `e2ee_required`

**Files**
- Modify: `apps/server/src/routes-capture.ts`
- Test: `apps/server/test/capture.test.ts` (extend)

**Interfaces**
- Consumes: `ctx.auth.getWorkspaceKey(workspaceId)` (`auth.ts:1090`).
- Produces: `409 {error:{code:"e2ee_required"}}`, zero envelopes persisted.

**Steps**

- [ ] Write the failing test:
  ```ts
  describe("E2EE rejection (task 9)", () => {
    it("keyed workspaces get 409 e2ee_required and nothing is stamped", async () => {
      server = await makeTestServer();
      server.ctx.auth.putWorkspaceKey(server.ctx.defaultWorkspace, "wrapped-test-key");
      const res = await capture(server, CAPTURE_BODY, server.authHeaders);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("e2ee_required");
      expect(server.ctx.relay.envelopeCount(server.ctx.defaultWorkspace)).toBe(0);
    });
  });
  ```
- [ ] Run → fails (201).
- [ ] Implement: in the handler, immediately after the feature gate (Task 10's slot — put the E2EE check here as a forward declaration; final order pinned in Task 10):
  ```ts
  if (ctx.auth.getWorkspaceKey(workspaceId) !== undefined) {
    throw new AppError(
      409,
      "e2ee_required",
      "workspace is end-to-end encrypted — capture through an open Notees client (tab relay)",
    );
  }
  ```
  placed after `ensureSeeded` and BEFORE any store lookup or stamping. (For keyed workspaces `ensureSeeded` is already a no-op, `context.ts:195`.)
- [ ] Run → green. Run `pnpm --filter @notees/server exec vitest run test/error-taxonomy.test.ts` → green (the emission now exists and matches the taxonomy pin).
- [ ] Commit: `feat(server): capture rejects E2EE workspaces with 409 e2ee_required`.

## Task 10: Feature gating — 403 `feature_disabled`

**Files**
- Modify: `apps/server/src/routes-capture.ts`
- Test: `apps/server/test/capture.test.ts` (extend)

**Interfaces**
- Consumes: `store.getFeatureRow(workspaceId, "readItLater")` (`store.ts:1138`) — absent row = enabled (F2).
- Produces: `403 {error:{code:"feature_disabled"}}` when the winning row is `enabled: false`. **Decision (spec interpretation, flagged for review):** the gate covers the whole endpoint — both `source` and `readlater` modes — because the spec places the gating sentence unconditionally in the `POST /api/capture/web-page` section.
- Check order (pinned): body validation (422) → feature gate (403) → E2EE (409) → idempotency → stamping.

**Steps**

- [ ] Write the failing test:
  ```ts
  describe("feature gating (task 10)", () => {
    it("a disabled readItLater row answers 403 feature_disabled for both modes", async () => {
      server = await makeTestServer();
      await ingest(server, [
        testEnvelope({
          workspaceId: server.ctx.defaultWorkspace,
          opType: "workspace.feature.set",
          payload: { feature: "readItLater", enabled: false },
        }),
      ]);
      for (const mode of ["source", "readlater"] as const) {
        const res = await capture(server, { url: `https://off.example/${mode}`, title: "T", mode }, server.authHeaders);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("feature_disabled");
      }
    });

    it("an absent row (F2 default) allows capture", async () => {
      server = await makeTestServer();
      const res = await capture(server, CAPTURE_BODY, server.authHeaders);
      expect(res.statusCode).toBe(201);
    });
  });
  ```
  (`import { ingest, testEnvelope } from "./helpers";` — add to the existing helpers import.)
- [ ] Run → the disabled test fails (403 never thrown).
- [ ] Implement — the gate goes BEFORE the E2EE check (the pinned order):
  ```ts
  const featureRow = ctx.workspaces.storeFor(workspaceId).getFeatureRow(workspaceId, "readItLater");
  if (featureRow !== undefined && !featureRow.enabled) {
    throw new AppError(403, "feature_disabled", "the workspace's readItLater feature is disabled");
  }
  if (ctx.auth.getWorkspaceKey(workspaceId) !== undefined) {
    throw new AppError(409, "e2ee_required", ...);
  }
  ```
- [ ] Run the full capture file → green; run the whole server suite `pnpm --filter @notees/server test` → green.
- [ ] Commit: `feat(server): capture is gated on the readItLater feature row`.

## Task 11: Word add-in statics at `/word/`

**Files**
- Modify: `apps/server/src/config.ts`
- Create: `apps/server/src/word-addin.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/openapi.ts`
- Test: `apps/server/test/word-addin.test.ts` (new)

**Interfaces**
- Consumes: `NOTEES_WORD_ADDIN_DIR` env (default `""` = hosting disabled → 404).
- Produces: `GET /word/*` — public (no auth; the global per-IP limiter still applies), GET only, hand-rolled streaming (the `assets.ts:340` precedent — no new dependency, no `@fastify/static`).

**Steps**

- [ ] Write the failing test `apps/server/test/word-addin.test.ts`:
  ```ts
  import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { afterEach, describe, expect, it } from "vitest";

  import { closeTestServer, makeTestServer, type TestServer } from "./helpers";

  let server: TestServer | null = null;
  let addinDir: string;
  afterEach(async () => {
    if (server !== null) { await closeTestServer(server); server = null; }
    if (addinDir !== undefined) rmSync(addinDir, { recursive: true, force: true });
  });

  function stageAddin() {
    addinDir = mkdtempSync(join(tmpdir(), "notees-addin-"));
    writeFileSync(join(addinDir, "manifest.xml"), "<manifest>ok</manifest>");
    mkdirSync(join(addinDir, "assets"));
    writeFileSync(join(addinDir, "assets", "taskpane.js"), "console.log(1);");
  }

  describe("GET /word/ — add-in statics", () => {
    it("serves files without auth and maps content types", async () => {
      stageAddin();
      server = await makeTestServer({ wordAddinDir: addinDir });
      const manifest = await server.app.inject({ method: "GET", url: "/word/manifest.xml" });
      expect(manifest.statusCode).toBe(200);
      expect(manifest.headers["content-type"]).toContain("application/xml");
      expect(manifest.body).toBe("<manifest>ok</manifest>");
      const js = await server.app.inject({ method: "GET", url: "/word/assets/taskpane.js" });
      expect(js.statusCode).toBe(200);
      expect(js.headers["content-type"]).toContain("text/javascript");
    });

    it("404s when unconfigured or missing, and refuses traversal", async () => {
      server = await makeTestServer(); // no wordAddinDir
      const off = await server.app.inject({ method: "GET", url: "/word/manifest.xml" });
      expect(off.statusCode).toBe(404);
      await closeTestServer(server);
      stageAddin();
      server = await makeTestServer({ wordAddinDir: addinDir });
      expect((await server.app.inject({ method: "GET", url: "/word/nope.js" })).statusCode).toBe(404);
      expect((await server.app.inject({ method: "GET", url: "/word/../secret" })).statusCode).toBe(404);
      expect((await server.app.inject({ method: "GET", url: "/word/%2e%2e/secret" })).statusCode).toBe(404);
    });
  });
  ```
- [ ] Run → fails (config key unknown, route 404).
- [ ] In `apps/server/src/config.ts`: add `wordAddinDir: string;` to `ServerConfig` (documented "NOTEES_WORD_ADDIN_DIR — the Word add-in statics directory served at /word/; empty (default) disables hosting"), and in `loadConfig` add `wordAddinDir: env.NOTEES_WORD_ADDIN_DIR ?? "",`. Update the header env-comment block with one line.
- [ ] Create `apps/server/src/word-addin.ts`:
  ```ts
  /**
   * Word add-in statics: GET /word/* serves the Office.js task-pane add-in's
   * files (manifest + assets) from NOTEES_WORD_ADDIN_DIR. PUBLIC BY DESIGN —
   * the add-in holds no credentials and talks only to the localhost CLI
   * bridge; the manifest must be fetchable by Word's sideloading flows. GET
   * only, no auth, path-traversal refused. Hand-rolled streaming (the
   * assets.ts precedent) — no new dependency.
   */

  import { createReadStream, existsSync, statSync } from "node:fs";
  import { extname, resolve, sep } from "node:path";

  import type { FastifyInstance } from "fastify";

  import type { ServerConfig } from "./config.js";
  import { AppError } from "./errors.js";

  const WORD_CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".md": "text/markdown; charset=utf-8",
  };

  export function registerWordAddinRoutes(app: FastifyInstance, config: ServerConfig): void {
    app.get("/word/*", async (request, reply) => {
      const rel = (request.params as { "*": string })["*"] ?? "";
      if (config.wordAddinDir.length === 0 || rel.length === 0) {
        throw new AppError(404, "not_found", "word add-in statics are not hosted");
      }
      const root = resolve(config.wordAddinDir);
      const target = resolve(root, rel);
      if (target !== root && !target.startsWith(root + sep)) {
        throw new AppError(404, "not_found", "not found");
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new AppError(404, "not_found", "not found");
      }
      const size = statSync(target).size;
      return reply
        .header("content-type", WORD_CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream")
        .header("content-length", size)
        .send(createReadStream(target));
    });
  }
  ```
- [ ] In `app.ts`: import and call `registerWordAddinRoutes(app, config);` right before `registerPublicShareRoute(app, ctx);` (root level, no auth group).
- [ ] In `openapi.ts` ROUTES (public probes block): add
  ```ts
  ["get", "/word/*", {
    summary: "Word add-in statics (manifest + task-pane assets), auth-free by design",
    description:
      "Serves the Office.js add-in's files from NOTEES_WORD_ADDIN_DIR (unset → 404). Public: the add-in holds no credentials; only the localhost CLI bridge is authoritative. GET only; path traversal refused.",
    tags: ["Word add-in"],
    public: true,
    success: { description: "the requested static file" },
  }],
  ```
  (The coverage test's `toOpenApiPath` leaves `*` untouched, so the documented key `/word/*` matches the registered `/word/*` in both directions.)
- [ ] Run the new test → green; run `test/openapi-coverage.test.ts` → green; run `test/config.test.ts` → green (the new config key must not break env parsing).
- [ ] Commit: `feat(server): host the Word add-in statics at /word/ from NOTEES_WORD_ADDIN_DIR`.

## Task 12: Full gate, docs, CHANGELOG

**Files**
- Modify: `CHANGELOG.md`
- Modify: `packages/protocol/SCHEMA.md` (already touched in Task 1 — verify the sentence landed)
- Test: all suites (verification only)

**Steps**

- [ ] Run the full blocking gate: `pnpm build` then `pnpm -r typecheck` then `pnpm test` — everything green (protocol fixture gate, store replay on both adapters, the whole server suite, all packages).
- [ ] Re-run the two pinned CI-adjacent checks once more: `pnpm --filter @notees/server exec vitest run test/openapi-coverage.test.ts test/error-taxonomy.test.ts`.
- [ ] Add the `CHANGELOG.md` entry (newest first under a `## 2026-11-08` heading, one entry for the slice):
  ```md
  ## 2026-11-08

  ### feat(server): web-page capture API + readItLater workspace feature + Word add-in statics
  - `POST /api/capture/web-page` — captures a page as a `web_page` source or into the read-it-later inbox; session Bearer or `capture.write`-scoped API key (the new scope); stamps `object.create`/`property.set`/`collection.member.add` envelopes through the one write path; idempotent per URL; 409 `e2ee_required` for encrypted workspaces; 403 `feature_disabled` on a disabled `readItLater` row; resolver enrichment from DOI/ISBN degrades gracefully.
  - Protocol: `readItLater` joins `WORKSPACE_FEATURES` (surface toggle like `journal`); canonical fixture `workspace-feature-readitlater.json` (fixture gate 50→51). GTK/Flutter fixture-copy follow-up recorded (appliers already handle non-family features generically).
  - `NOTEES_WORD_ADDIN_DIR` hosts the Word add-in statics at `/word/` (GET, auth-free by design).
  - The relay.db `workspace` row gains `read_later_collection_id` — server-local inbox bookkeeping, never log state.
  - Tests: ~20 new assertions across `capture.test.ts`, `capture-scope.test.ts`, `capture-inbox.test.ts`, `word-addin.test.ts`; OpenAPI + error-taxonomy coverage updated.
  ```
  (Adjust the assertion count to what actually shipped — count the `it` blocks.)
- [ ] Commit: `docs(server): changelog entry for the capture API slice`.
- [ ] Push the branch; land per the repo's worktree/slice rules if this ran in a worktree (`git pull --ff-only` the main checkout after landing).

## Self-review notes (decisions & interpretations)

- **Feature gate scope:** the spec's gating sentence sits in the endpoint section, so the gate covers both modes. If review wants `source` mode gated on the `sources` family instead, only Task 10's check changes.
- **Idempotency promotes rather than duplicates** across modes (source → readlater of the same URL adds the existing node to the collection). The spec only pins same-URL-same-mode; this is the least-surprise extension.
- **Resolver failures degrade** (capture without resolved fields) — the opposite of the resolver routes' fail-loud contract, because the capture's artifact is the page, not the metadata. Raw doi/isbn are always stamped.
- **Re-capture answers 201 with the existing id** (not 200) to keep one success shape.
- **`accessDate` is day-precision** (`YYYY-MM-DD`), matching the datetime schema default.
- **`/word/*` is always registered** (404 when unconfigured) so the OpenAPI coverage contract stays stable in default-config test runs.
- **Lockstep:** no client applier changes are needed (`isFamilyFeature` returns false → plain LWW row), but the fixture bytes must still be copied to GTK/Flutter replay sets — tracked as the follow-up in the CHANGELOG entry.
