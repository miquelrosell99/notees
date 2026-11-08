# Word add-in (`notees-word`) — Office.js task pane for live citations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

A new greenfield repo at `/root/projects/notees-word`: an Office.js Word task-pane add-in that lets a Notees user search their workspace, insert live citations as Word fields, refresh them, and generate a bibliography — talking **only** to the `notees serve` CLI bridge on `http://127.0.0.1:<port>`. The built output is plain statics served by the Notees sync server under `/word/` (sibling lane) and sideloaded via a shared-folder catalog (desktop) or the M365 admin center (Word for the web).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Word (desktop / web)                                     │
│  task pane  ← statics from https://<host>/word/          │
│     │                                                    │
│     ├─ settings (localStorage: port, pairing token)      │
│     ├─ bridge client ──HTTP──▶ http://127.0.0.1:<port>  │
│     │        (ONLY egress; never the sync server)        │
│     └─ document adapter (Word.run / OOXML)               │
│            citations + bibliography as ADDIN fields      │
└─────────────────────────────────────────────────────────┘
              ▲                        │
   manifest.xml (sideloaded)    notees serve bridge
                                (notees-cli lane; search,
                                 render-citation, render-bibliography,
                                 list-styles)
```

Layering inside the add-in (strict one-way deps):

- `src/bridge/` — typed fetch client for the bridge protocol. Pure, injectable `fetch`.
- `src/settings/` — port + token persistence. Pure interface over a key-value store (localStorage in the pane, in-memory in tests).
- `src/citation/` — pure logic: field-embed JSON build/parse, OOXML field-fragment generation, OOXML field scanning, citation-collection (bibliography input), CSL style id handling. **All of this is vitest-unit-tested** — no `Word` global needed.
- `src/word/` — thin Office.js adapter: `insertOoxml` for fields, `body.fields` scan, `getOoxml` fallback, document-open handling. Not unit-tested against a real Word; covered by a manual smoke checklist.
- `src/ui/` — React task pane (plain CSS, no design-system dependency — this is a standalone repo, not `apps/web`; the RosellRamos kit binding law does not apply here).

## Tech Stack

- **Vite + React 18 + TypeScript**, vitest for tests. Plain CSS.
- **Office.js loaded as a vendored script**: `office.js` is a script-tag global, **not** an importable module. We copy the dist file from the `@microsoft/office-js` npm package into the build output (`dist/lib/office.js`) and reference it relatively — no CDN dependency, consistent with the local-first design (the pane must work offline; the CDN is the one external runtime dependency we refuse).
- **Manifest**: classic **XML** manifest (add-in-only manifest). Decided against the unified manifest for Microsoft 365: add-ins using it are [not supported when published to a network share](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/create-a-network-shared-folder-catalog-for-task-pane-and-content-add-ins) — and the shared-folder catalog is our primary sideload path for desktop Word. The XML manifest works for both the shared-folder catalog and the M365 admin center (Word for the web).
- **Field insertion**: `range.insertOoxml(ooxml, Word.InsertLocation.replace)` with a `<w:fldSimple>` fragment. Decided **against** `Word.FieldType.addin` + `field.data` (WordApi 1.5): its serialization doesn't let us control the literal field code `ADDIN notees.Citation …`, which is the normative wire-visible shape (Zotero's `ADDIN ZOTERO_ITEM` pattern adapted). `insertOoxml` is WordApi 1.1, so insertion works broadly. Field scanning uses `body.fields` (WordApi 1.5) when available, with a `getOoxml()`-parse fallback (WordApi 1.1) for hosts without field support. Manifest declares `WordApi 1.5`.
- Build output layout (served at any base path, here `/word/`): `index.html`, `manifest.xml`, `lib/office.js`, `assets/*`. Vite `base: './'` for relative asset URLs — no server-side routing assumptions.

## Spec

`/root/projects/notees-web/docs/superpowers/specs/2026-11-08-citation-capture-integrations-design.md` (section "Word add-in (`notees-word`, Office.js)").

## Global Constraints

- **The add-in calls ONLY `http://127.0.0.1:<port>` (the CLI bridge).** It never talks to the Notees sync server, holds no server credentials, and makes no assumptions about where its own statics are hosted (any base path; vite `base: './'`).
- **Normative field shapes** (exact):
  - Citation field code: `ADDIN notees.Citation ` + JSON embed `{"citationId","nodeIds","styleId","locator"?}`; displayed result = rendered citation text from the bridge.
  - Bibliography field code: `ADDIN notees.Bibliography ` + JSON embed `{"styleId"}`.
- **Bridge protocol shapes are normative** (see Interfaces in each task): `search`, `render-citation`, `render-bibliography`, `list-styles`; success `{ ok: true, … }`; error `{ ok: false, error: { code, message } }`; auth header `Authorization: Bearer <pairing-token>`.
- Offline-first: Word citations work without connectivity — if the bridge is unreachable, the pane shows a clear "bridge offline" state and every field keeps its last rendered text.
- **Test command**: `pnpm test` (vitest, run from `/root/projects/notees-word`).
- **Conventional Commits**: `feat(word): …`, `fix(word): …` etc., per-file staging, one commit per finished task.
- Built output must be plain statics servable at any base path — relative URLs only.

## Review Focus

1. **Bridge offline when Word opens** — the pane must render, show a recoverable "not connected" state, retry on demand (and lazily on first user action), and must never throw uncaught. All field text stays intact.
2. **Document containing fields from another machine/user** (unknown `nodeIds`) — refresh must skip-not-corrupt: fields whose embed fails to parse or whose ids the bridge cannot render keep their existing text; the pane reports "N citations couldn't be refreshed" instead of blanking them.
3. **Citation style switched after insertion** — inserting with a new `styleId` must not silently rewrite existing fields; Refresh re-renders each field **with the `styleId` stored in its own embed**, and the style picker offers "Refresh all with this style" as an explicit second action.
4. **Field embed JSON corrupted by user edit** — the parser must tolerate partial/garbage codes: anything not matching the exact `ADDIN notees.Citation ` prefix + parseable JSON is treated as a foreign field and left untouched (never deleted, never re-rendered).
5. **Word for the web vs desktop API gaps** — field *scanning* falls back to OOXML parsing when `body.fields` is unavailable; insertion via `insertOoxml` (1.1) is the primary path and is validated per-host in the manual smoke checklist. Any host capability miss degrades to a visible message, not a broken document.

---

### Task 1: Repo scaffold — Vite + React + TS, build emits `/word/`-servable statics

**Files**
- Create: `/root/projects/notees-word/package.json`
- Create: `/root/projects/notees-word/vite.config.ts`
- Create: `/root/projects/notees-word/tsconfig.json`
- Create: `/root/projects/notees-word/index.html`
- Create: `/root/projects/notees-word/src/main.tsx`
- Create: `/root/projects/notees-word/src/ui/app.tsx` (placeholder shell)

**Interfaces**
- Produces: `pnpm build` → `dist/index.html`, `dist/assets/*` with **relative** asset URLs (vite `base: './'`).
- Produces: `pnpm test` → vitest run (0 tests yet is fine; must exit 0).
- Consumes: nothing.

**Steps**

- [ ] Write `package.json`:

```json
{
  "name": "notees-word",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build && node scripts/copy-office-js.mjs && node scripts/copy-manifest.mjs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@microsoft/office-js": "^1.1.98",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "typescript": "^5.6.3",
    "vite": "^5.4.10",
    "vitest": "^2.1.4"
  }
}
```

- [ ] Write `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    rollupOptions: {
      // office.js is vendored as a static file (scripts/copy-office-js.mjs),
      // never bundled.
      external: [],
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
```

- [ ] Add `"@vitejs/plugin-react": "^4.3.3"` to devDependencies (same file as above — keep one source of truth, listed here so it isn't missed).
- [ ] Write `tsconfig.json`: `target: ES2022`, `module: ESNext`, `moduleResolution: "bundler"`, `strict: true`, `jsx: react-jsx`, `lib: ["ES2022", "DOM"]`, `types: ["@microsoft/office-js"]` (gives the global `Word`/`Office` typings without importing).
- [ ] Write `index.html` (note the **relative** office.js path and `Office.onReady` before render):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Notees</title>
    <script src="./lib/office.js"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

- [ ] Write `src/main.tsx`:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/app";

Office.onReady(() => {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
```

- [ ] Write `src/ui/app.tsx` (placeholder until Task 4 wires it up):

```tsx
export function App() {
  return <main data-testid="app-shell">Notees</main>;
}
```

- [ ] Write `scripts/copy-office-js.mjs` (vendored office.js — no CDN at runtime):

```js
import { mkdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const src = require.resolve("@microsoft/office-js/package.json");
const { dirname, join } = await import("node:path");
const distDir = join(dirname(src), "dist");
mkdirSync("dist/lib", { recursive: true });
copyFileSync(join(distDir, "office.js"), "dist/lib/office.js");
console.log("vendored office.js");
```

- [ ] Verify: `pnpm install && pnpm typecheck && pnpm build && pnpm test` all exit 0, and `grep -o 'src="./assets' dist/index.html` returns a match (relative URL proof).
- [ ] Commit: `feat(word): scaffold vite react task pane with vendored office.js`

### Task 2: Bridge client — typed fetch wrapper for the CLI bridge

**Files**
- Create: `/root/projects/notees-word/src/bridge/client.ts`
- Create: `/root/projects/notees-word/src/bridge/types.ts`
- Test: `/root/projects/notees-word/test/bridge-client.test.ts`

**Interfaces**
- Consumes: `fetch` (injectable); base URL `http://127.0.0.1:<port>`; header `Authorization: Bearer <token>`.
- Produces (exact bridge shapes):

```ts
export type BridgeResult = { objectId: string; title: string; citekey?: string;
  authors?: string[]; year?: number | string; classKey: string };

export type BridgeError = { code: string; message: string };
export type BridgeResponse<T> = { ok: true } & T | { ok: false; error: BridgeError };

export interface Bridge {
  search(query: string): Promise<BridgeResponse<{ results: BridgeResult[] }>>;
  renderCitation(objectIds: string[], styleId: string, locator?: string):
    Promise<BridgeResponse<{ citation: string }>>;
  renderBibliography(objectIds: string[], styleId: string):
    Promise<BridgeResponse<{ bibliography: string }>>;
  listStyles(): Promise<BridgeResponse<{ styles: { id: string; label: string }[] }>>;
}
```

- Produces error taxonomy: `BridgeOfflineError` (fetch rejected / non-JSON), `BridgeErrorResponse` (`ok:false` with `code`/`message`), `BridgeShapeError` (200 but missing expected keys).

**Steps**

- [ ] Write `src/bridge/types.ts` exactly as above.
- [ ] Write `src/bridge/client.ts`:

```ts
import type { Bridge, BridgeError, BridgeResponse } from "./types";

export class BridgeOfflineError extends Error {
  readonly kind = "offline" as const;
  constructor(cause: unknown) {
    super(`Notees bridge unreachable: ${String(cause)}`);
    this.name = "BridgeOfflineError";
  }
}
export class BridgeErrorResponse extends Error {
  readonly kind = "error" as const;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BridgeErrorResponse";
  }
}
export class BridgeShapeError extends Error {
  readonly kind = "shape" as const;
  constructor(readonly detail: string) {
    super(`Bridge returned unexpected payload: ${detail}`);
    this.name = "BridgeShapeError";
  }
}

const TIMEOUT_MS = 5_000;

export function createBridge(opts: {
  port: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Bridge {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `http://127.0.0.1:${opts.port}`;

  async function call<T extends Record<string, unknown>>(
    cmd: string,
    body: Record<string, unknown>,
    requireKeys: (keyof T)[]
  ): Promise<BridgeResponse<T>> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/document`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({ cmd, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new BridgeOfflineError(e);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new BridgeOfflineError(new Error(`HTTP ${res.status}, non-JSON body`));
    }
    if (typeof json !== "object" || json === null || !("ok" in json)) {
      throw new BridgeShapeError("missing ok flag");
    }
    if (json.ok === false) {
      const err = (json as { error?: Partial<BridgeError> }).error ?? {};
      return { ok: false, error: { code: String(err.code ?? "unknown"), message: String(err.message ?? "unknown error") } };
    }
    for (const k of requireKeys) {
      if (!(k in json)) throw new BridgeShapeError(`missing key ${String(k)}`);
    }
    return json as BridgeResponse<T>;
  }

  return {
    search: (query) =>
      call("search", { query }, ["results"]).then(r =>
        r.ok && !Array.isArray(r.results) ? { ok: false, error: { code: "shape", message: "results not an array" } } : r),
    renderCitation: (objectIds, styleId, locator) =>
      call("render-citation", { objectIds, styleId, ...(locator ? { locator } : {}) }, ["citation"]),
    renderBibliography: (objectIds, styleId) =>
      call("render-bibliography", { objectIds, styleId }, ["bibliography"]),
    listStyles: () => call("list-styles", {}, ["styles"]),
  };
}
```

- [ ] Write `test/bridge-client.test.ts` with a stub `fetchImpl`:

```ts
import { describe, expect, it } from "vitest";
import { createBridge, BridgeOfflineError } from "../src/bridge/client";

function stubFetch(handler: (url: string, init: RequestInit) => unknown): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const body = handler(String(url), init ?? {});
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("createBridge", () => {
  it("posts to /document with cmd, bearer token, and merged body", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const b = createBridge({ port: 8474, token: "tok", fetchImpl: stubFetch((url, init) => {
      seen = { url, init };
      return { ok: true, citation: "(Doe 2024)" };
    }) });
    const r = await b.renderCitation(["n1"], "apa", "p. 3");
    expect(r).toEqual({ ok: true, citation: "(Doe 2024)" });
    expect(seen!.url).toBe("http://127.0.0.1:8474/document");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ cmd: "render-citation", objectIds: ["n1"], styleId: "apa", locator: "p. 3" });
  });

  it("omits locator when undefined", async () => {
    let body: Record<string, unknown> = {};
    const b = createBridge({ port: 1, token: "t", fetchImpl: stubFetch((_u, init) => {
      body = JSON.parse(init.body as string);
      return { ok: true, citation: "x" };
    }) });
    await b.renderCitation(["n1"], "apa");
    expect(body).not.toHaveProperty("locator");
  });

  it("returns ok:false with code and message from an error envelope", async () => {
    const b = createBridge({ port: 1, token: "t", fetchImpl: stubFetch(() => ({ ok: false, error: { code: "unknown_style", message: "no such style" } })) });
    const r = await b.search("doe");
    expect(r).toEqual({ ok: false, error: { code: "unknown_style", message: "no such style" } });
  });

  it("throws BridgeOfflineError on connection refusal", async () => {
    const b = createBridge({ port: 1, token: "t", fetchImpl: stubFetch(() => new Error("ECONNREFUSED")) });
    await expect(b.search("x")).rejects.toBeInstanceOf(BridgeOfflineError);
  });

  it("maps search results to the normative result shape", async () => {
    const b = createBridge({ port: 1, token: "t", fetchImpl: stubFetch(() => ({ ok: true, results: [{ objectId: "n1", title: "Paper", citekey: "doe2024paper", authors: ["Doe"], year: 2024, classKey: "source" }] })) });
    const r = await b.search("paper");
    if (!r.ok) throw new Error("expected ok");
    expect(r.results[0]).toEqual({ objectId: "n1", title: "Paper", citekey: "doe2024paper", authors: ["Doe"], year: 2024, classKey: "source" });
  });
});
```

- [ ] Run `pnpm test` — green.
- [ ] Commit: `feat(word): typed bridge client over the document protocol`

### Task 3: Settings store — port + pairing token persistence

**Files**
- Create: `/root/projects/notees-word/src/settings/store.ts`
- Test: `/root/projects/notees-word/test/settings-store.test.ts`

**Interfaces**
- Consumes: a `KVStore` interface `{ get(key: string): string | null; set(key: string, value: string): void }` (localStorage in the pane, in-memory in tests).
- Produces:

```ts
export interface AddinSettings { port: number; token: string; styleId: string; }
export interface SettingsStore {
  load(): AddinSettings;                    // defaults: port 8474, token "", styleId "apa"
  save(patch: Partial<AddinSettings>): AddinSettings;
  clear(): void;
}
export function createSettingsStore(kv: KVStore): SettingsStore;
```

**Steps**

- [ ] Write `src/settings/store.ts`:

```ts
const DEFAULTS: AddinSettings = { port: 8474, token: "", styleId: "apa" };
const KEY = "notees.addin.settings.v1";

export function createSettingsStore(kv: KVStore): SettingsStore {
  return {
    load() {
      try {
        const raw = kv.get(KEY);
        if (!raw) return { ...DEFAULTS };
        const parsed = JSON.parse(raw) as Partial<AddinSettings>;
        const port = Number(parsed.port);
        return {
          port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULTS.port,
          token: typeof parsed.token === "string" ? parsed.token : DEFAULTS.token,
          styleId: typeof parsed.styleId === "string" && parsed.styleId ? parsed.styleId : DEFAULTS.styleId,
        };
      } catch {
        return { ...DEFAULTS };
      }
    },
    save(patch) {
      const next = { ...this.load(), ...patch };
      kv.set(KEY, JSON.stringify(next));
      return next;
    },
    clear() {
      kv.set(KEY, JSON.stringify(DEFAULTS));
    },
  };
}
```

- [ ] Write `test/settings-store.test.ts` (in-memory KV): defaults on empty; round-trip save; corrupted JSON falls back to defaults; out-of-range port rejected; token survives round-trip. ≥5 assertions.
- [ ] Run `pnpm test` — green.
- [ ] Commit: `feat(word): settings store with validation and defaults`

### Task 4: Task pane shell + settings/pairing UI

**Files**
- Modify: `/root/projects/notees-word/src/ui/app.tsx`
- Create: `/root/projects/notees-word/src/ui/settings-panel.tsx`
- Create: `/root/projects/notees-word/src/ui/connection.ts` (wire bridge+settings to React state)
- Create: `/root/projects/notees-word/src/ui/app.css`

**Interfaces**
- Consumes: `createBridge` (Task 2), `createSettingsStore` with `localStorage` adapter (Task 3), `OfficeRuntime.storage` not used (localStorage is sufficient for a task pane).
- Produces UI state machine: `connection: "unknown" | "connecting" | "paired" | "offline" | "rejected"`; `styles: {id,label}[]` once paired.

**Steps**

- [ ] Write `src/ui/connection.ts` — a small React hook `useConnection()` that loads settings, exposes `connect(port, token)` (persists via store, then calls `bridge.listStyles()`; `offline` on `BridgeOfflineError`, `rejected` on `ok:false` — e.g. bad pairing token), and exposes `bridge` + `styles` when paired.
- [ ] Write `src/ui/settings-panel.tsx` — port (number input) + token (password input) + "Connect" button; inline error text for offline ("Is `notees serve` running?") vs rejected ("pairing token rejected — check `notees serve` output").
- [ ] Rewrite `src/ui/app.tsx`: if `connection !== "paired"` render `<SettingsPanel/>`; else render the placeholder shell with a "citations: N" badge (wired in Task 10) and the panels built in Tasks 5–8.
- [ ] `src/ui/app.css`: plain, compact task-pane styling (≈320px wide column); visible focus states.
- [ ] Manual smoke (record results in commit message): `pnpm build`; serve `dist/` with `python3 -m http.server` and open `index.html` in a plain browser — pane renders, settings persist across reload (localStorage). Office host behavior is Task 11's checklist.
- [ ] Commit: `feat(word): task pane shell with pairing settings screen`

### Task 5: Field-embed module — normative `ADDIN notees.Citation` code build/parse

**Files**
- Create: `/root/projects/notees-word/src/citation/embed.ts`
- Test: `/root/projects/notees-word/test/embed.test.ts`

**Interfaces**
- Produces (normative):

```ts
export interface CitationEmbed { citationId: string; nodeIds: string[]; styleId: string; locator?: string; }
export interface BibliographyEmbed { styleId: string; }
export const CITATION_FIELD_PREFIX = "ADDIN notees.Citation ";
export const BIBLIOGRAPHY_FIELD_PREFIX = "ADDIN notees.Bibliography ";

export function buildCitationCode(embed: CitationEmbed): string;
export function parseCitationCode(code: string): CitationEmbed | null;   // null for foreign/corrupted codes
export function buildBibliographyCode(embed: BibliographyEmbed): string;
export function parseBibliographyCode(code: string): BibliographyEmbed | null;
export function isNoteesCitation(code: string): boolean;                 // strict prefix match, no parse
```

**Steps**

- [ ] Write `src/citation/embed.ts`. Serialize embed JSON **compactly** (`JSON.stringify`, no spaces) so the field code stays one token after the prefix; parse with `JSON.parse` inside `try/catch`, then **validate every field with a guard** (string `citationId`, non-empty string array `nodeIds`, string `styleId`, optional string `locator`) — anything else returns `null` (Review Focus #4: corrupted embeds must never throw and never be treated as Notees citations). Unknown extra keys are preserved by re-serialization round-trip.
- [ ] Write `test/embed.test.ts` covering: round-trip build→parse equality; `locator` omitted vs present; code with trailing spaces tolerated on parse; wrong prefix (`ADDIN ZOTERO_ITEM …`, `ADDIN notees.Bibliography …`) → `null`/false; truncated JSON → `null`; `nodeIds: []` → `null`; `nodeIds: "n1"` (wrong type) → `null`; extra keys survive a build→parse→build round trip.
- [ ] Run `pnpm test` — green.
- [ ] Commit: `feat(word): normative citation/bibliography field embed codec`

### Task 6: OOXML module — field fragments and field scanning (pure)

**Files**
- Create: `/root/projects/notees-word/src/citation/ooxml.ts`
- Test: `/root/projects/notees-word/test/ooxml.test.ts`

**Interfaces**
- Produces:

```ts
export function escapeXml(s: string): string;
export function citationFieldXml(embed: CitationEmbed, displayText: string): string;
// → <w:fldSimple w:instr=" ADDIN notees.Citation {…} "><w:r><w:t xml:space="preserve">DISPLAY</w:t></w:r></w:fldSimple>
export function bibliographyFieldXml(embed: BibliographyEmbed, displayText: string): string;
export interface ScannedField { code: string; displayText: string; kind: "citation" | "bibliography" | "foreign"; embed: CitationEmbed | BibliographyEmbed | null; }
export function scanDocumentXml(documentXml: string): ScannedField[];
// Order-stable; handles both <w:fldSimple w:instr="…"> and complex fields
// (<w:fldChar w:fldCharType="begin"/><w:instrText>…</w:instrText>…<w:fldChar w:fldCharType="end"/>).
```

**Steps**

- [ ] Write `src/citation/ooxml.ts`:
  - `escapeXml`: `& < > "` plus non-ASCII passed through (Word is fine with UTF-8 OOXML; do **not** entity-encode non-ASCII — citeproc output contains accents).
  - `citationFieldXml`: emits exactly one `<w:fldSimple>` run pair with a **leading space inside the instr attribute** (`w:instr=" ADDIN notees.Citation {json} "`) — Word's convention for field instruction text.
  - `scanDocumentXml`: regex/walk-based scan handling both `fldSimple` (capture `w:instr` + inner text of `<w:t>`) and complex fields (pair `begin`/`separate`/`end` fldChar runs, capture concatenated `w:instrText`). Classify via `parseCitationCode`/`parseBibliographyCode` from Task 5; classification failures → `kind: "foreign"`, `embed: null` (Review Focus #2/#4).
- [ ] Write `test/ooxml.test.ts`: round-trip `citationFieldXml` → `scanDocumentXml` yields exactly one citation field with equal embed and display text (incl. display text containing `&`, `<`, accents, and double quotes); a document with two citations + one bibliography scans in document order; a Zotero `ADDIN ZOTERO_ITEM` complex field scans as `foreign` with its code intact; a broken complex field (begin without end) is skipped without throwing; `escapeXml` covers the four metacharacters.
- [ ] Run `pnpm test` — green.
- [ ] Commit: `feat(word): pure OOXML field generation and document scanning`

### Task 7: Document adapter — insert citation at selection

**Files**
- Create: `/root/projects/notees-word/src/word/document.ts`
- Test: `/root/projects/notees-word/test/collect-citations.test.ts` (pure part only)

**Interfaces**
- Consumes: `Word.run`, `context.document.getSelection().getRange()`, `range.insertOoxml(xml, Word.InsertLocation.replace)`, `Office.context.requirements.isSetSupported("WordApi", "1.5")`.
- Produces:

```ts
export async function insertCitationField(embed: CitationEmbed, displayText: string): Promise<void>;
// Throws CapabilityError when OOXML insertion is unavailable (Word for the web gap → visible message).
export function collectCitationNodeIds(fields: ScannedField[]): string[];
// dedup nodeIds across all citation embeds, document order, bibliography excluded — pure, unit-tested
```

**Steps**

- [ ] Write `src/word/document.ts` with `insertCitationField`: builds the fragment via `citationFieldXml` (Task 6), wraps it in a minimal valid OOXML document snippet — `<w:p><w:r><w:fldSimple …>…</w:fldSimple></w:r></w:p>` is NOT valid OOXML for insertOoxml; the fragment must be a full `<w:p>…</w:p>` containing the field run — and calls `range.insertOoxml(snippet, Word.InsertLocation.replace)`. Wrap `Word.run` rejections from unsupported hosts into `CapabilityError("insert-ooxml")` (Review Focus #5).
- [ ] Write the pure `collectCitationNodeIds` in `src/citation/collect.ts` (imported by the adapter so both web and desktop paths share it): flatten `nodeIds` of `kind === "citation"` embeds, dedupe preserving first occurrence, drop embeds with `nodeIds: []`.
- [ ] Write `test/collect-citations.test.ts`: multi-field dedupe order, empty embeds skipped, bibliography fields excluded, foreign fields excluded.
- [ ] Run `pnpm test` — green. (The `Word.run` call itself is exercised only in the Task 13 manual checklist.)
- [ ] Commit: `feat(word): insert citation as ADDIN field at selection`

### Task 8: Search pane — search box → results → Cite

**Files**
- Create: `/root/projects/notees-word/src/ui/search-panel.tsx`
- Modify: `/root/projects/notees-word/src/ui/app.tsx`
- Test: `/root/projects/notees-word/test/use-search.test.ts`

**Interfaces**
- Consumes: `bridge.search` (Task 2), `insertCitationField` (Task 7).
- Produces UI: search input (300 ms debounce), result rows (`title`, `authors (year)` subtitle, `citekey` if present), per-row "Cite" button, optional locator input shown while citing.

**Steps**

- [ ] Extract the search state machine into a pure, testable hook `src/ui/use-search.ts`: `useSearch(searchFn: (q: string) => Promise<BridgeResponse<{results: BridgeResult[]}>>)` → `{ state: "idle"|"loading"|"results"|"error", results, query, setQuery }`. Debounce inside the hook with an injectable timer for tests.
- [ ] Write `test/use-search.test.ts`: typing "doe" calls `searchFn` once (after debounce) and lands in `results`; an `ok:false` response lands in `error` carrying `code`; rapid typing cancels earlier calls (only last query's results applied); offline (`BridgeOfflineError` thrown by searchFn) → `error` with a dedicated `offline` marker.
- [ ] Write `src/ui/search-panel.tsx`: on "Cite" for result `r`, call `bridge.renderCitation([r.objectId], settings.styleId, locator?)`; on `ok` → `insertCitationField({ citationId: crypto.randomUUID(), nodeIds: [r.objectId], styleId: settings.styleId, locator }, citation)`; on `ok:false` → inline error; on offline → inline "bridge offline".
- [ ] Wire `<SearchPanel/>` into `App` under the paired state.
- [ ] Run `pnpm test` — green.
- [ ] Commit: `feat(word): search pane with cite action`

### Task 9: Refresh — rescan fields and re-render in place

**Files**
- Create: `/root/projects/notees-word/src/word/refresh.ts`
- Test: `/root/projects/notees-word/test/refresh-plan.test.ts`

**Interfaces**
- Consumes: `body.fields` (WordApi 1.5, primary) or `context.document.getOoxml()` + `scanDocumentXml` (fallback), `bridge.renderCitation`, `parseCitationCode`.
- Produces:

```ts
export interface RefreshPlanEntry { fieldIndex: number; embed: CitationEmbed; }
export interface RefreshOutcome { refreshed: number; skipped: number; failed: number; }
export function planRefresh(fields: ScannedField[]): RefreshPlanEntry[];
// citations with parseable embeds only — foreign/corrupted skipped (never deleted)
export async function refreshCitations(bridge: Bridge, fieldsApi: WordFieldAccess): Promise<RefreshOutcome>;
```

- `WordFieldAccess` is an interface `{ listFields(): Promise<{code, resultText}[]>, updateResultText(index, text): Promise<void> }` — implemented once over `body.fields` (desktop) and once over getOoxml/fldSimple rewrite (fallback). Keeping it an interface makes `refreshCitations` unit-testable with a fake.

**Steps**

- [ ] Write the pure `planRefresh` in `src/citation/refresh-plan.ts`: keep only `kind === "citation"` with non-null embed; **batch by distinct `styleId`** so one style switch doesn't cost N round trips… no — keep v1 simple: one `render-citation` call per field (batched per style is an optimization note for the changelog, not this task). Skip-not-corrupt is the contract (Review Focus #2).
- [ ] Write `refreshCitations`: for each planned entry, `renderCitation(embed.nodeIds, embed.styleId, embed.locator)`; on `ok` → `updateResultText`; on `ok:false` → count `failed`, leave text untouched; on `BridgeOfflineError` → abort remaining, report counts. Return `RefreshOutcome`.
- [ ] Write `test/refresh-plan.test.ts`: plan skips foreign and corrupted embeds; `refreshCitations` against a fake `WordFieldAccess` + stub bridge: happy path updates 2 fields and reports `{refreshed:2, skipped:1, failed:0}` (one Zotero foreign field present); a bridge `ok:false` for one embed reports `failed:1` and that field's text unchanged; offline mid-run stops and reports.
- [ ] Wire a "Refresh" button in the pane calling `refreshCitations` and surfacing "N refreshed · M skipped (foreign/corrupted) · K failed".
- [ ] Run `pnpm test` — green.
- [ ] Commit: `feat(word): refresh citations in place with skip-not-corrupt semantics`

### Task 10: Bibliography — insert/replace the `ADDIN notees.Bibliography` field

**Files**
- Create: `/root/projects/notees-word/src/word/bibliography.ts`
- Modify: `/root/projects/notees-word/src/ui/app.tsx`

**Interfaces**
- Consumes: `collectCitationNodeIds` (Task 7), `bridge.renderBibliography`, `bibliographyFieldXml` (Task 6), `insertOoxml` at `context.document.body` end.
- Produces: `async function insertOrReplaceBibliography(bridge, styleId, fieldAccess): Promise<{action: "inserted"|"replaced", nodeCount: number}>` — finds the first existing `notees.Bibliography` field and replaces its whole paragraph with the new field, else appends a new paragraph at the body end.

**Steps**

- [ ] Implement `insertOrReplaceBibliography`: scan (same `WordFieldAccess` as Task 9) → `nodeIds = collectCitationNodeIds(fields)` → if empty, throw `NoCitationsError` (UI shows "no Notees citations in this document yet"); `bridge.renderBibliography(nodeIds, styleId)` → on `ok` build `bibliographyFieldXml({styleId}, bibliography)` and insert/replace via OOXML at the located paragraph. On `ok:false` surface the bridge `code`/`message`.
- [ ] UI: "Insert bibliography" button (paired state) → outcome toast "bibliography replaced (12 sources)" / errors inline.
- [ ] Unit-test the pure decision helper `bibliographyTarget(fields): {kind: "replace", index} | {kind: "append"}` in `test/bibliography-target.test.ts`: replaces the first bibliography field when one exists; appends when none; ignores Zotero fields. Run `pnpm test` — green.
- [ ] Commit: `feat(word): insert or replace bibliography field from document citations`

### Task 11: Style picker — fed by `list-styles`, per-field style on refresh

**Files**
- Create: `/root/projects/notees-word/src/ui/style-picker.tsx`
- Modify: `/root/projects/notees-word/src/ui/connection.ts`, `src/ui/app.tsx`
- Test: `/root/projects/notees-word/test/style-merge.test.ts`

**Interfaces**
- Consumes: `bridge.listStyles()` → `{ styles: [{id, label}] }` (cached at connect; "Reload styles" button re-fetches).
- Produces: picker sets `settings.styleId` (used by **new** citations only — Review Focus #3); separate explicit action "Refresh all with this style" overrides each citation embed's `styleId` before refresh (implemented as: rewrite embed in field code → then normal refresh).

**Steps**

- [ ] Implement the embed-rewrite as a pure function `withStyle(embed: CitationEmbed, styleId: string): CitationEmbed` in `src/citation/embed.ts` (trivial clone) — test in `test/style-merge.test.ts`: rewrite preserves `citationId`/`nodeIds`/`locator`, swaps `styleId`; `parseCitationCode(buildCitationCode(withStyle(e, "chicago")))` round-trips.
- [ ] Write `src/ui/style-picker.tsx`: `<select>` of `{label}` keyed by `{id}`, persisted via settings store; "Reload styles" re-calls `listStyles` and merges (keeps current selection if still present, else first style, else `apa`).
- [ ] Add "Refresh all with this style" button: rewrites every citation field's code with the picked `styleId` (via `WordFieldAccess.updateCode` — add that method to the interface and both implementations), then runs Task 9's `refreshCitations`.
- [ ] Run `pnpm test` — green.
- [ ] Commit: `feat(word): citation style picker with explicit restyle action`

### Task 12: Document-open handler — detect fields, show citation count

**Files**
- Modify: `/root/projects/notees-word/src/word/document.ts`
- Create: `/root/projects/notees-word/src/ui/field-badge.tsx`
- Modify: `/root/projects/notees-word/src/ui/app.tsx`

**Interfaces**
- Consumes: `Office.onReady` document handle; rescan triggers: pane open, `DocumentSelectionChanged` not needed — rescan on pane open and after every insert/refresh (cheap) plus an explicit "Rescan" affordance.
- Produces: badge text `N citations · M bibliography` in the pane header; `N` counts `kind === "citation"`, `M` ∈ {0,1}.

**Steps**

- [ ] Add `async function scanDocument(fieldAccess: WordFieldAccess): Promise<ScannedField[]>` in `src/word/document.ts` (shared by refresh/bibliography/badge).
- [ ] Implement `WordFieldAccess` over `body.fields` (WordApi 1.5): `listFields` maps `field.code` + `field.result.text`; `updateResultText` calls `field.result.insertText(text, Word.InsertLocation.replace)`; `updateCode` rewrites via OOXML paragraph replacement (field code isn't directly writable in 1.5 — replace the whole field).
- [ ] Implement the OOXML fallback `WordFieldAccess` over `getOoxml()`: `listFields` via `scanDocumentXml`; `updateResultText`/`updateCode` throw `CapabilityError("read-only-fields")` — the UI shows "this host supports reading fields only" and disables refresh/restyle (Review Focus #5 degradation).
- [ ] Choose implementation at runtime: `Office.context.requirements.isSetSupported("WordApi", "1.5")` → fields API, else OOXML fallback.
- [ ] Wire badge into `App`; rescan after insert/refresh/bibliography mutations.
- [ ] Commit: `feat(word): citation count badge with host capability fallback`

### Task 13: XML manifest + build-output layout matching `/word/` serving + sideload docs

**Files**
- Create: `/root/projects/notees-word/public/manifest.xml`
- Create: `/root/projects/notees-word/scripts/copy-manifest.mjs`
- Modify: `/root/projects/notees-word/vite.config.ts` (copy `public/` into `dist/`)
- Create: `/root/projects/notees-word/README.md`

**Interfaces**
- Produces: `dist/manifest.xml` + `dist/index.html` + `dist/lib/office.js` + `dist/assets/*` — the sync-server sibling lane serves this directory at `/word/`; **all URLs inside manifest.xml must be absolute `https://<host>/word/…` placeholders replaced at deploy time** (the sync server lane owns the actual host; see README note) — the manifest supports `${HOST}` substitution done by `copy-manifest.mjs` via env `NOTEES_WORD_HOST` (default `https://localhost:8378`).

**Steps**

- [ ] Write `public/manifest.xml` — classic XML manifest, Word only:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xsi:type="TaskPaneApp">
  <Id>7b1f3c2e-4a5d-4e8b-9c6f-noteesword001</Id>
  <Version>0.1.0.0</Version>
  <ProviderName>Notees</ProviderName>
  <DefaultLocale>en-US</DefaultLocale>
  <DisplayName DefaultValue="Notees"/>
  <Description DefaultValue="Insert live Notees citations and bibliographies."/>
  <IconUrl DefaultValue="${HOST}/word/assets/icon-32.png"/>
  <HighResolutionIconUrl DefaultValue="${HOST}/word/assets/icon-80.png"/>
  <SupportUrl DefaultValue="https://github.com/miquelrosell99/notees-web"/>
  <AppDomains>
    <AppDomain>http://127.0.0.1</AppDomain>
  </AppDomains>
  <Hosts><Host Name="Document"/></Hosts>
  <DefaultSettings>
    <SourceLocation DefaultValue="${HOST}/word/index.html"/>
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
  <Requirements>
    <Sets>
      <Set Name="WordApi" MinVersion="1.5"/>
    </Sets>
  </Requirements>
</OfficeApp>
```

- [ ] Write `scripts/copy-manifest.mjs`: reads `public/manifest.xml`, replaces every `${HOST}` with `process.env.NOTEES_WORD_HOST ?? "https://localhost:8378"`, writes `dist/manifest.xml`. Generate `icon-32.png`/`icon-80.png` into `public/assets/` (simple "N" glyph on transparent background — any generator is fine; record the command used).
- [ ] `AppDomains` includes `http://127.0.0.1` so the pane's bridge XHR isn't blocked by the add-in sandbox (the pane origin is the https host; the bridge is a different origin — this declaration is what allows the call).
- [ ] README sideload docs (Review Focus #5 + adoption cost from spec risks):
  - **Windows desktop**: shared-folder catalog — registry key `HKEY_CURRENT_USER\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs` (string value: folder URL `\\<host>\share` or local path), Word → Insert → My Add-ins → shared folder → Notees. Note: XML manifest required (unified manifest unsupported on shares — this is why we ship XML).
  - **Word for the web**: M365 admin center integrated-apps upload of `manifest.xml` (admin consent) OR sideload via the "Upload my add-in" in a Word for the web session where the admin allows it; capability caveat: field refresh may be read-only (Task 12 fallback).
  - **macOS**: `manifest.xml` into `~/Library/Containers/com.Microsoft/Data/documents/wef` (Word for Mac sideload folder).
  - Pairing: run `notees serve --port 8474`, copy the printed pairing token into the pane's settings.
- [ ] Verify `pnpm build` output tree matches the layout exactly; `pnpm test` still green.
- [ ] Commit: `feat(word): xml manifest and /word/ build layout with sideload docs`

### Task 14: Manual smoke checklist + repo hygiene

**Files**
- Create: `/root/projects/notees-word/docs/smoke-checklist.md`
- Modify: `/root/projects/notees-word/README.md` (link the checklist)

**Steps**

- [ ] Write `docs/smoke-checklist.md` — the Word-host parts that vitest cannot cover; each item checked off by a human against a real Word build before this lane is called done:
  1. Sideload via shared-folder catalog (Windows) — pane loads, settings persist.
  2. `notees serve` stopped → pane opens showing "bridge offline" (Review Focus #1); field text in document untouched; restart bridge → "Connect" succeeds without pane reload.
  3. Insert citation from search result → field appears with rendered text; toggle field codes (Alt+F9) shows `ADDIN notees.Citation {…}`.
  4. Refresh after editing the source's year in Notees → text updates; document saved, reopened, refresh still works.
  5. Open a document with Zotero `ADDIN ZOTERO_ITEM` fields + one hand-corrupted Notees field → Refresh leaves both untouched, reports "skipped".
  6. Insert bibliography → paragraph appears; insert second citation, re-run → same paragraph replaced (not duplicated).
  7. Switch style picker → new insertions use new style; old citations unchanged until "Refresh all with this style".
  8. Word for the web (admin-center sideload): pane loads, badge counts fields, refresh shows read-only-host message if field APIs are unavailable (Review Focus #5).
  9. Field-code display: document saved as .docx, reopened in LibreOffice — citations still show rendered text (portability, from spec: "documents stay portable").
- [ ] Run the full gate once more: `pnpm install && pnpm typecheck && pnpm test && pnpm build` — all green.
- [ ] Final commit: `docs(word): manual smoke checklist for host-only behavior`

---

## Self-review notes (recorded)

- **Spec coverage**: search→cite, bibliography, refresh, style picker, ADDIN fields, bridge-only egress, statics at `/word/`, sideloading — all covered by Tasks 1–14. No spec item left unplanned.
- **Placeholder scan**: every task carries concrete file contents or concrete test assertions; the only deferred-to-implementation bits are the `WordFieldAccess` OOXML-rewrite details (Task 12) and icon generation (Task 13), both bounded and explicitly recorded.
- **Type consistency with the bridge protocol**: `search`/`render-citation`/`render-bibliography`/`list-styles` request envelopes, result keys (`results`, `citation`, `bibliography`, `styles`), and error shape (`{ok:false, error:{code,message}}`) are used verbatim from the normative shapes in every task interface.
- **Embed shape**: `{"citationId","nodeIds","styleId","locator"?}` and `{"styleId"}` are the only JSON shapes written into field codes, matching the normative definition.
