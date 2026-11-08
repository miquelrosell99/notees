# `notees serve` — localhost citation bridge (notees-cli lane)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

`notees serve [--port N]` in the `notees` CLI runs a long-lived HTTP server
bound to **127.0.0.1 only**, speaking a small JSON protocol on `POST
/document` so the Word add-in (the `notees-word` lane) can search the user's
synced Notees store and render citations/bibliographies offline — the Zotero
connector architecture adapted to this stack (Word add-in ↔ localhost bridge,
like Zotero's plugin ↔ :23119). All request handling reads the local derived
SQLite store; the only network access is the sync engine's own startup and
periodic cycles.

## Architecture

- **No new HTTP framework.** The repo has no fastify/hono/express and the
  release bundle (`dist/cli.js` via tsup) must stay standalone, so the server
  is raw `node:http` — zero new dependencies for the transport.
- **One module set under `src/serve/`**, consumed by a thin commander command
  in `src/cli.ts`:
  - `src/serve/protocol.ts` — the `/document` wire types + strict request
    parser. This is the normative contract the Word add-in lane codes
    against; nothing else defines it.
  - `src/serve/config.ts` — flag/env resolution for the command.
  - `src/serve/server.ts` — `node:http` server: localhost bind, Bearer
    pairing token, Origin allow-list, body cap, JSON plumbing.
  - `src/serve/session.ts` — the bridge session: store lock, one
    `LocalWorkspace` opened for the server's lifetime (best-effort initial
    sync so Word works offline), background sync interval, and the search
    projection over the store — executed as a `@notees/query` AST (class
    membership + content FTS) through `LocalWorkspace.runQueryAst`.
  - `src/serve/csl-items.ts` — source node → CSL-JSON, **reusing
    `nodeToCsl` from `@notees/export`** (the exact resolution pattern
    `exportBibtex` already uses — authors text track + linkedAgents/date-ref
    resolution) instead of duplicating the mapping.
  - `src/serve/styles.ts` + `src/serve/styles/*.csl` — bundled CSL styles
    (apa, ieee, chicago-note-bibliography) and `locales-en-US.xml`, inlined
    into the bundle through a generated module (`generated.ts`) because the
    release ships a single `cli.mjs` with no asset directory beside it.
  - `src/serve/cite.ts` — the citeproc wrapper (per-request engine, error
    envelope on render failures).
  - `src/serve/document.ts` — the command dispatcher wiring session +
    renderer to the four commands.
- **Command surface:** `notees serve [--port N] [--origin <url> …]
  [--token-file <path>] [--sync-interval <seconds>] [--styles-dir <dir>]`.
  Token: env `NOTEES_SERVE_TOKEN` when set (dev/tests), otherwise a fresh
  random token printed at startup and (optionally) written to
  `--token-file` with mode 0600 — the Zotero connector-authorization
  pattern. Default port **8474**.
- The spec's Zotero connector vocabulary (`insert-citation`, `refresh`,
  `document-removed`) collapses in this design: the add-in re-issues
  `render-citation` for refresh and owns document lifecycle client-side, so
  the bridge implements exactly the four normative commands (`search`,
  `render-citation`, `render-bibliography`, `list-styles`).

## Tech Stack

- Node 22/26 built-ins (`node:http`, `node:crypto`), TypeScript, commander
  (existing), vitest (existing), tsup (existing).
- **New runtime dependency: `citeproc` (citeproc-js, `^2.4.63`)** — the
  spec's flagged decision. It is the natural fit for a Node CLI: maintained,
  pure-JS CSL 1.0.1 processor, ships CommonJS, bundles cleanly through
  tsup's existing `noExternal` + `createRequire` banner, and needs no
  network (styles/locales are vendored XML). citeproc-js has no bundled
  types, so the plan adds a minimal ambient declaration for the surface we
  use.
- Bundled CSL styles fetched once at implementation time from the
  `citation-style-language/styles` and `citation-style-language/locales`
  repos and committed as XML (CC BY-SA 3.0 — attribution added to `NOTICE`).

## Spec

`/root/projects/notees-web/docs/superpowers/specs/2026-11-08-citation-capture-integrations-design.md`
(the `notees serve` bridge section). The normative JSON shapes below are the
cross-repo interface for the Word add-in lane and are **frozen** by this
plan.

## Global Constraints

- **Repo:** `/root/projects/notees-cli` (standalone pnpm workspace; work
  from its root). Invoke the project `notees-cli-development` skill before
  touching code; its laws apply: never edit `vendor/` (reuse
  `@notees/export`'s `nodeToCsl`; fixes to it land in `notees-sync` first),
  the submodule pin only moves via bumps.
- **Blocking gate:** `pnpm typecheck && pnpm test` — all green before the
  slice is declared done. Per-task red-green loop: `pnpm test --
  test/serve-<area>.test.ts` plus `pnpm typecheck`.
- **Commits:** Conventional Commits — one commit per task or a small logical
  series, e.g. `feat(cli): notees serve — localhost citation bridge …`.
  Per-file staging only; never force-push.
- **Changelog is the record:** `CHANGELOG.md` (repo root, newest first, one
  entry per shipped slice, with Files + Verification sections like the
  existing entries) lands in the same pass as the docs task. README.md and
  command help text update in the same pass as behavior.
- **`--json` is the stable machine surface**; exit codes follow
  `src/exit-codes.ts` (0 ok, 1 domain, 2 usage, 3 auth, 4 conflict, 5
  network). A second `notees serve` on the same workspace store exits 4.
- **127.0.0.1 bind is non-negotiable:** the server must bind the loopback
  address literally, and a test pins `server.address().address ===
  "127.0.0.1"`. No `--host` flag is offered.
- **Offline-first:** request handling performs **no network I/O** — no fetch,
  no DNS, nothing. The only network access is the sync engine's startup
  cycle and the background interval.
- **No fleet-specific values** in code, tests, or docs (no hostnames, IPs
  beyond `127.0.0.1`, or tailnet names); concrete values live only in
  gitignored env/config.

## Wire contract (normative, frozen)

`POST http://127.0.0.1:<port>/document`, `content-type: application/json`,
`Authorization: Bearer <pairing-token>`. Browser clients must send an
`Origin` header matching the `--origin` allow-list; non-browser clients may
omit `Origin`.

Requests (exactly one `cmd` per body):

```ts
type ServeRequest =
  | { cmd: "search"; query: string }
  | { cmd: "render-citation"; objectIds: string[]; styleId: string; locator?: string }
  | { cmd: "render-bibliography"; objectIds: string[]; styleId: string }
  | { cmd: "list-styles" };
```

Success responses:

```ts
{ ok: true, results: Array<{
    objectId: string;   // the Notees node id
    title: string;
    citekey?: string;   // absent when the source has no citekey property
    authors?: string[]; // absent when no authors/linkedAuthors resolve
    year?: number;      // absent when no publicationDate resolves
    classKey?: string;  // the source subclass ("book", "journal_article", …)
}> }                                    // search
{ ok: true, citation: string }         // render-citation
{ ok: true, bibliography: string }     // render-bibliography
{ ok: true, styles: Array<{ id: string; label: string }> }  // list-styles
```

Error envelope (all four commands; the only `code` values):

```ts
{ ok: false, error: { code: "unknown_cmd" | "not_found" | "render_failed" | "bad_request",
                      message: string } }
```

HTTP status mapping (the status carries transport semantics; the wire `code`
stays in the four-value vocabulary):

| Condition | HTTP | `error.code` |
|---|---|---|
| Missing/wrong bearer token | 401 | `bad_request` |
| Disallowed `Origin` | 403 | `bad_request` |
| Non-POST or path ≠ `/document` | 404 | `bad_request` |
| Unparseable/oversized body, invalid shape, empty `objectIds` | 400 | `bad_request` |
| Unknown `cmd` | 400 | `unknown_cmd` |
| Unknown object id or unknown `styleId` | 404 | `not_found` |
| citeproc threw during a render | 422 | `render_failed` |

`citation`/`bibliography` strings are **raw citeproc output**: they may
contain light markup (`<i>`, `<b>`, `<span class="nocase">…</span>`), which
the Word add-in maps to Word runs. `chicago-note-bibliography` is a note
style — its `citation` is note text, not an in-text parenthetical.
`locator` renders as a page locator (`label: "page"`).

## Review Focus (failure modes to keep green)

1. **Bridge started but the workspace store is missing or locked.** A live
   second bridge on the same store must exit 4 (pid-checked lock file); a
   missing store with an unreachable server must fail loudly at startup; a
   missing store with a reachable server bootstraps normally; an existing
   store with a failed initial sync must still serve (stale-but-working)
   with a stderr warning.
2. **Citekey-less sources.** Search omits `citekey`; CSL-JSON `id` falls
   back to the node id (`nodeToCsl` already guarantees this) so renders of
   mixed citekey'd/citekey-less selections work.
3. **Malformed CSL style id.** Unknown ids answer `not_found`; the id regex
   blocks path traversal (`../../etc/passwd` can never become a file read).
4. **Concurrent Word requests.** All store reads are synchronous on one
   better-sqlite3 connection — Node serializes them; the background sync
   timer cannot interleave mid-request. A test pins 24 parallel mixed calls
   all answering well-formed envelopes.
5. **CSL style render error mid-bibliography.** citeproc failures are caught
   per request into `render_failed` (HTTP 422); the engine is per-request
   (no shared mutable state), so the bridge stays up and later requests are
   unaffected.

---

### Task 1: `serve` command skeleton + config resolution

**Files**
- Create: `src/serve/config.ts`
- Create: `src/serve/document.ts` (dispatcher shell — `not_implemented` pass-through for now; filled in Task 4/7/8)
- Modify: `src/cli.ts` (command registration + `runServe` skeleton + `HELP_ROWS`)
- Create: `test/serve-config.test.ts`

**Interfaces**

Consumes:
- commander options bag `{ port?: string; origin?: string[]; tokenFile?: string; syncInterval?: string; stylesDir?: string }` (the `--origin` parser collects repeats).
- `process.env.NOTEES_SERVE_TOKEN` (pin-a-token escape hatch for dev/tests).

Produces:
```ts
// src/serve/config.ts
export interface ServeConfig {
  readonly host: "127.0.0.1";       // fixed; no override exists
  readonly port: number;            // 0 = OS-assigned (tests); default 8474
  readonly origins: readonly string[]; // allowed Origin header values
  readonly token: string;           // env-pinned or freshly generated
  readonly tokenFile?: string;
  readonly syncIntervalMs: number;  // default 60_000
  readonly stylesDir?: string;      // extra user-supplied .csl directory
}
export function resolveServeConfig(options: {
  port?: string; origin?: string[]; tokenFile?: string; syncInterval?: string; stylesDir?: string;
}, env?: NodeJS.ProcessEnv): ServeConfig;
```

**Steps**

- [ ] Write the failing config tests — `test/serve-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { resolveServeConfig } from "../src/serve/config.js";
import { EXIT } from "../src/exit-codes.js";

describe("resolveServeConfig", () => {
  it("applies the defaults: loopback host, port 8474, 60s sync interval, generated token", () => {
    const config = resolveServeConfig({}, {});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8474);
    expect(config.origins).toEqual([]);
    expect(config.syncIntervalMs).toBe(60_000);
    expect(config.token.length).toBeGreaterThanOrEqual(32);
  });

  it("honors NOTEES_SERVE_TOKEN over a generated token", () => {
    const config = resolveServeConfig({}, { NOTEES_SERVE_TOKEN: "pinned-token" });
    expect(config.token).toBe("pinned-token");
  });

  it("collects --origin repeats and carries the optional paths", () => {
    const config = resolveServeConfig({
      origin: ["https://word.example", "https://word2.example"],
      tokenFile: "/tmp/token",
      stylesDir: "/tmp/styles",
      syncInterval: "30",
      port: "9000",
    }, {});
    expect(config.origins).toEqual(["https://word.example", "https://word2.example"]);
    expect(config.tokenFile).toBe("/tmp/token");
    expect(config.stylesDir).toBe("/tmp/styles");
    expect(config.syncIntervalMs).toBe(30_000);
    expect(config.port).toBe(9000);
  });

  it.each(["-1", "65536", "abc", "1.5"])(
    "rejects --port %s with the usage exit code",
    (port) => {
      let caught: unknown;
      try {
        resolveServeConfig({ port }, {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ exitCode: EXIT.usage });
    },
  );

  it("rejects a sub-5-second sync interval", () => {
    expect(() => resolveServeConfig({ syncInterval: "2" }, {})).toThrowError(
      expect.objectContaining({ exitCode: EXIT.usage }),
    );
  });
});
```

- [ ] Implement `src/serve/config.ts`:

```ts
import { randomBytes } from "node:crypto";

import { CliError, EXIT } from "../exit-codes.js";

export interface ServeConfig {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly origins: readonly string[];
  readonly token: string;
  readonly tokenFile?: string;
  readonly syncIntervalMs: number;
  readonly stylesDir?: string;
}

/**
 * Flag/env resolution for `notees serve`. The loopback bind has no flag —
 * it is the command's reason to exist (the Word add-in ↔ localhost bridge),
 * so `host` is a constant, not an option.
 */
export function resolveServeConfig(options: {
  port?: string;
  origin?: string[];
  tokenFile?: string;
  syncInterval?: string;
  stylesDir?: string;
}, env: NodeJS.ProcessEnv = process.env): ServeConfig {
  const port = Number.parseInt(options.port ?? "8474", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(EXIT.usage, `--port must be an integer between 0 and 65535 (got "${options.port ?? ""}")`);
  }
  const syncSeconds = Number.parseInt(options.syncInterval ?? "60", 10);
  if (!Number.isInteger(syncSeconds) || syncSeconds < 5) {
    throw new CliError(EXIT.usage, "--sync-interval must be an integer >= 5 seconds");
  }
  const envToken = env.NOTEES_SERVE_TOKEN;
  return {
    host: "127.0.0.1",
    port,
    origins: options.origin ?? [],
    token: envToken !== undefined && envToken.length > 0 ? envToken : randomBytes(24).toString("base64url"),
    ...(options.tokenFile !== undefined ? { tokenFile: options.tokenFile } : {}),
    syncIntervalMs: syncSeconds * 1000,
    ...(options.stylesDir !== undefined ? { stylesDir: options.stylesDir } : {}),
  };
}
```

- [ ] Create the dispatcher shell `src/serve/document.ts`:

```ts
import { serveError, type ServeRequest, type ServeResponse } from "./protocol.js";

/**
 * The /document command dispatcher. Tasks 4/7/8 fill in the real arms; the
 * shell already fixes the shape: dispatch NEVER throws — every failure is an
 * error envelope (the server turns unexpected throws into bad_request).
 */
export async function dispatchDocument(
  context: unknown,
  request: ServeRequest,
): Promise<ServeResponse> {
  void context;
  return serveError("unknown_cmd", `cmd "${request.cmd}" is not wired yet`);
}
```

- [ ] Register the command in `src/cli.ts` (next to the `sync` command
      registration, ~line 4822). Add the handler near `syncOnce`:

```ts
async function runServe(ctx: CommandContext, options: {
  port?: string;
  origin?: string[];
  tokenFile?: string;
  syncInterval?: string;
  stylesDir?: string;
}): Promise<void> {
  const config = resolveServeConfig(options);
  if (config.tokenFile !== undefined) {
    writeFileSync(config.tokenFile, `${config.token}\n`, { mode: 0o600 });
  }
  // Task 4 wires the real session + bridge; the skeleton keeps the command
  // parseable and the config tested end-to-end.
  ctx.io.stderr.write(
    `notees serve: listening on http://${config.host}:${config.port} (sync every ${config.syncIntervalMs / 1000}s)\n` +
      `pairing token: ${config.token}\n`,
  );
}
```

```ts
const serve = program
  .command("serve")
  .description(
    "run the localhost citation bridge for the Word add-in (127.0.0.1 only; search + CSL renders over the local store; runs until Ctrl-C)",
  )
  .option("--port <n>", "port to bind (default 8474; 0 = OS-assigned)", "8474")
  .addOption(
    new Option("--origin <url>", "allowed Word add-in web origin (repeatable); requests carrying an Origin header must match")
      .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value]),
  )
  .option("--token-file <path>", "also write the pairing token to this file (mode 0600)")
  .option("--sync-interval <seconds>", "background sync interval, >= 5 (default 60)", "60")
  .option("--styles-dir <dir>", "directory of user-supplied .csl styles (bundled styles always available)")
  .action(async (options, command: Command) => {
    await runServe(ctxOf(command), options);
  });
```

- [ ] Add `serve: { flags: "[--port · --origin · --token-file · --styles-dir]" }` to
      `HELP_ROWS` (the overview fails loud when a top-level command has no row).
- [ ] `pnpm test -- test/serve-config.test.ts && pnpm typecheck` — green.

### Task 2: protocol types + strict request parser

**Files**
- Create: `src/serve/protocol.ts`
- Create: `test/serve-protocol.test.ts`

**Interfaces**

Produces (this module is the single source of the frozen wire contract):

```ts
export type ServeErrorCode = "unknown_cmd" | "not_found" | "render_failed" | "bad_request";
export interface ServeErrorBody { ok: false; error: { code: ServeErrorCode; message: string } }
export interface SearchResultItem {
  objectId: string; title: string;
  citekey?: string; authors?: string[]; year?: number; classKey?: string;
}
export type ServeRequest =
  | { cmd: "search"; query: string }
  | { cmd: "render-citation"; objectIds: string[]; styleId: string; locator?: string }
  | { cmd: "render-bibliography"; objectIds: string[]; styleId: string }
  | { cmd: "list-styles" };
export type ServeResponse =
  | { ok: true; results: SearchResultItem[] }
  | { ok: true; citation: string }
  | { ok: true; bibliography: string }
  | { ok: true; styles: Array<{ id: string; label: string }> }
  | ServeErrorBody;
export function serveError(code: ServeErrorCode, message: string): ServeErrorBody;
export function parseServeRequest(body: unknown):
  | { ok: true; request: ServeRequest }
  | { ok: false; response: ServeErrorBody };
```

**Steps**

- [ ] Write the failing parser tests — `test/serve-protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseServeRequest, serveError } from "../src/serve/protocol.js";

describe("parseServeRequest", () => {
  it.each([null, undefined, 42, "search", []])("rejects non-object bodies: %j", (body) => {
    const parsed = parseServeRequest(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.error.code).toBe("bad_request");
  });

  it("parses search", () => {
    expect(parseServeRequest({ cmd: "search", query: "dune" })).toEqual({
      ok: true,
      request: { cmd: "search", query: "dune" },
    });
  });

  it("rejects search without a non-empty string query", () => {
    for (const query of [undefined, "", 7]) {
      const parsed = parseServeRequest({ cmd: "search", query });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.response.error.code).toBe("bad_request");
    }
  });

  it("parses render-citation with and without a locator", () => {
    expect(
      parseServeRequest({ cmd: "render-citation", objectIds: ["a", "b"], styleId: "apa" }),
    ).toEqual({ ok: true, request: { cmd: "render-citation", objectIds: ["a", "b"], styleId: "apa" } });
    expect(
      parseServeRequest({ cmd: "render-citation", objectIds: ["a"], styleId: "apa", locator: "23" }),
    ).toEqual({
      ok: true,
      request: { cmd: "render-citation", objectIds: ["a"], styleId: "apa", locator: "23" },
    });
  });

  it("rejects empty/non-string objectIds and missing styleId", () => {
    for (const body of [
      { cmd: "render-citation", objectIds: [], styleId: "apa" },
      { cmd: "render-citation", objectIds: ["a", 3], styleId: "apa" },
      { cmd: "render-bibliography", objectIds: ["a"], styleId: "" },
      { cmd: "render-citation", objectIds: ["a"], styleId: "apa", locator: 5 },
    ]) {
      const parsed = parseServeRequest(body);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.response.error.code).toBe("bad_request");
    }
  });

  it("parses list-styles and answers unknown_cmd otherwise", () => {
    expect(parseServeRequest({ cmd: "list-styles" })).toEqual({
      ok: true,
      request: { cmd: "list-styles" },
    });
    const parsed = parseServeRequest({ cmd: "refresh" });
    expect(parsed).toEqual({
      ok: false,
      response: serveError("unknown_cmd", 'unknown cmd "refresh"'),
    });
  });
});
```

- [ ] Implement `src/serve/protocol.ts` (full module):

```ts
/**
 * The /document wire contract — the single source the Word add-in lane codes
 * against. The parser is STRICT: any shape deviation is bad_request, never a
 * thrown exception (the server maps unexpected throws to bad_request too, but
 * validation belongs here where the contract lives).
 */

export type ServeErrorCode = "unknown_cmd" | "not_found" | "render_failed" | "bad_request";

export interface ServeErrorBody {
  ok: false;
  error: { code: ServeErrorCode; message: string };
}

export interface SearchResultItem {
  objectId: string;
  title: string;
  citekey?: string;
  authors?: string[];
  year?: number;
  classKey?: string;
}

export type ServeRequest =
  | { cmd: "search"; query: string }
  | { cmd: "render-citation"; objectIds: string[]; styleId: string; locator?: string }
  | { cmd: "render-bibliography"; objectIds: string[]; styleId: string }
  | { cmd: "list-styles" };

export type ServeResponse =
  | { ok: true; results: SearchResultItem[] }
  | { ok: true; citation: string }
  | { ok: true; bibliography: string }
  | { ok: true; styles: Array<{ id: string; label: string }> }
  | ServeErrorBody;

export function serveError(code: ServeErrorCode, message: string): ServeErrorBody {
  return { ok: false, error: { code, message } };
}

export function parseServeRequest(body: unknown):
  | { ok: true; request: ServeRequest }
  | { ok: false; response: ServeErrorBody } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, response: serveError("bad_request", "body must be a JSON object") };
  }
  const record = body as Record<string, unknown>;
  const cmd = record.cmd;
  if (typeof cmd !== "string") {
    return { ok: false, response: serveError("bad_request", "cmd is required") };
  }
  switch (cmd) {
    case "search": {
      if (typeof record.query !== "string" || record.query.length === 0) {
        return { ok: false, response: serveError("bad_request", "search requires a non-empty string query") };
      }
      return { ok: true, request: { cmd: "search", query: record.query } };
    }
    case "render-citation":
    case "render-bibliography": {
      const { objectIds, styleId, locator } = record;
      if (
        !Array.isArray(objectIds) ||
        objectIds.length === 0 ||
        !objectIds.every((id): id is string => typeof id === "string")
      ) {
        return { ok: false, response: serveError("bad_request", `${cmd} requires a non-empty string array objectIds`) };
      }
      if (typeof styleId !== "string" || styleId.length === 0) {
        return { ok: false, response: serveError("bad_request", `${cmd} requires a string styleId`) };
      }
      if (locator !== undefined && typeof locator !== "string") {
        return { ok: false, response: serveError("bad_request", "locator must be a string") };
      }
      return {
        ok: true,
        request:
          cmd === "render-citation"
            ? { cmd: "render-citation", objectIds, styleId, ...(locator !== undefined ? { locator } : {}) }
            : { cmd: "render-bibliography", objectIds, styleId },
      };
    }
    case "list-styles":
      return { ok: true, request: { cmd: "list-styles" } };
    default:
      return { ok: false, response: serveError("unknown_cmd", `unknown cmd "${cmd}"`) };
  }
}
```

- [ ] `pnpm test -- test/serve-protocol.test.ts && pnpm typecheck` — green.

### Task 3: HTTP server — loopback bind, token auth, origin check

**Files**
- Create: `src/serve/server.ts`
- Create: `test/serve-server.test.ts`
- Modify: `tsup.config.ts` (add `citeproc` to `noExternal` — done now so the
  build never regresses before Task 6 needs it)

**Interfaces**

Consumes: `ServeConfig` (Task 1), `parseServeRequest`/`ServeResponse` (Task 2).

Produces:
```ts
// src/serve/server.ts
export interface Bridge {
  readonly port: number;   // the ACTUAL bound port (config.port may be 0)
  readonly token: string;
  close(): Promise<void>;
}
export interface BridgeHandlers {
  /** Executes one parsed command. Must never throw. */
  dispatch(request: ServeRequest): Promise<ServeResponse>;
}
export function startBridge(config: ServeConfig, handlers: BridgeHandlers): Promise<Bridge>;
```

**Steps**

- [ ] Write the failing server tests — `test/serve-server.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveServeConfig } from "../src/serve/config.js";
import { serveError, type ServeRequest, type ServeResponse } from "../src/serve/protocol.js";
import { startBridge, type Bridge } from "../src/serve/server.js";

describe("startBridge", () => {
  let bridge: Bridge | undefined;

  beforeEach(() => {
    bridge = undefined;
  });
  afterEach(async () => {
    await bridge?.close();
  });

  async function post(
    port: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: ServeResponse }> {
    const response = await fetch(`http://127.0.0.1:${port}/document`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as ServeResponse };
  }

  it("binds 127.0.0.1 and answers a tokened POST /document", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    const seen: ServeRequest[] = [];
    bridge = await startBridge(config, {
      dispatch: async (request) => {
        seen.push(request);
        return { ok: true, styles: [] };
      },
    });
    const res = await post(bridge.port, { cmd: "list-styles" }, {
      authorization: "Bearer test-token",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, styles: [] });
    expect(seen).toEqual([{ cmd: "list-styles" }]);
  });

  it("rejects a missing or wrong bearer token with 401", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    bridge = await startBridge(config, { dispatch: async () => ({ ok: true, styles: [] }) });
    for (const auth of [undefined, "Bearer wrong", "test-token"]) {
      const res = await post(bridge.port, { cmd: "list-styles" }, auth === undefined ? {} : { authorization: auth });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(serveError("bad_request", "missing or invalid bearer token"));
    }
  });

  it("rejects a disallowed Origin with 403 but allows listed and absent origins", async () => {
    const config = resolveServeConfig(
      { port: "0", origin: ["https://word.example"] },
      { NOTEES_SERVE_TOKEN: "test-token" },
    );
    bridge = await startBridge(config, { dispatch: async () => ({ ok: true, styles: [] }) });
    const headers = { authorization: "Bearer test-token" };

    const blocked = await post(bridge.port, { cmd: "list-styles" }, { ...headers, origin: "https://evil.example" });
    expect(blocked.status).toBe(403);

    const allowed = await post(bridge.port, { cmd: "list-styles" }, { ...headers, origin: "https://word.example" });
    expect(allowed.status).toBe(200);

    // Non-browser clients (curl, tests) omit Origin entirely.
    const noOrigin = await post(bridge.port, { cmd: "list-styles" }, headers);
    expect(noOrigin.status).toBe(200);
  });

  it("answers 404 for wrong paths and methods", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    bridge = await startBridge(config, { dispatch: async () => ({ ok: true, styles: [] }) });
    const res = await fetch(`http://127.0.0.1:${bridge.port}/other`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(serveError("bad_request", "POST /document only"));
  });

  it("rejects non-JSON and oversized bodies with 400", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    bridge = await startBridge(config, { dispatch: async () => ({ ok: true, styles: [] }) });
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };

    const notJson = await post(bridge.port, "{not json", headers);
    expect(notJson.status).toBe(400);

    const huge = await post(bridge.port, JSON.stringify({ cmd: "search", query: "x".repeat(1_100_000) }), headers);
    expect(huge.status).toBe(400);
    expect(huge.body).toEqual(serveError("bad_request", "request body too large (max 1 MB)"));
  });

  it("maps command error envelopes to their HTTP statuses", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    bridge = await startBridge(config, {
      dispatch: async (request) =>
        request.cmd === "search"
          ? serveError("unknown_cmd", "unknown cmd")
          : serveError("not_found", "gone"),
    });
    const headers = { authorization: "Bearer test-token" };
    expect((await post(bridge.port, { cmd: "search", query: "x" }, headers)).status).toBe(400);
    expect((await post(bridge.port, { cmd: "list-styles" }, headers)).status).toBe(404);
  });

  it("survives a throwing dispatch (turns the throw into 400 bad_request)", async () => {
    const config = resolveServeConfig({ port: "0" }, { NOTEES_SERVE_TOKEN: "test-token" });
    bridge = await startBridge(config, {
      dispatch: async () => {
        throw new Error("boom");
      },
    });
    const res = await post(bridge.port, { cmd: "list-styles" }, { authorization: "Bearer test-token" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(serveError("bad_request", "boom"));
    // And the next request still works.
    const again = await post(bridge.port, { cmd: "list-styles" }, { authorization: "Bearer test-token" });
    expect(again.status).toBe(400); // still the throwing stub — but answered, not crashed
  });
});
```

- [ ] Implement `src/serve/server.ts`:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { CliError, EXIT } from "../exit-codes.js";
import { parseServeRequest, serveError, type ServeRequest, type ServeResponse } from "./protocol.js";
import type { ServeConfig } from "./config.js";

const MAX_BODY_BYTES = 1_048_576; // 1 MB — request bodies are tiny command envelopes

export interface Bridge {
  /** The ACTUAL bound port (config.port may be 0 = OS-assigned). */
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

export interface BridgeHandlers {
  /** Executes one parsed command against the local store. Must never throw. */
  dispatch(request: ServeRequest): Promise<ServeResponse>;
}

function statusFor(response: ServeResponse): number {
  if (response.ok) return 200;
  // Transport semantics in the HTTP status; the wire code stays in the
  // four-value vocabulary (see the plan's contract table).
  if (response.error.code === "not_found") return 404;
  if (response.error.code === "render_failed") return 422;
  return 400;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`request body too large (max ${MAX_BODY_BYTES / 1_048_576} MB)`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Start the localhost bridge. The loopback bind is non-negotiable: the
 * config carries `host: "127.0.0.1"` as a literal type and the post-listen
 * address check fails the start (rather than serving) if the platform ever
 * resolved anything else.
 */
export async function startBridge(config: ServeConfig, handlers: BridgeHandlers): Promise<Bridge> {
  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, config, handlers);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== config.host) {
    server.close();
    throw new CliError(EXIT.domain, `refusing to serve: bound address is not ${config.host}`);
  }
  return {
    port: address.port,
    token: config.token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServeConfig,
  handlers: BridgeHandlers,
): Promise<void> {
  const respond = (status: number, body: ServeResponse): void => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== "POST" || req.url !== "/document") {
      respond(404, serveError("bad_request", "POST /document only"));
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin === "string" && !config.origins.includes(origin)) {
      respond(403, serveError("bad_request", `origin "${origin}" is not allowed`));
      return;
    }
    if (req.headers.authorization !== `Bearer ${config.token}`) {
      respond(401, serveError("bad_request", "missing or invalid bearer token"));
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      respond(400, serveError("bad_request", "body is not valid JSON"));
      return;
    }
    const request = parseServeRequest(parsed);
    if (!request.ok) {
      respond(400, request.response);
      return;
    }
    const response = await handlers.dispatch(request.request);
    respond(statusFor(response), response);
  } catch (error) {
    respond(400, serveError("bad_request", error instanceof Error ? error.message : String(error)));
  }
}
```

- [ ] Modify `tsup.config.ts`: extend `noExternal` to
      `[/^@notees\//, "commander", "sax", "citeproc"]` (citeproc lands in
      Task 6; configuring the bundler now keeps `pnpm build` meaningful at
      every task boundary).
- [ ] `pnpm test -- test/serve-server.test.ts && pnpm typecheck` — green.

### Task 4: bridge session over the local store + `search`

**Files**
- Modify: `src/local-workspace.ts` (add `bestEffortSync` + `onWarning`
  options to `LocalWorkspaceOptions`; best-effort catches the bootstrap sync
  failure when a store file already exists and serves the stale projection)
- Create: `src/serve/session.ts`
- Create: `src/serve/cite.ts` (interface + stub for now: every render answers
  `render_failed "not wired"` — Task 6 replaces the body with citeproc)
- Modify: `src/serve/document.ts` (wire the real `search` arm)
- Modify: `src/cli.ts` (`runServe` opens the session + bridge and blocks;
  SIGINT/SIGTERM shut down cleanly)
- Create: `test/helpers/serve-harness.ts` (the real-server harness shared by
  all `serve*.test.ts` files)
- Create: `test/serve.test.ts` (the file grows in Tasks 5–8; this task lands
  its `beforeAll` seeding + search tests)

**Interfaces**

Consumes:
- `openLocalWorkspace` / `LocalWorkspace` from `src/local-workspace.ts`
  (`runQueryAst` — the `@notees/query` executor over the local derived
  store; `getObject(id)` for result enrichment).
- `SYSTEM_CLASS_UUIDS.source` (`"00000000-0000-0000-0001-000000000023"`),
  `SYSTEM_PROPERTY_UUIDS.citekey | authors | publicationDate`,
  `sourceClassOf`, `yearFromDate` from `@notees/domain` / `@notees/export`.
- The QueryAST v2 shape from `@notees/protocol` (via `@notees/query`):
  `{ version: 2, scope: { type: "entire_workspace" }, root: { type: "group",
  logic: "and", children: [member class in [source + roster], content fts] }
  }` — the `member` family is extends-closure membership; the target still
  lists `source` plus every roster id from `@notees/export`'s
  `SOURCE_CLASS_IDS` explicitly, so subclass-only nodes match even where a
  store predates the extends edges.

Produces:
```ts
// src/serve/session.ts
export interface BridgeSessionOptions {
  server: string; apiKey: string; workspaceId: string;
  storeDir: string; statePath: string; stateKey: string;
  syncIntervalMs: number;
  onWarning(message: string): void;
}
export interface BridgeSession {
  readonly local: LocalWorkspace;
  searchSources(query: string, limit?: number): SearchResultItem[];
  close(): void;   // clears the sync timer, closes the store, releases the lock
}
export function openBridgeSession(options: BridgeSessionOptions): Promise<BridgeSession>;
```

**Steps**

- [ ] Write the failing session tests first (they need the harness — build
      it now). `test/helpers/serve-harness.ts` (mirrors `test/cli.test.ts`'s
      `bootServer`: one real `@notees/server`, temp data dir, `API_KEY`,
      `Capture` io, `seedObject`/`seedProperty` via `runCli`):

```ts
// test/helpers/serve-harness.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildServer } from "@notees/server";

import { run, type CliIo } from "../../src/cli.js";

export const API_KEY = `nk_${"c".repeat(32)}`;

export class Capture implements CliIo {
  stdoutText = "";
  stderrText = "";
  isTty = false;
  stdout = { write: (chunk: string) => { this.stdoutText += chunk; } };
  stderr = { write: (chunk: string) => { this.stderrText += chunk; } };
}

export interface Harness {
  app: Awaited<ReturnType<typeof buildServer>>["app"];
  server: import("node:net").Server;
  baseUrl: string;
  dataDir: string;
  stateFile: string;
  runCli(...args: string[]): Promise<number>;
  seedObject(name: string, classIds: string[]): Promise<string>;
  seedProperty(objectId: string, schemaId: string, value: unknown): Promise<void>;
  close(): Promise<void>;
}

export async function bootServer(): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), "notees-serve-test-"));
  const stateFile = join(dataDir, "cli-state.json");
  const { app } = await buildServer({
    dataDir,
    apiKey: API_KEY,
    port: 0,
    host: "127.0.0.1",
    logger: false,
    relayBatchPerMinute: 30_000,
    globalRequestsPerMinute: 10_000,
    maxMediaBytes: 50 * 1024 * 1024,
    maxDocumentBytes: 100 * 1024 * 1024,
    loginPerMinute: 10,
    signupEnabled: false,
    resolverTimeoutMs: 10_000,
  } as Parameters<typeof buildServer>[0]);
  const server = await new Promise<import("node:net").Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  const io = new Capture();
  const runCli = async (...args: string[]): Promise<number> =>
    run([...args, "--server", baseUrl, "--key", API_KEY], io);
  const seedObject = async (name: string, classIds: string[]): Promise<string> => {
    const code = await runCli("object", "create", "--name", name, ...classIds.flatMap((id) => ["--class", id]));
    if (code !== 0) throw new Error(`seedObject ${name} failed: ${io.stderrText}`);
    const id = io.stdoutText.trim().split("\n").pop() ?? "";
    io.stdoutText = "";
    return id;
  };
  const seedProperty = async (objectId: string, schemaId: string, value: unknown): Promise<void> => {
    const code = await runCli("object", "property", "set", objectId, schemaId, JSON.stringify(value));
    if (code !== 0) throw new Error(`seedProperty failed: ${io.stderrText}`);
    io.stdoutText = "";
  };
  const close = async (): Promise<void> => {
    await app.close();
    server.close();
  };
  return { app, server, baseUrl, dataDir, stateFile, runCli, seedObject, seedProperty, close };
}
```

- [ ] Then `test/serve.test.ts` — seeding, session + bridge in `beforeAll`,
      and the `call` helper:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { defaultWorkspaceId } from "@notees/server";

import { createCiteRenderer } from "../src/serve/cite.js";
import { resolveServeConfig } from "../src/serve/config.js";
import { dispatchDocument } from "../src/serve/document.js";
import type { ServeResponse } from "../src/serve/protocol.js";
import { startBridge, type Bridge } from "../src/serve/server.js";
import { openBridgeSession, type BridgeSession } from "../src/serve/session.js";

import { API_KEY, bootServer, type Harness } from "./helpers/serve-harness.js";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

let harness: Harness;
let session: BridgeSession;
let bridge: Bridge;
const warnings: string[] = [];

// Seeded node ids, shared by the assertions in every describe below.
let duneId = "";
let articleId = "";
let plainPageId = "";

beforeAll(async () => {
  harness = await bootServer();
  // Two sources: one fully decorated, one citekey-less.
  duneId = await harness.seedObject("Dune", [SYSTEM_CLASS_UUIDS.source, SYSTEM_CLASS_UUIDS.book]);
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.citekey, "herbert1965dune");
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.authors, ["Herbert, Frank"]);
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.publicationDate, "1965");
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.publisher, "Chilton Books");
  articleId = await harness.seedObject("Sandworms of Note", [
    SYSTEM_CLASS_UUIDS.source,
    SYSTEM_CLASS_UUIDS.journal_article,
  ]);
  await harness.seedProperty(articleId, SYSTEM_PROPERTY_UUIDS.authors, ["Atreides, Paul"]);
  await harness.seedProperty(articleId, SYSTEM_PROPERTY_UUIDS.publicationDate, "2020");
  // A non-source page that FTS would still hit — search must filter it out.
  plainPageId = await harness.seedObject("Dune (film) notes", []);

  session = await openBridgeSession({
    server: harness.baseUrl,
    apiKey: API_KEY,
    workspaceId: defaultWorkspaceId,
    storeDir: join(dirname(harness.stateFile), "stores"),
    statePath: harness.stateFile,
    stateKey: `default:${harness.baseUrl}`,
    syncIntervalMs: 3_600_000, // background sync must not interfere with tests
    onWarning: (message) => warnings.push(message),
  });
  const config = resolveServeConfig({ port: "0" }, {});
  const renderer = createCiteRenderer();
  bridge = await startBridge(config, {
    dispatch: (request) => dispatchDocument({ session, renderer }, request),
  });
}, 60_000);

afterAll(async () => {
  await bridge?.close();
  session?.close();
  await harness?.close();
  rmSync(harness?.dataDir ?? "", { recursive: true, force: true });
});

async function call(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: ServeResponse }> {
  const response = await fetch(`http://127.0.0.1:${bridge.port}/document`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ServeResponse };
}
```

- [ ] Search tests (in the same file):

```ts
describe("search", () => {
  it("finds sources by FTS and projects the result envelope", async () => {
    const res = await call({ cmd: "search", query: "Dune" });
    expect(res.status).toBe(200);
    if (!res.body.ok) throw new Error(JSON.stringify(res.body));
    const hit = res.body.results.find((r) => r.title === "Dune");
    expect(hit).toMatchObject({
      objectId: expect.any(String),
      title: "Dune",
      citekey: "herbert1965dune",
      authors: ["Herbert, Frank"],
      year: 1965,
      classKey: "book",
    });
    // The non-source page matched by FTS must be filtered out.
    expect(res.body.results.some((r) => r.title === "Dune (film) notes")).toBe(false);
  });

  it("omits citekey/authors/year when the source carries none", async () => {
    const res = await call({ cmd: "search", query: "Sandworms" });
    if (!res.body.ok) throw new Error(JSON.stringify(res.body));
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ title: "Sandworms of Note", classKey: "journal_article" });
    expect(res.body.results[0]).not.toHaveProperty("citekey");
    expect(res.body.results[0]).toHaveProperty("authors", ["Atreides, Paul"]);
  });

  it("answers an empty results array for a no-match query", async () => {
    const res = await call({ cmd: "search", query: "no-such-title-xyz" });
    expect(res.body).toEqual({ ok: true, results: [] });
  });
});
```

- [ ] Create the renderer interface + stub — `src/serve/cite.ts` (the Task 6
      slice replaces the stub bodies with citeproc; the interface is final):

```ts
import type { CslItem } from "@notees/export";

import { serveError, type ServeErrorBody } from "./protocol.js";

export interface CiteRenderer {
  /** Raw citeproc cluster string — light markup (<i>, <b>) included. */
  renderCitation(items: CslItem[], styleId: string, locator?: string): string | ServeErrorBody;
  /** Raw citeproc bibliography entries, newline-joined. */
  renderBibliography(items: CslItem[], styleId: string): string | ServeErrorBody;
}

/** Stub until the citeproc slice (Task 6): renders fail loud, never throw. */
export function createCiteRenderer(_stylesDir?: string): CiteRenderer {
  const notWired = () => serveError("render_failed", "citation rendering lands with the citeproc slice");
  return { renderCitation: notWired, renderBibliography: notWired };
}
```

- [ ] Implement the lock file in `src/serve/session.ts`:

```ts
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { SOURCE_CLASS_IDS, sourceClassOf, yearFromDate } from "@notees/export";

import { CliError, EXIT } from "../exit-codes.js";
import { openLocalWorkspace, type LocalWorkspace } from "../local-workspace.js";
import type { SearchResultItem } from "./protocol.js";

/** Held lock-file fds, by lock path (module-level so close() can release). */
const SERVE_LOCK_FDS = new Map<string, number>();

/**
 * The serve lock: one live bridge per workspace store. A second `notees
 * serve` on the same store would race the derived projection (two engines
 * rewriting one SQLite file), so the loser exits 4 (conflict). The file
 * carries the holder pid; a stale lock (holder dead) is stolen. Crash
 * residue is cleaned by the next successful acquire.
 */
function acquireServeLock(lockPath: string): void {
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, String(process.pid));
    SERVE_LOCK_FDS.set(lockPath, fd);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const holder = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (Number.isInteger(holder) && holder > 1 && isProcessAlive(holder)) {
      throw new CliError(EXIT.conflict, `another notees serve holds this workspace store (pid ${holder})`);
    }
    rmSync(lockPath, { force: true });
    acquireServeLock(lockPath);
  }
}

function releaseServeLock(lockPath: string): void {
  const fd = SERVE_LOCK_FDS.get(lockPath);
  if (fd !== undefined) {
    closeSync(fd);
    SERVE_LOCK_FDS.delete(lockPath);
  }
  rmSync(lockPath, { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] Implement the session:

```ts
export interface BridgeSessionOptions {
  server: string;
  apiKey: string;
  workspaceId: string;
  storeDir: string;
  statePath: string;
  stateKey: string;
  syncIntervalMs: number;
  onWarning(message: string): void;
}

export interface BridgeSession {
  readonly local: LocalWorkspace;
  /** FTS over the local derived store, filtered to the source class family. */
  searchSources(query: string, limit?: number): SearchResultItem[];
  close(): void;
}

export async function openBridgeSession(options: BridgeSessionOptions): Promise<BridgeSession> {
  const lockPath = join(options.storeDir, `${options.workspaceId}.serve.lock`);
  acquireServeLock(lockPath);
  let local: LocalWorkspace;
  try {
    local = await openLocalWorkspace({
      server: options.server,
      apiKey: options.apiKey,
      workspaceId: options.workspaceId,
      storeDir: options.storeDir,
      statePath: options.statePath,
      stateKey: options.stateKey,
      // Offline-first: a reachable store with an unreachable server still
      // serves the last synced projection (Word works with no network).
      bestEffortSync: true,
      onWarning: options.onWarning,
    });
  } catch (error) {
    releaseServeLock(lockPath);
    throw error;
  }
  const syncTimer = setInterval(() => {
    local.sync().catch((error: unknown) => {
      options.onWarning(`background sync failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, options.syncIntervalMs);
  syncTimer.unref();
  return {
    local,
    searchSources(query, limit = 20) {
      // class:source + FTS over the local derived store, executed through
      // @notees/query's executor (LocalWorkspace.runQueryAst) — the normative
      // interface — not a hand-rolled SQL filter. The target carries the
      // `source` base id plus the whole roster: member-in is
      // extends-closure membership, but the roster ids are listed explicitly
      // too so subclass-only nodes match even where a store predates the
      // extends edges. Keystroke tokens are quoted so raw input can never
      // break the FTS MATCH grammar.
      const tokens = query.split(/\s+/).map((token) => token.replace(/"/g, "")).filter((token) => token.length > 0);
      if (tokens.length === 0) return [];
      let ids: string[];
      try {
        const result = local.runQueryAst({
          version: 2,
          scope: { type: "entire_workspace" },
          root: {
            type: "group",
            logic: "and",
            children: [
              {
                type: "member",
                family: "class",
                op: "in",
                target: {
                  mode: "ids",
                  ids: [SYSTEM_CLASS_UUIDS.source, ...Object.values(SOURCE_CLASS_IDS)],
                },
              },
              { type: "content", op: "fts", value: tokens.map((token) => `"${token}"`).join(" ") },
            ],
          },
        }) as { ids: string[] };
        ids = result.ids;
      } catch {
        return []; // an FTS-unparseable query answers empty, never a 500
      }
      const results: SearchResultItem[] = [];
      for (const id of ids.slice(0, limit)) {
        const object = local.getObject(id).object as {
          id: string;
          name: string | null;
          classIds: string[];
          properties?: Array<{ schemaId: string; value: unknown }>;
        };
        const classKey = sourceClassOf(object.classIds);
        if (classKey === undefined) continue; // lost the class race — never leak non-sources
        const props = Array.isArray(object.properties) ? object.properties : [];
        const valuesOf = (schemaId: string): unknown[] =>
          props.filter((p) => p.schemaId === schemaId).map((p) => p.value);
        const stringsOf = (schemaId: string): string[] =>
          valuesOf(schemaId)
            .flatMap((v) => (Array.isArray(v) ? v : [v]))
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .map((v) => v.trim());

        const citekey = stringsOf(SYSTEM_PROPERTY_UUIDS.citekey)[0];
        const authors = stringsOf(SYSTEM_PROPERTY_UUIDS.authors);
        // year: a plain string publicationDate wins; a {nodeId} date ref
        // resolves through the node's current title (one extra read).
        let year: number | undefined;
        for (const value of valuesOf(SYSTEM_PROPERTY_UUIDS.publicationDate)) {
          const literal =
            typeof value === "string"
              ? value
              : typeof (value as { nodeId?: unknown } | null)?.nodeId === "string"
                ? resolveName(local, (value as { nodeId: string }).nodeId)
                : undefined;
          year = literal !== undefined ? yearFromDate(literal) : undefined;
          if (year !== undefined) break;
        }
        results.push({
          objectId: object.id,
          title: object.name ?? "",
          ...(citekey !== undefined ? { citekey } : {}),
          ...(authors.length > 0 ? { authors } : {}),
          ...(year !== undefined ? { year } : {}),
          classKey,
        });
      }
      return results;
    },
    close() {
      clearInterval(syncTimer);
      local.close();
      releaseServeLock(lockPath);
    },
  };
}

function resolveName(local: LocalWorkspace, id: string): string | undefined {
  try {
    const name = (local.getObject(id).object as { name?: string | null }).name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] Modify `src/local-workspace.ts` — extend `LocalWorkspaceOptions` and the
      bootstrap catch in `openLocalWorkspace`:

```ts
export interface LocalWorkspaceOptions {
  // …existing fields…
  /**
   * `notees serve`: a failed bootstrap sync with an EXISTING store file
   * serves the last synced projection (offline-first) instead of dying.
   * A missing store still fails loud — there is nothing to serve.
   */
  bestEffortSync?: boolean;
  /** Warning sink for the best-effort path (and future advisory notes). */
  onWarning?: (message: string) => void;
}
```

```ts
  try {
    await session.bootstrap();
  } catch (error) {
    if (options.bestEffortSync === true && existsSync(storePath)) {
      options.onWarning?.(
        `initial sync failed — serving the last synced store (${error instanceof Error ? error.message : String(error)})`,
      );
    } else {
      store.close();
      throw mapSyncError(error, base);
    }
  }
```

(`existsSync` needs importing from `node:fs` at the top of
`local-workspace.ts`.)

- [ ] Wire the real `search` arm in `src/serve/document.ts`:

```ts
import type { CiteRenderer } from "./cite.js";
import { listStyles } from "./styles.js";
import type { BridgeSession } from "./session.js";
import { serveError, type ServeRequest, type ServeResponse } from "./protocol.js";
import { cslItemFor } from "./csl-items.js";

export interface DocumentContext {
  session: BridgeSession;
  renderer: CiteRenderer;
  stylesDir?: string;
}

export async function dispatchDocument(context: DocumentContext, request: ServeRequest): Promise<ServeResponse> {
  switch (request.cmd) {
    case "search":
      return { ok: true, results: context.session.searchSources(request.query) };
    case "list-styles":
      return { ok: true, styles: listStyles(context.stylesDir) };
    case "render-citation":
    case "render-bibliography": {
      // Tasks 5+6 land cslItemFor/renderer; until then render arms answer
      // not_found for any id — never a thrown exception.
      return serveError("not_found", "render commands land with the citeproc slice");
    }
  }
}
```

- [ ] Finish `runServe` in `src/cli.ts` (and add the serve-module imports at
      the top of the file):

```ts
import { createCiteRenderer } from "./serve/cite.js";
import { resolveServeConfig } from "./serve/config.js";
import { dispatchDocument } from "./serve/document.js";
import { startBridge } from "./serve/server.js";
import { openBridgeSession } from "./serve/session.js";
```

```ts
async function runServe(ctx: CommandContext, options: {
  port?: string;
  origin?: string[];
  tokenFile?: string;
  syncInterval?: string;
  stylesDir?: string;
}): Promise<void> {
  const config = resolveServeConfig(options);
  if (config.tokenFile !== undefined) {
    writeFileSync(config.tokenFile, `${config.token}\n`, { mode: 0o600 });
  }
  const workspaceId = (await ctx.client.workspaceId()) ?? DEFAULT_WORKSPACE_ID;
  const session = await openBridgeSession({
    server: ctx.client.server,
    apiKey: ctx.client.apiKey,
    workspaceId,
    storeDir: join(dirname(ctx.statePath), "stores"),
    statePath: ctx.statePath,
    stateKey: ctx.stateKey,
    syncIntervalMs: config.syncIntervalMs,
    onWarning: (message) => ctx.io.stderr.write(`warning: ${message}\n`),
  });
  const renderer = createCiteRenderer(config.stylesDir);
  const bridge = await startBridge(config, {
    dispatch: (request) => dispatchDocument({ session, renderer, stylesDir: config.stylesDir }, request),
  });
  const shutdown = async (): Promise<void> => {
    await bridge.close();
    session.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  const machine = { ok: true, port: bridge.port, token: bridge.token, workspaceId };
  if (ctx.opts.json === true) {
    ctx.io.stdout.write(`${JSON.stringify(machine)}\n`);
  } else {
    ctx.io.stderr.write(
      `notees serve: bridge listening on http://${config.host}:${bridge.port} (workspace ${workspaceId})\n` +
        `pairing token: ${bridge.token}\n` +
        `press Ctrl-C to stop\n`,
    );
  }
  await new Promise<never>(() => {}); // runs until SIGINT/SIGTERM
}
```

- [ ] Add the lock-conflict pin to `test/serve.test.ts` (Review Focus 1 +
      the second-bridge exit-4 contract):

```ts
describe("store lock", () => {
  it("refuses a second bridge on the same store (exit 4 contract)", async () => {
    await expect(
      openBridgeSession({
        server: harness.baseUrl,
        apiKey: API_KEY,
        workspaceId: defaultWorkspaceId,
        storeDir: join(dirname(harness.stateFile), "stores"),
        statePath: harness.stateFile,
        stateKey: `default:${harness.baseUrl}`,
        syncIntervalMs: 3_600_000,
        onWarning: () => {},
      }),
    ).rejects.toMatchObject({ exitCode: 4 });
  });
});
```

- [ ] `pnpm test -- test/serve.test.ts test/serve-server.test.ts && pnpm typecheck` — green.

### Task 5: CSL-JSON conversion — reuse `@notees/export`

**Files**
- Create: `src/serve/csl-items.ts`
- Create: `test/serve-csl-items.test.ts`

**Interfaces**

Consumes: `LocalWorkspace.getObject` (the full object projection carries
`properties: Array<{ schemaId, schemaName, value }>`), `nodeToCsl`,
`sourceClassOf`, `deriveDisplayName`, `SYSTEM_PROPERTY_UUIDS` — the exact
inputs `exportBibtex` (cli.ts ~line 3796) already assembles.

Produces:
```ts
// src/serve/csl-items.ts
/**
 * One source node → CSL-JSON via @notees/export's nodeToCsl (the mapping is
 * owned there: dual-track authorship, pool bindings, citekey fallback).
 * Returns undefined for missing ids and non-source nodes (the caller maps
 * that to not_found).
 */
export function cslItemFor(local: LocalWorkspace, id: string): CslItem | undefined;
```

**Steps**

- [ ] Write the failing tests — `test/serve-csl-items.test.ts`, reusing the
      shared harness with its own server, seeds, and session (it exercises
      `cslItemFor` directly — no HTTP bridge needed):

```ts
import { afterAll, beforeAll, describe, expect, vi } from "vitest";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "@notees/domain";
import { defaultWorkspaceId } from "@notees/server";

import { cslItemFor } from "../src/serve/csl-items.js";
import { openBridgeSession, type BridgeSession } from "../src/serve/session.js";

import { API_KEY, bootServer, type Harness } from "./helpers/serve-harness.js";

vi.setConfig({ hookTimeout: 30_000, testTimeout: 30_000 });

let harness: Harness;
let session: BridgeSession;
let duneId = "";
let articleId = "";
let plainPageId = "";

beforeAll(async () => {
  harness = await bootServer();
  duneId = await harness.seedObject("Dune", [SYSTEM_CLASS_UUIDS.source, SYSTEM_CLASS_UUIDS.book]);
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.citekey, "herbert1965dune");
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.authors, ["Herbert, Frank"]);
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.publicationDate, "1965");
  await harness.seedProperty(duneId, SYSTEM_PROPERTY_UUIDS.publisher, "Chilton Books");
  articleId = await harness.seedObject("Sandworms of Note", [
    SYSTEM_CLASS_UUIDS.source,
    SYSTEM_CLASS_UUIDS.journal_article,
  ]);
  await harness.seedProperty(articleId, SYSTEM_PROPERTY_UUIDS.authors, ["Atreides, Paul"]);
  plainPageId = await harness.seedObject("Some plain page", []);
  session = await openBridgeSession({
    server: harness.baseUrl,
    apiKey: API_KEY,
    workspaceId: defaultWorkspaceId,
    storeDir: join(dirname(harness.stateFile), "stores"),
    statePath: harness.stateFile,
    stateKey: `default:${harness.baseUrl}`,
    syncIntervalMs: 3_600_000,
    onWarning: () => {},
  });
}, 60_000);

afterAll(async () => {
  session?.close();
  await harness?.close();
  rmSync(harness?.dataDir ?? "", { recursive: true, force: true });
});

describe("cslItemFor", () => {
  it("maps a decorated book through nodeToCsl (citekey, authors, year, publisher)", () => {
    const item = cslItemFor(session.local, duneId)!;
    expect(item).toMatchObject({
      id: "herbert1965dune",
      type: "book",
      title: "Dune",
      author: [{ family: "Herbert", given: "Frank" }],
      issued: { "date-parts": [[1965]] },
      publisher: "Chilton Books",
    });
  });

  it("falls back to the node id when the source has no citekey", () => {
    const item = cslItemFor(session.local, articleId)!;
    expect(item.id).toBe(articleId);
    expect(item.type).toBe("article-journal");
  });

  it("returns undefined for non-source nodes and unknown ids", () => {
    expect(cslItemFor(session.local, plainPageId)).toBeUndefined();
    expect(cslItemFor(session.local, "00000000-0000-0000-0000-00000000dead")).toBeUndefined();
  });
});
```

- [ ] Implement `src/serve/csl-items.ts`:

```ts
import { SYSTEM_PROPERTY_UUIDS, deriveDisplayName } from "@notees/domain";
import { nodeToCsl, sourceClassOf, type CslItem } from "@notees/export";

import type { LocalWorkspace } from "../local-workspace.js";

interface FullObject {
  id: string;
  name: string | null;
  classIds: string[];
  properties?: Array<{ schemaId: string; value: unknown }>;
}

function fullObjectOf(local: LocalWorkspace, id: string): FullObject | undefined {
  try {
    return local.getObject(id).object as unknown as FullObject;
  } catch {
    return undefined;
  }
}

/** Every `{nodeId}` ref carried by a property's rows, in row order. */
function refIdsOf(full: FullObject, schemaId: string): string[] {
  return (full.properties ?? [])
    .filter((p) => p.schemaId === schemaId)
    .flatMap((p) => (Array.isArray(p.value) ? p.value : [p.value]))
    .flatMap((v) =>
      typeof v === "object" && v !== null && typeof (v as { nodeId?: unknown }).nodeId === "string"
        ? [(v as { nodeId: string }).nodeId]
        : [],
    );
}

/**
 * The source node → CSL-JSON projection for the bridge. The mapping itself
 * is @notees/export's nodeToCsl (the same call exportBibtex makes — the
 * export package owns the dual-track authorship read contract and the
 * per-class pool bindings); this module only resolves the caller-side
 * lookups (linkedAuthors agents, publicationDate date refs) against the
 * local store. citekey-less sources ride nodeToCsl's node-id fallback, so
 * they render like any other item.
 */
export function cslItemFor(local: LocalWorkspace, id: string): CslItem | undefined {
  const full = fullObjectOf(local, id);
  if (full === undefined || sourceClassOf(full.classIds) === undefined) return undefined;
  const props = full.properties ?? [];

  const agentNames = new Map<string, string>();
  for (const refId of refIdsOf(full, SYSTEM_PROPERTY_UUIDS.linkedAuthors)) {
    const agent = fullObjectOf(local, refId);
    if (agent === undefined) continue; // unresolvable agent contributes nothing
    const display =
      deriveDisplayName(agent as Parameters<typeof deriveDisplayName>[0]) || agent.name?.trim() || "";
    if (display.length > 0) agentNames.set(refId, display);
  }
  const dateNames = new Map<string, string>();
  for (const refId of refIdsOf(full, SYSTEM_PROPERTY_UUIDS.publicationDate)) {
    const ref = fullObjectOf(local, refId);
    if (ref !== undefined && ref.name !== null && ref.name.trim().length > 0) {
      dateNames.set(refId, ref.name.trim());
    }
  }

  return nodeToCsl(
    { id: full.id, name: full.name, classIds: full.classIds },
    props as Parameters<typeof nodeToCsl>[1],
    {
      resolveName: (refId) => dateNames.get(refId),
      resolveAgentName: (refId) => agentNames.get(refId),
    },
  );
}
```

- [ ] `pnpm test -- test/serve-csl-items.test.ts && pnpm typecheck` — green.

### Task 6: citeproc integration + bundled styles

**Files**
- Create: `src/serve/citeproc.d.ts` (ambient declaration — citeproc-js ships no types)
- Create: `src/serve/styles.ts`
- Create: `src/serve/styles/apa.csl`, `src/serve/styles/ieee.csl`,
  `src/serve/styles/chicago-note-bibliography.csl`,
  `src/serve/styles/locales-en-US.xml` (fetched once, committed)
- Create: `src/serve/styles/generated.ts` (GENERATED — see script)
- Create: `scripts/bundle-styles.mts` + `package.json` script `bundle:styles`
- Modify: `package.json` (dependency `citeproc: ^2.4.63`; run `pnpm install`)
- Modify: `NOTICE` (CSL styles + locale attribution)
- Modify: `src/serve/cite.ts` (replace the Task 4 stub body with the real
  citeproc implementation; the `CiteRenderer` interface stays as declared)
- Create: `test/serve-cite.test.ts` (renderer unit tests incl. the
  render_failed and not_found arms)
- Create: `test/serve-styles.test.ts` (drift gate + list-styles)
- Modify: `test/serve.test.ts` (list-styles + apa render smoke — renders fully land in Tasks 7/8)

**Interfaces**

Produces:
```ts
// src/serve/cite.ts
export interface CiteRenderer {
  /** Raw citeproc cluster string ("(Doe, 2020, p. 23)") or an error envelope. */
  renderCitation(items: CslItem[], styleId: string, locator?: string): string | ServeErrorBody;
  /** Raw citeproc bibliography entries, newline-joined, or an error envelope. */
  renderBibliography(items: CslItem[], styleId: string): string | ServeErrorBody;
}
export function createCiteRenderer(stylesDir?: string): CiteRenderer;

// src/serve/styles.ts
export interface StyleEntry { id: string; label: string }
export const BUNDLED_STYLES: readonly StyleEntry[];
export function listStyles(stylesDir?: string): StyleEntry[];
/** CSL XML for a style id (bundled first, then <stylesDir>/<id>.csl), or undefined. */
export function resolveStyleXml(styleId: string, stylesDir?: string): string | undefined;
export function localeXml(lang: string): string | undefined;
```

**Steps**

- [ ] Fetch and commit the CSL assets (one-time, pinned to the repos'
      current `master`):

```sh
curl -fL -o src/serve/styles/apa.csl https://raw.githubusercontent.com/citation-style-language/styles/master/apa.csl
curl -fL -o src/serve/styles/ieee.csl https://raw.githubusercontent.com/citation-style-language/styles/master/ieee.csl
curl -fL -o src/serve/styles/chicago-note-bibliography.csl https://raw.githubusercontent.com/citation-style-language/styles/master/chicago-note-bibliography.csl
curl -fL -o src/serve/styles/locales-en-US.xml https://raw.githubusercontent.com/citation-style-language/locales/master/locales-en-US.xml
```

      Add to `NOTICE` (repo root): attribution for the CSL styles and the
      `locales-en-US.xml` locale (CC BY-SA 3.0, © Citation Style Language
      project) and note that the `citeproc` package is © Frank Bennett,
      BSD-licensed.

- [ ] Write the generator — `scripts/bundle-styles.mts`:

```ts
/**
 * Generates src/serve/styles/generated.ts from the canonical CSL XML files.
 * The release bundle is a single cli.mjs with no asset directory, so the
 * styles must be inlined as a module. Run: pnpm bundle:styles
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function buildStylesModule(stylesDir: string): string {
  const styles: Record<string, string> = {};
  const locales: Record<string, string> = {};
  for (const file of readdirSync(stylesDir).sort()) {
    if (file.endsWith(".csl")) styles[file.slice(0, -".csl".length)] = readFileSync(join(stylesDir, file), "utf8");
    else if (file.endsWith(".xml")) locales[file.slice(0, -".xml".length)] = readFileSync(join(stylesDir, file), "utf8");
  }
  return [
    "// GENERATED by scripts/bundle-styles.mts — do not edit by hand.",
    "// Regenerate (pnpm bundle:styles) after changing any .csl/.xml file here.",
    `export const BUNDLED_STYLE_XML: Readonly<Record<string, string>> = ${JSON.stringify(styles, null, 2)};`,
    "",
    `export const BUNDLED_LOCALE_XML: Readonly<Record<string, string>> = ${JSON.stringify(locales, null, 2)};`,
    "",
  ].join("\n");
}

const here = new URL("../src/serve/styles/", import.meta.url).pathname;
writeFileSync(join(here, "generated.ts"), buildStylesModule(here));
console.log("generated src/serve/styles/generated.ts");
```

- [ ] Add `"bundle:styles": "tsx scripts/bundle-styles.mts"` to
      `package.json` scripts; run it; commit `generated.ts`.

- [ ] Add the dependency: `pnpm add citeproc@^2.4.63` (runtime dep — tsup
      `noExternal` already updated in Task 3).

- [ ] Write the failing style tests — `test/serve-styles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildStylesModule } from "../scripts/bundle-styles.mts";
import { BUNDLED_STYLES, listStyles, localeXml, resolveStyleXml } from "../src/serve/styles.js";

const stylesDir = fileURLToPath(new URL("../src/serve/styles/", import.meta.url));

describe("bundled styles", () => {
  it("bundles exactly apa, ieee, chicago-note-bibliography and the en-US locale", () => {
    expect(BUNDLED_STYLES.map((s) => s.id)).toEqual(["apa", "ieee", "chicago-note-bibliography"]);
    expect(localeXml("locales-en-US")).toContain("<locale");
    expect(localeXml("fr-FR")).toBeUndefined();
  });

  it("generated.ts matches the canonical .csl files (drift gate)", () => {
    const generated = readFileSync(join(stylesDir, "generated.ts"), "utf8");
    expect(buildStylesModule(stylesDir)).toBe(generated);
  });

  it("resolves bundled styles and rejects malformed ids without touching the fs", () => {
    expect(resolveStyleXml("apa")).toContain("<style");
    expect(resolveStyleXml("../../etc/passwd")).toBeUndefined();
    expect(resolveStyleXml("no-such-style")).toBeUndefined();
  });

  it("lists user-supplied .csl from --styles-dir after the bundled ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "notees-styles-"));
    writeFileSync(join(dir, "my-style.csl"), "<style xmlns='http://purl.org/net/xbiblio/csl'/>");
    const styles = listStyles(dir);
    expect(styles.map((s) => s.id)).toEqual(["apa", "ieee", "chicago-note-bibliography", "my-style"]);
  });
});
```

- [ ] Implement `src/serve/styles.ts`:

```ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { BUNDLED_LOCALE_XML, BUNDLED_STYLE_XML } from "./styles/generated.js";

export interface StyleEntry {
  id: string;
  label: string;
}

export const BUNDLED_STYLES: readonly StyleEntry[] = [
  { id: "apa", label: "APA (7th edition)" },
  { id: "ieee", label: "IEEE" },
  { id: "chicago-note-bibliography", label: "Chicago (notes & bibliography)" },
];

// Style ids are also file names in --styles-dir — the strict shape blocks
// traversal (resolveStyleXml can never read outside the styles dir).
const STYLE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export function resolveStyleXml(styleId: string, stylesDir?: string): string | undefined {
  if (!STYLE_ID_PATTERN.test(styleId)) return undefined;
  const bundled = (BUNDLED_STYLE_XML as Record<string, string>)[styleId];
  if (bundled !== undefined) return bundled;
  if (stylesDir !== undefined) {
    const path = join(stylesDir, `${styleId}.csl`);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return undefined;
}

export function listStyles(stylesDir?: string): StyleEntry[] {
  const extra: StyleEntry[] = [];
  if (stylesDir !== undefined && existsSync(stylesDir)) {
    for (const file of readdirSync(stylesDir).sort()) {
      if (!file.endsWith(".csl")) continue;
      const id = file.slice(0, -".csl".length);
      if (!STYLE_ID_PATTERN.test(id) || BUNDLED_STYLES.some((style) => style.id === id)) continue;
      extra.push({ id, label: id });
    }
  }
  return [...BUNDLED_STYLES, ...extra];
}

export function localeXml(lang: string): string | undefined {
  return (BUNDLED_LOCALE_XML as Record<string, string>)[lang];
}
```

- [ ] Write the ambient declaration — `src/serve/citeproc.d.ts`:

```ts
/**
 * Minimal ambient surface of the `citeproc` package (citeproc-js ships no
 * TypeScript types). Only what the bridge uses is declared.
 */
declare module "citeproc" {
  export interface CitationItem {
    id: string;
    locator?: string;
    label?: string;
  }
  export class Engine {
    constructor(
      sys: {
        retrieveLocale(lang: string): string | undefined;
        retrieveItem(id: string): unknown;
      },
      styleXml: string,
      lang?: string,
    );
    updateItems(ids: string[]): void;
    /** Returns [[ [position, renderedText, citationId] ]] for the appended cluster. */
    appendCitationCluster(
      citation: { citationItems: CitationItem[]; properties: Record<string, unknown> },
      forceSort?: boolean,
    ): Array<Array<[number, string, string]>>;
    /** Returns [meta, renderedEntries]. */
    makeBibliography(): [Record<string, unknown>, string[]];
  }
}
```

- [ ] Write the failing renderer tests (in `test/serve.test.ts`, plus a
      pure unit test in `test/serve-cite.test.ts` for the error arms):

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CslItem } from "@notees/export";

import { createCiteRenderer } from "../src/serve/cite.js";

const ITEM: CslItem = {
  id: "doe2020test",
  type: "book",
  title: "The Test Book",
  author: [{ family: "Doe", given: "Jane" }],
  issued: { "date-parts": [[2020]] },
};

describe("createCiteRenderer", () => {
  it("renders an apa in-text citation", () => {
    const out = createCiteRenderer().renderCitation([ITEM], "apa");
    expect(typeof out).toBe("string");
    expect(out as string).toContain("Doe");
    expect(out as string).toContain("2020");
  });

  it("includes the locator when given", () => {
    const out = createCiteRenderer().renderCitation([ITEM], "apa", "23") as string;
    expect(out).toContain("23");
  });

  it("renders an apa bibliography entry", () => {
    const out = createCiteRenderer().renderBibliography([ITEM], "apa") as string;
    expect(out).toContain("Doe, J.");
    expect(out).toContain("The Test Book");
  });

  it("answers not_found for an unknown style id", () => {
    expect(createCiteRenderer().renderBibliography([ITEM], "no-such-style")).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("answers render_failed when citeproc throws (corrupt user style)", () => {
    const dir = mkdtempSync(join(tmpdir(), "notees-styles-"));
    writeFileSync(join(dir, "broken.csl"), "<style>not valid csl</style>");
    const out = createCiteRenderer(dir).renderBibliography([ITEM], "broken");
    expect(out).toMatchObject({ ok: false, error: { code: "render_failed" } });
    // …and the renderer stays usable afterwards (per-request engine).
    expect(createCiteRenderer().renderBibliography([ITEM], "apa")).not.toMatchObject({ ok: false });
  });
});
```

- [ ] Implement `src/serve/cite.ts` — the `CiteRenderer` interface and
      `createCiteRenderer` signature already exist from the Task 4 stub;
      replace the stub body with the real implementation (the unit tests
      below pin the behavior):

```ts
import { createRequire } from "node:module";

import type { CslItem } from "@notees/export";

import { serveError, type ServeErrorBody } from "./protocol.js";
import { localeXml, resolveStyleXml } from "./styles.js";

// citeproc-js is CommonJS and ships no ESM entry; the release bundle's
// createRequire banner (tsup.config.ts) and Node's native createRequire
// both serve this equally.
const require = createRequire(import.meta.url);
const { Engine } = require("citeproc") as typeof import("citeproc");

export interface CiteRenderer {
  /** Raw citeproc cluster string — light markup (<i>, <b>) included. */
  renderCitation(items: CslItem[], styleId: string, locator?: string): string | ServeErrorBody;
  /** Raw citeproc bibliography entries, newline-joined. */
  renderBibliography(items: CslItem[], styleId: string): string | ServeErrorBody;
}

export function createCiteRenderer(stylesDir?: string): CiteRenderer {
  /**
   * One engine per render: engines carry mutable registry state
   * (updateItems/appendCitationCluster), so sharing one across requests —
   * or across concurrent requests — would leak state between documents.
   * A failing engine dies with its request: render_failed, bridge unaffected.
   */
  function withEngine<T>(styleId: string, items: CslItem[], render: (engine: InstanceType<typeof Engine>) => T): string | ServeErrorBody | T {
    const xml = resolveStyleXml(styleId, stylesDir);
    if (xml === undefined) return serveError("not_found", `unknown style "${styleId}"`);
    try {
      const byId = new Map(items.map((item) => [item.id, item]));
      const engine = new Engine(
        {
          retrieveLocale: (lang: string): string | undefined => localeXml(lang),
          retrieveItem: (id: string): unknown => byId.get(id),
        },
        xml,
        "en-US",
      );
      return render(engine);
    } catch (error) {
      return serveError("render_failed", error instanceof Error ? error.message : String(error));
    }
  }

  return {
    renderCitation(items, styleId, locator) {
      return withEngine(styleId, items, (engine) => {
        const clusters = engine.appendCitationCluster(
          {
            citationItems: items.map((item) => ({
              id: item.id,
              ...(locator !== undefined && locator.length > 0 ? { locator, label: "page" } : {}),
            })),
            properties: {},
          },
          true,
        );
        return clusters.map((cluster) => cluster.map(([, text]) => text).join("")).join("; ");
      });
    },
    renderBibliography(items, styleId) {
      return withEngine(styleId, items, (engine) => {
        engine.updateItems(items.map((item) => item.id));
        const [, entries] = engine.makeBibliography();
        return entries.join("\n");
      });
    },
  };
}
```

- [ ] `pnpm bundle:styles && pnpm test -- test/serve-styles.test.ts test/serve-cite.test.ts test/serve.test.ts && pnpm typecheck` — green.

### Task 7: `render-citation`

**Files**
- Modify: `src/serve/document.ts` (real render arms)
- Modify: `test/serve.test.ts`

**Interfaces**

Consumes: `cslItemFor` (Task 5), `CiteRenderer.renderCitation` (Task 6),
`BridgeSession.local`.

Produces: the frozen response `{ ok: true, citation: string }` /
`{ ok: false, error: { code: "not_found" | "render_failed", … } }`.

**Steps**

- [ ] Write the failing end-to-end tests — append to `test/serve.test.ts`:

```ts
describe("render-citation", () => {
  it("renders an apa in-text citation for a seeded source", async () => {
    const res = await call({ cmd: "render-citation", objectIds: [duneId], styleId: "apa" });
    expect(res.status).toBe(200);
    if (!res.body.ok || !("citation" in res.body)) throw new Error(JSON.stringify(res.body));
    expect(res.body.citation).toContain("Herbert");
    expect(res.body.citation).toContain("1965");
  });

  it("renders a locator into the citation", async () => {
    const res = await call({ cmd: "render-citation", objectIds: [duneId], styleId: "apa", locator: "42" });
    if (!res.body.ok || !("citation" in res.body)) throw new Error(JSON.stringify(res.body));
    expect(res.body.citation).toContain("42");
  });

  it("renders a multi-source cluster", async () => {
    const res = await call({ cmd: "render-citation", objectIds: [duneId, articleId], styleId: "apa" });
    if (!res.body.ok || !("citation" in res.body)) throw new Error(JSON.stringify(res.body));
    expect(res.body.citation).toContain("Herbert");
    expect(res.body.citation).toContain("Atreides");
  });

  it("renders a citekey-less source via the node-id fallback", async () => {
    const res = await call({ cmd: "render-citation", objectIds: [articleId], styleId: "apa" });
    expect(res.status).toBe(200);
  });

  it("answers not_found for an unknown object id or unknown style", async () => {
    const unknownId = await call({
      cmd: "render-citation",
      objectIds: ["00000000-0000-0000-0000-00000000dead"],
      styleId: "apa",
    });
    expect(unknownId.status).toBe(404);
    expect(unknownId.body).toMatchObject({ ok: false, error: { code: "not_found" } });

    const unknownStyle = await call({ cmd: "render-citation", objectIds: [duneId], styleId: "vancouver" });
    expect(unknownStyle.status).toBe(404);
    expect(unknownStyle.body).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
```

- [ ] Implement the render arms in `src/serve/document.ts`:

```ts
case "render-citation":
case "render-bibliography": {
  const items: CslItem[] = [];
  for (const id of request.objectIds) {
    const item = cslItemFor(context.session.local, id);
    // Missing id OR a node that is not a source — both are not_found so the
    // add-in can tell "bad id" from "render broke".
    if (item === undefined) return serveError("not_found", `no source object ${id}`);
    items.push(item);
  }
  if (request.cmd === "render-citation") {
    const citation = context.renderer.renderCitation(items, request.styleId, request.locator);
    return typeof citation === "string" ? { ok: true, citation } : citation;
  }
  const bibliography = context.renderer.renderBibliography(items, request.styleId);
  return typeof bibliography === "string" ? { ok: true, bibliography } : bibliography;
}
```

- [ ] `pnpm test -- test/serve.test.ts && pnpm typecheck` — green.

### Task 8: `render-bibliography` + list-styles end-to-end

**Files**
- Modify: `test/serve.test.ts` only (both arms already implemented in Tasks 6/7)

**Interfaces**

Produces: `{ ok: true, bibliography: string }`,
`{ ok: true, styles: [{ id, label }] }`.

**Steps**

- [ ] Write the failing end-to-end tests — append to `test/serve.test.ts`:

```ts
describe("render-bibliography", () => {
  it("renders an apa bibliography across source classes", async () => {
    const res = await call({ cmd: "render-bibliography", objectIds: [duneId, articleId], styleId: "apa" });
    expect(res.status).toBe(200);
    if (!res.body.ok || !("bibliography" in res.body)) throw new Error(JSON.stringify(res.body));
    expect(res.body.bibliography).toContain("Herbert, F.");
    expect(res.body.bibliography).toContain("Dune");
    expect(res.body.bibliography).toContain("Atreides, P.");
  });

  it("renders the bundled styles end-to-end (ieee + chicago smoke)", async () => {
    const ieee = await call({ cmd: "render-bibliography", objectIds: [duneId], styleId: "ieee" });
    if (!ieee.body.ok || !("bibliography" in ieee.body)) throw new Error(JSON.stringify(ieee.body));
    expect(ieee.body.bibliography).toContain("Dune");

    const chicago = await call({ cmd: "render-bibliography", objectIds: [duneId], styleId: "chicago-note-bibliography" });
    if (!chicago.body.ok || !("bibliography" in chicago.body)) throw new Error(JSON.stringify(chicago.body));
    expect(chicago.body.bibliography).toContain("Herbert");
  });

  it("answers not_found for a non-source object id", async () => {
    const res = await call({ cmd: "render-bibliography", objectIds: [plainPageId], styleId: "apa" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("list-styles", () => {
  it("lists the bundled styles", async () => {
    const res = await call({ cmd: "list-styles" });
    expect(res.body).toEqual({
      ok: true,
      styles: [
        { id: "apa", label: "APA (7th edition)" },
        { id: "ieee", label: "IEEE" },
        { id: "chicago-note-bibliography", label: "Chicago (notes & bibliography)" },
      ],
    });
  });
});
```

- [ ] Run green; no implementation changes expected — if any assertion fails,
      fix the producing module, not the test, unless the contract itself is
      wrong (then stop and re-open the contract with the add-in lane).
- [ ] `pnpm test -- test/serve.test.ts && pnpm typecheck` — green.

### Task 9: hardening — error envelopes, concurrency, security pins

**Files**
- Modify: `test/serve.test.ts` (concurrency + full-envelope sweep)
- Modify: `src/serve/server.ts` / `src/serve/document.ts` / `src/serve/session.ts`
  — only if a pin below goes red

**Interfaces**

No new surfaces. This task is the Review Focus sweep made executable.

**Steps**

- [ ] Write the failing hardening tests — append to `test/serve.test.ts`:

```ts
describe("hardening", () => {
  it("serves 24 concurrent mixed requests, all well-formed", async () => {
    const bodies = [
      { cmd: "search", query: "Dune" },
      { cmd: "list-styles" },
      { cmd: "render-citation", objectIds: [duneId], styleId: "apa" },
      { cmd: "render-bibliography", objectIds: [duneId, articleId], styleId: "apa" },
    ];
    const responses = await Promise.all(
      Array.from({ length: 24 }, (_, i) => call(bodies[i % bodies.length]!)),
    );
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    }
    // And a follow-up after the burst still works (no wedged state).
    const after = await call({ cmd: "search", query: "Dune" });
    expect(after.body).toMatchObject({ ok: true });
  });

  it("answers every wire error shape with its pinned HTTP status", async () => {
    const cases: Array<[unknown, number, string]> = [
      [{ cmd: "nope" }, 400, "unknown_cmd"],
      [{ cmd: "search" }, 400, "bad_request"],
      [{ cmd: "render-citation", objectIds: [], styleId: "apa" }, 400, "bad_request"],
      [{ cmd: "render-citation", objectIds: [duneId], styleId: "../traversal" }, 404, "not_found"],
      [{ cmd: "render-citation", objectIds: ["00000000-0000-0000-0000-00000000dead"], styleId: "apa" }, 404, "not_found"],
    ];
    for (const [body, status, code] of cases) {
      const res = await call(body);
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ ok: false, error: { code } });
    }
  });

  it("serves from the last synced store when the server goes dark (offline-first)", async () => {
    // Close the first session (releases the lock), then open against a
    // dead port with the SAME store dir — search must still answer.
    const workspaceId = "00000000-0000-0000-0000-000000000001";
    session.close();
    const offline = await openBridgeSession({
      server: "http://127.0.0.1:1", // nothing listens here
      apiKey: API_KEY,
      workspaceId,
      storeDir: join(dirname(harness.stateFile), "stores"),
      statePath: harness.stateFile,
      stateKey: `default:${harness.baseUrl}`,
      syncIntervalMs: 3_600_000,
      onWarning: (message) => warnings.push(message),
    });
    try {
      const results = offline.searchSources("Dune");
      expect(results.some((r) => r.title === "Dune")).toBe(true);
      expect(warnings.some((w) => w.includes("initial sync failed"))).toBe(true);
    } finally {
      offline.close();
    }
    // Re-open the primary session for any later tests (same options as the
    // beforeAll hook, so the lock and the store dir line up exactly).
    session = await openBridgeSession({
      server: harness.baseUrl,
      apiKey: API_KEY,
      workspaceId: defaultWorkspaceId,
      storeDir: join(dirname(harness.stateFile), "stores"),
      statePath: harness.stateFile,
      stateKey: `default:${harness.baseUrl}`,
      syncIntervalMs: 3_600_000,
      onWarning: (message) => warnings.push(message),
    });
  });
});
```

(The offline test closes/reopens the shared session — order it after the
other describes or give it its own store dir; keep the suite deterministic.)

- [ ] Fix whatever goes red — expected candidates: the traversal id (regex
      guards it), offline reopen (the store path must match the first
      session's), warning text match. Do NOT loosen a pin to go green.
- [ ] Full gate: `pnpm typecheck && pnpm test` — all green.

### Task 10: docs — README, help text, CHANGELOG

**Files**
- Modify: `README.md` (a `notees serve` section: what it is, the pairing
  flow, the flags, the security model, a short protocol reference)
- Modify: `src/cli.ts` help text polish (the `serve` description + option
  strings — done incrementally in Task 1; verify against final behavior)
- Modify: `CHANGELOG.md` (newest-first entry)
- Modify: `AGENTS.md` — only if the guidance changed (it didn't: no new law);
      do NOT append history there

**Interfaces**

No code surfaces. The README section is the operator-facing contract:
loopback-only, token pairing, offline-first behavior, the lock conflict, the
`--styles-dir` escape hatch, and a pointer that the Word add-in consumes the
`/document` protocol.

**Steps**

- [ ] README section (shape):

```markdown
## `notees serve` — the localhost citation bridge

`notees serve` runs a small HTTP server on `127.0.0.1` so the Notees Word
add-in can search your synced store and render citations/bibliographies
while you work — the Zotero connector architecture (Word add-in ↔
localhost bridge). The add-in never talks to the network; sync is the
bridge's problem, and Word citations keep working with no connectivity.

    notees serve [--port 8474] [--origin <add-in origin> …]
                 [--token-file <path>] [--sync-interval 60] [--styles-dir <dir>]

- **Loopback only.** The bind is `127.0.0.1`; there is no `--host` flag.
- **Pairing.** The first connect needs a bearer token: a fresh one is
  printed at startup (or pin it with `NOTEES_SERVE_TOKEN`, or write it
  for the add-in with `--token-file`). Browser requests must carry an
  `Origin` header matching `--origin`.
- **Protocol.** `POST /document` with `{cmd: "search" | "render-citation" |
  "render-bibliography" | "list-styles", …}` — see the Word add-in docs.
- **One bridge per store.** A second `notees serve` on the same workspace
  store exits 4 (conflict) — the derived store is single-writer.
- **Styles.** APA, IEEE, and Chicago (notes & bibliography) are bundled;
  drop additional `.csl` files in a `--styles-dir`.
```

- [ ] CHANGELOG entry (newest first, matching the house shape — one bullet,
      **bold lead**, Files + Verification sub-lines):

```markdown
## 2026-11-08

- **feat: `notees serve` — the localhost citation bridge for the Word
  add-in (search + CSL citation/bibliography renders over the local derived
  store).** A long-running `node:http` server bound to 127.0.0.1 only (no
  `--host` flag exists), speaking one JSON endpoint — `POST /document` with
  `search` / `render-citation` / `render-bibliography` / `list-styles` — so
  the Office.js task pane can cite the synced store offline (the Zotero
  connector architecture: the add-in holds no credentials and never touches
  the network). First-connect pairing is a bearer token printed at startup
  (env-pinnable via `NOTEES_SERVE_TOKEN`, writable via `--token-file`);
  browser origins must match the repeatable `--origin` allow-list. Renders
  ride the new `citeproc` dependency (citeproc-js, compiled into the
  release bundle) over CSL-JSON projected by `@notees/export`'s existing
  `nodeToCsl` — the source-node mapping is reused, not duplicated — with
  apa/ieee/chicago-note-bibliography styles and the en-US locale vendored as
  XML and inlined through a generated module (the single-file release has no
  asset directory); `--styles-dir` adds user-supplied .csl files. One
  `LocalWorkspace` stays open for the server's lifetime with a background
  sync interval; a failed initial sync still serves the last synced store
  (offline-first), and a second bridge on the same store exits 4 on the
  pid-checked serve lock. Every failure answers the `{ok: false, error:
  {code, message}}` envelope (unknown_cmd / not_found / render_failed /
  bad_request) — request handling performs no network I/O.
  - Files: `src/serve/{config,protocol,server,session,document,cite,csl-items,styles}.ts`,
    `src/serve/citeproc.d.ts`, `src/serve/styles/*` (vendored CSL + generated.ts),
    `scripts/bundle-styles.mts`, `src/cli.ts` (the command), `src/local-workspace.ts`
    (best-effort sync option), `test/serve*.test.ts`, `package.json` (+ `citeproc`),
    `tsup.config.ts`, `README.md`, `NOTICE`.
  - Verification: `pnpm typecheck && pnpm test` — all green (N tests).
```

- [ ] Verify the help overview: `pnpm dev -- help` lists `serve` with its
      row (HELP_ROWS fail-loud check), and `pnpm dev -- serve --help` reads
      correctly.
- [ ] Final full gate from the repo root: `pnpm typecheck && pnpm test` —
      all green. Then commit (per-file staging, Conventional Commits,
      e.g. `feat(cli): notees serve — localhost citation bridge for the
      Word add-in`) and push.

---

## Decisions log

- **citeproc choice:** `citeproc` (citeproc-js `^2.4.63`) — the spec's
  flagged open question. It is the only mature CSL 1.0.1 processor that is
  pure JS, CommonJS (matches the repo's tsup `noExternal` + createRequire
  banner story), maintenance-active, and fully offline once styles/locales
  are vendored. A "lighter" renderer would mean writing a CSL engine.
- **No HTTP framework:** raw `node:http`. No framework exists in the repo,
  the surface is one endpoint, and the release bundle constraint makes
  every dependency deliberate.
- **Bundled styles:** apa, ieee, chicago-note-bibliography (the spec's
  list) + `locales-en-US.xml`, vendored as XML, inlined via a generated TS
  module with a drift-gate test (the single-file release ships no assets).
  chicago-note-bibliography is a note style — its `citation` output is note
  text; documented for the add-in lane.
- **CSL-JSON reuse:** `nodeToCsl` from `@notees/export` (via `csl-items.ts`
  resolving its caller-side lookups) — zero mapping duplication.
- **Auth/origin failures use `bad_request` codes** with 401/403 HTTP
  statuses, keeping the wire vocabulary to the normative four.
- **Search executes through `@notees/query`** (`LocalWorkspace.runQueryAst`
  with a QueryAST v2: `member` class-in-[source + the full roster via
  `SOURCE_CLASS_IDS`] + `content fts` over the local derived store) — the
  normative interface. Keystroke tokens are quoted so the FTS MATCH grammar
  can never break; an unparseable query answers `[]`, never a 500.
- **Default port 8474** (localhost only; the sync server uses 8377 — no
  collision).

## Risks / follow-ups

- citeproc-js's exact `appendCitationCluster`/`makeBibliography` return
  shapes are pinned by the ambient declaration and the Task 6 unit tests;
  a major-version bump of `citeproc` must re-run them.
- CSL styles/locales are CC BY-SA 3.0 — attribution added to `NOTICE`;
  refreshing them means re-running `pnpm bundle:styles`.
- The Word add-in lane implements against the frozen wire contract in this
  plan; any change must be negotiated across both lanes.
- `notees serve` holds one better-sqlite3 connection per workspace store;
  the serve lock makes double-starts loud (exit 4) rather than corrupting
  the projection.
- The vendored AGENTS.md note: nothing under `vendor/` was touched; if
  `nodeToCsl` ever needs a fix, it lands in `notees-sync` (fixture gate)
  and arrives via a pin bump.
