# Notees Connector — Firefox extension implementation plan

Date: 2026-11-08 · Lane: `notees-connector` (new repo, `/root/projects/notees-connector`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Ship the **Notees Connector**: one generic Firefox extension (Manifest V2) that captures web pages into Notees as bibliography sources or read-it-later items. Per-capture transport selection:

1. Notees tab open → relay through the tab (zero credentials, E2EE-safe).
2. Else direct REST to the configured sync server with a scoped API key.
3. Server answers `409 e2ee_required` and no tab is open → notify the user to open Notees.

One settings screen (server URL + API key, validated by a `GET /api/features` probe), per-feature toggles (bibliography capture, read-later), save actions via toolbar button, context menu, and keyboard shortcut. Firefox only, self-distributed unsigned XPI via `web-ext`.

## Architecture

```
notees-connector/
├── manifest.json            (MV2, source of truth, copied verbatim to dist/)
├── public/
│   └── icons/icon.svg       (single SVG icon set, Firefox supports SVG)
├── src/
│   ├── shared/              (types + pure functions shared by all contexts)
│   │   ├── source.ts        (SOURCE constant = "notees-connector")
│   │   ├── messages.ts      (normative page shapes + internal relay shapes)
│   │   ├── capture-types.ts (CapturePayload / CaptureOutcome / failure codes)
│   │   └── settings.ts      (ConnectorSettings, normalizeServerUrl, load/save)
│   ├── background/          (persistent-event background page)
│   │   ├── index.ts         (entry: wires action/menus/commands/storage)
│   │   ├── probe.ts         (GET /api/features settings validation)
│   │   ├── rest-client.ts   (POST /api/capture/web-page, X-API-Key)
│   │   ├── tabs.ts          (findNoteesTab by origin, ensureBridge injection)
│   │   ├── relay.ts         (runtime-messaging relay w/ timeout)
│   │   ├── transport.ts     (per-capture transport state machine)
│   │   ├── capture-command.ts (per-request orchestration incl. DOI + notify)
│   │   ├── notify.ts        (browser.notifications helpers)
│   │   └── menus.ts         (context menu rebuild on toggle changes)
│   ├── content/
│   │   └── bridge.ts        (postMessage bridge, injected ONLY into serverUrl tabs)
│   ├── capture/
│   │   └── extract-in-page.ts (self-contained DOI/ISBN meta extractor)
│   └── options/
│       ├── index.html
│       └── options.ts
├── test/                    (vitest, @webext-core/fake-browser, jsdom)
├── vite.config.ts
├── tsconfig.json
└── package.json
```

Key design decisions:

- **MV2 is deliberate.** Firefox stable fully supports MV2 in 2026 (Mozilla has committed to keeping it; Chrome's MV2 sunset does not affect Firefox). MV2 gives a real background page (no service-worker lifetime headaches), `browser.tabs.executeScript` for programmatic content-script injection, and native promise-based `browser.*` APIs. MV3 port is a non-goal (spec §Explicit non-goals).
- **No static content scripts.** MV2 `content_scripts` matches are static strings; the configured `serverUrl` is runtime data. So the bridge is injected programmatically into tabs whose URL origin equals the normalized `serverUrl` (policy enforced in `tabs.ts`), and `manifest.json` declares **no** static content scripts and **no** static host permissions. Instead `optional_permissions` carries broad http(s) patterns and the options page requests **exactly** the configured origin (`permissions.request({origins: ["<serverUrl>/*"]})`) on save. The granted origin covers both the REST `fetch` and bridge injection; nothing else is ever touched, and the API key is only ever sent to that origin.
- **`webextension-polyfill` as the single seam.** All contexts import `browser` from `webextension-polyfill` (bundled by vite). Tests swap it for `@webext-core/fake-browser` via one `vi.mock`. On Firefox the polyfill is a thin pass-through over native `browser.*`; it buys the test seam and a future Chrome port for free.
- **DOI extraction runs in the page via `executeScript` code-string.** The extractor is a fully self-contained function (no module-scope closures) serialized with `fn.toString()` — no bundler/completion-value issues, and the identical function is unit-tested under jsdom. Extracted identifiers go **only** on the REST path; the normative tab-relay page payload has no `identifiers` field (the Notees page-side handler is a different lane).
- **Per-request capture flow** (`capture-command.ts`): resolve payload → try tab relay if a serverUrl-tab is open (`failed` is retryable via REST; `not_authenticated`/`feature_disabled` are final) → else REST → map every failure code to a specific user notification (`e2ee_required` → "open Notees").

## Tech Stack

| Choice | Why |
|---|---|
| TypeScript (strict) + Vite | Multi-entry build (background / content bridge / options page) in one config; plain rollup IIFE output — content scripts must not be ES modules. No extension-framework magic to debug. |
| `web-ext` (Mozilla) | Lint, `web-ext run` for dev, `web-ext build` → unsigned XPI. The spec mandates it. |
| `webextension-polyfill` | Runtime API seam (see Architecture). |
| vitest + `@webext-core/fake-browser` | fake-browser is a maintained in-memory implementation of the `webextension-polyfill` API (v1.3.x, framework-agnostic) — storage, runtime messaging, notifications etc. behave like the real thing. Chosen over `sinon-chrome` (callback-style chrome.* API, stale, wrong shape for Firefox-first code). |
| jsdom | For `extract-in-page.ts` and the content-bridge tests (real `document`, `window.postMessage`). |
| pnpm | Fleet standard. |

## Spec:

`/root/projects/notees-web/docs/superpowers/specs/2026-11-08-citation-capture-integrations-design.md` (Notees Connector section; normative REST + tab-relay shapes restated per-task below).

## Global Constraints

- **Firefox MV2 only.** `browser.*` async APIs (via polyfill). No Chrome port, no `chrome.*` callbacks.
- **No page-body capture.** URL + title + metadata only. Never read `document.body` text, never snapshot.
- **`serverUrl` is potentially misconfigured.** It is normalized once (`normalizeServerUrl`) at save/validation time; every URL is built from that normalized origin. The `apiKey` is sent only to `{serverUrl}/api/*` of the configured origin — no other origin, no log, no notification, no third party.
- **Content script injected only into `{serverUrl}` origin tabs**, enforced by the injection policy in `tabs.ts` (origin equality check), not just by granted permissions.
- **Tab-relay page message shapes are normative** — `notees-capture-request` / `notees-capture-response` with `source: "notees-connector"` must match the spec verbatim; the page side is implemented in the `notees-web` lane.
- **Gates:** `pnpm test` (vitest run) and `pnpm typecheck` must pass after every task. `pnpm lint:ext` (web-ext lint) must pass before Task 13's packaging step.

## Review Focus

Five failure modes the implementer must keep green (each has a dedicated test):

1. **API key present but server unreachable** (DNS failure, timeout, offline) → `network_error` outcome → "Notees server unreachable" notification. Never an unhandled rejection.
2. **Notees tab open but logged out** → relay responds `ok:false, error.code:"not_authenticated"` → final failure (no REST retry with no key), "sign in to Notees" notification.
3. **Capture while offline with no tab open** → REST `network_error` → notification; nothing queued, nothing lost (v1 has no offline queue by design).
4. **DOI meta absent** → `extractIdentifiers` resolves `{}` (executeScript may also throw on restricted pages) → capture proceeds without `identifiers`, no failure.
5. **`serverUrl` with/without trailing slash (and with paths/whitespace)** → `normalizeServerUrl` collapses all to the bare origin (`https://host`); probe, REST, and tab-matching all use the normalized form.

---

### Task 1: Scaffold the repo

**Files**
- Create: `/root/projects/notees-connector/package.json`
- Create: `/root/projects/notees-connector/tsconfig.json`
- Create: `/root/projects/notees-connector/vite.config.ts`
- Create: `/root/projects/notees-connector/scripts/copy-static.mjs`
- Create: `/root/projects/notees-connector/public/manifest.json`
- Create: `/root/projects/notees-connector/public/icons/icon.svg`
- Create: `/root/projects/notees-connector/test/setup.ts`
- Create: `/root/projects/notees-connector/test/manifest.test.ts`
- Create: `/root/projects/notees-connector/src/background/index.ts` (stub entry)
- Create: `/root/projects/notees-connector/src/content/bridge.ts` (stub entry)
- Create: `/root/projects/notees-connector/src/options/index.html` (stub)
- Create: `/root/projects/notees-connector/src/options/options.ts` (stub)
- Create: `/root/projects/notees-connector/.gitignore` (`node_modules/`, `dist/`, `web-ext-artifacts/`, `*.xpi`)

**Interfaces**
- Produces: `dist/` folder layout that `web-ext run -s dist` and `web-ext build -s dist` accept (`dist/manifest.json`, `dist/background.js`, `dist/content-bridge.js`, `dist/options.html`).

**Steps**

- [ ] `mkdir -p /root/projects/notees-connector && cd /root/projects/notees-connector && git init` (repo is new; do not touch the notees-web checkout).
- [ ] Write `package.json`:

```json
{
  "name": "notees-connector",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "clean": "node -e \"require('node:fs').rmSync('dist',{recursive:true,force:true})\"",
    "build:scripts": "vite build --mode background && vite build --mode bridge && vite build --mode options",
    "build:static": "node scripts/copy-static.mjs",
    "build": "pnpm clean && pnpm build:scripts && pnpm build:static",
    "dev": "pnpm build && vite build --mode background --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "start": "web-ext run -s dist --target firefox-desktop",
    "lint:ext": "pnpm build && web-ext lint -s dist",
    "pack": "pnpm build && web-ext build -s dist --overwrite-dest"
  },
  "devDependencies": {
    "@types/webextension-polyfill": "^0.12.3",
    "@webext-core/fake-browser": "^1.3.4",
    "jsdom": "^26.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0",
    "web-ext": "^9.0.0",
    "webextension-polyfill": "^0.12.0"
  }
}
```

- [ ] Write `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUnusedLocals": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true
  },
  "include": ["src", "test", "vite.config.ts"]
}
```

- [ ] Write `vite.config.ts`. Build strategy: **one single-entry build per script target, selected by `--mode`.** MV2 requires `background.js` and `content-bridge.js` to be plain non-module scripts, but they share modules (`shared/*`, `webextension-polyfill`) — a multi-entry rollup build would code-split those shared imports into ES chunks (invalid for content scripts and MV2 backgrounds, and `format: "iife"` is rejected for code-splitting builds). Single-entry `lib` mode bundles each script fully self-contained; the options page is a real page, so a plain HTML build (ES modules fine there). `public/` statics are copied into `dist/` afterwards by `scripts/copy-static.mjs`:

```ts
/// <reference types="vitest/config" />
import { defineConfig, type UserConfig } from "vitest/config";

/** Self-contained non-module script bundle (MV2 background / content script). */
function scriptBuild(entry: string, fileName: string): UserConfig {
  return {
    build: {
      outDir: "dist",
      emptyOutDir: false, // several builds share dist/
      copyPublicDir: false,
      lib: {
        entry,
        name: fileName.replace(/[^a-zA-Z0-9]/g, ""), // IIFE global must be a valid identifier
        fileName: () => `${fileName}.js`,
        formats: ["iife"],
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  if (mode === "background") return scriptBuild("src/background/index.ts", "background");
  if (mode === "bridge") return scriptBuild("src/content/bridge.ts", "content-bridge");
  if (mode === "options") {
    return {
      build: {
        outDir: "dist",
        emptyOutDir: false,
        copyPublicDir: false,
        rollupOptions: { input: { options: "src/options/index.html" } },
      },
    };
  }
  // default (vitest / plain `vite` invocation): test config only
  return {
    test: {
      environment: "node",
      setupFiles: ["./test/setup.ts"],
      include: ["test/**/*.test.ts"],
    },
  };
});
```

- [ ] Write `scripts/copy-static.mjs` (keeps the manifest a plain checked-in JSON file with no templating):

```js
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
cpSync("public/manifest.json", "dist/manifest.json");
cpSync("public/icons", "dist/icons", { recursive: true });
console.log("static files copied to dist/");
```

- [ ] Write `public/manifest.json` (single source of truth; `copy-static.mjs` copies it to `dist/`):

```json
{
  "manifest_version": 2,
  "name": "Notees Connector",
  "version": "0.1.0",
  "description": "Capture web pages into Notees: bibliography sources and read-it-later. Privacy-first, local-first.",
  "icons": {
    "48": "icons/icon.svg",
    "96": "icons/icon.svg"
  },
  "permissions": ["storage", "notifications", "contextMenus", "activeTab", "tabs"],
  "optional_permissions": ["https://*/*", "http://*/*"],
  "background": {
    "scripts": ["background.js"],
    "persistent": false
  },
  "browser_action": {
    "default_title": "Save to Notees",
    "default_icon": "icons/icon.svg"
  },
  "options_ui": {
    "page": "options.html",
    "open_in_tab": true
  },
  "commands": {
    "_execute_browser_action": {
      "suggested_key": { "default": "Ctrl+Alt+S" }
    }
  }
}
```

- [ ] Write `public/icons/icon.svg` (plain SVG text; Firefox accepts SVG icons; a PNG icon set is planned follow-up before wide distribution — see Task 13):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="20" fill="#4f6ef7"/>
  <text x="48" y="64" font-family="sans-serif" font-size="52" font-weight="700" fill="#ffffff" text-anchor="middle">N</text>
</svg>
```

- [ ] Write `test/setup.ts` (the single polyfill seam for all tests):

```ts
import { vi, beforeEach } from "vitest";

vi.mock("webextension-polyfill", async () => {
  const { fakeBrowser } = await import("@webext-core/fake-browser");
  return { default: fakeBrowser };
});

beforeEach(async () => {
  const { fakeBrowser } = await import("@webext-core/fake-browser");
  fakeBrowser.reset();
});
```

- [ ] Write stub entries (kept minimal; real code lands in later tasks):

```ts
// src/background/index.ts
import browser from "webextension-polyfill";
void browser; // wired in Task 12
```

```ts
// src/content/bridge.ts
// postMessage bridge — implemented in Task 7
export {};
```

```html
<!-- src/options/index.html -->
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Notees Connector settings</title></head>
  <body><h1>Notees Connector</h1></body>
</html>
```

```ts
// src/options/options.ts
export {};
```

- [ ] Write `test/manifest.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"));

describe("manifest", () => {
  it("is Manifest V2 for Firefox", () => {
    expect(manifest.manifest_version).toBe(2);
    expect(manifest.background.scripts).toContain("background.js");
  });
  it("declares no static content scripts and no static host permissions", () => {
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.host_permissions).toBeUndefined();
  });
  it("carries optional host permissions for runtime origin grants", () => {
    expect(manifest.optional_permissions).toEqual(
      expect.arrayContaining(["https://*/*", "http://*/*"]),
    );
  });
  it("has an options page and the keyboard command", () => {
    expect(manifest.options_ui.page).toBe("options.html");
    expect(manifest.commands["_execute_browser_action"].suggested_key.default).toBe("Ctrl+Alt+S");
  });
});
```

- [ ] `corepack enable && pnpm install`, then `pnpm test`, `pnpm typecheck`, `pnpm build` — all green; `ls dist` shows `manifest.json`, `background.js`, `content-bridge.js`, `options.html`, `icons/icon.svg`.

---

### Task 2: Shared contracts — messages, capture types, settings

**Files**
- Create: `src/shared/source.ts`
- Create: `src/shared/messages.ts`
- Create: `src/shared/capture-types.ts`
- Create: `src/shared/settings.ts`
- Create: `test/shared/settings.test.ts`
- Create: `test/shared/messages.test.ts`

**Interfaces**
- Produces (normative, verbatim from spec):
  - Page request: `{ source: "notees-connector", type: "notees-capture-request", requestId, payload: { url, title, mode, note? } }`
  - Page response (ok): `{ source: "notees-connector", type: "notees-capture-response", requestId, ok: true, objectId }`
  - Page response (err): `{ source: "notees-connector", type: "notees-capture-response", requestId, ok: false, error: { code: "not_authenticated" | "feature_disabled" | "failed", message } }`
- Produces (internal, background ↔ content script — our own shape, documented here and only here):
  - `{ source: "notees-connector", type: "relay-to-page", requestId, payload }` (background → content script, runtime.sendMessage)
  - `{ source: "notees-connector", type: "relay-from-page", requestId, ok: true, objectId }` or `{ …, ok: false, error }` (content script → background, runtime.sendMessage)
- Consumes: `browser.storage.local` key `"settings"` with shape `ConnectorSettings`.

**Steps**

- [ ] Write `src/shared/source.ts`:

```ts
export const SOURCE = "notees-connector" as const;
```

- [ ] Write `src/shared/messages.ts`:

```ts
import { SOURCE } from "./source";

/** Payload the Notees page receives. Normative — must match the spec verbatim. */
export interface PageCapturePayload {
  url: string;
  title: string;
  mode: "source" | "readlater";
  note?: string;
}

export interface PageCaptureRequest {
  source: typeof SOURCE;
  type: "notees-capture-request";
  requestId: string;
  payload: PageCapturePayload;
}

export interface PageCaptureOk {
  source: typeof SOURCE;
  type: "notees-capture-response";
  requestId: string;
  ok: true;
  objectId: string;
}

export interface PageCaptureError {
  code: "not_authenticated" | "feature_disabled" | "failed";
  message: string;
}

export interface PageCaptureErr {
  source: typeof SOURCE;
  type: "notees-capture-response";
  requestId: string;
  ok: false;
  error: PageCaptureError;
}

export type PageCaptureResponse = PageCaptureOk | PageCaptureErr;

/** Internal: background → content script (bridged to page as PageCaptureRequest). */
export interface RelayToPage {
  source: typeof SOURCE;
  type: "relay-to-page";
  requestId: string;
  payload: PageCapturePayload;
}

/** Internal: content script → background (bridged from PageCaptureResponse). */
export interface RelayFromPageOk {
  source: typeof SOURCE;
  type: "relay-from-page";
  requestId: string;
  ok: true;
  objectId: string;
}

export interface RelayFromPageErr {
  source: typeof SOURCE;
  type: "relay-from-page";
  requestId: string;
  ok: false;
  error: PageCaptureError;
}

export type RelayFromPage = RelayFromPageOk | RelayFromPageErr;

export function pageResponseToRelay(msg: PageCaptureResponse): RelayFromPage {
  return msg.ok
    ? { source: SOURCE, type: "relay-from-page", requestId: msg.requestId, ok: true, objectId: msg.objectId }
    : { source: SOURCE, type: "relay-from-page", requestId: msg.requestId, ok: false, error: msg.error };
}

export function pageRequestFromRelay(msg: RelayToPage): PageCaptureRequest {
  return { source: SOURCE, type: "notees-capture-request", requestId: msg.requestId, payload: msg.payload };
}
```

- [ ] Write `src/shared/capture-types.ts`:

```ts
export type CaptureMode = "source" | "readlater";

export interface CaptureIdentifiers {
  doi?: string;
  isbn?: string;
}

/** POST /api/capture/web-page body (REST path). Identifiers are REST-only. */
export interface CapturePayload {
  url: string;
  title: string;
  mode: CaptureMode;
  identifiers?: CaptureIdentifiers;
  note?: string;
}

export type CaptureFailureCode =
  | "not_authenticated"
  | "feature_disabled"
  | "e2ee_required"
  | "network_error"
  | "http_error"
  | "failed";

export interface CaptureFailure {
  code: CaptureFailureCode;
  message: string;
}

export type CaptureOutcome =
  | { ok: true; transport: "tab-relay" | "rest"; objectId: string; collectionId?: string }
  | { ok: false; error: CaptureFailure };
```

- [ ] Write `src/shared/settings.ts` (the single place `serverUrl` is normalized — Review Focus #5):

```ts
import browser from "webextension-polyfill";

export interface ConnectorSettings {
  /** Normalized origin, e.g. "https://host" — no path, no trailing slash. */
  serverUrl: string;
  /** "nk_…" scoped key; "" when unset. Sent ONLY to serverUrl. */
  apiKey: string;
  features: { bibliography: boolean; readLater: boolean };
}

export const DEFAULT_SETTINGS: ConnectorSettings = {
  serverUrl: "",
  apiKey: "",
  features: { bibliography: true, readLater: true },
};

const STORAGE_KEY = "settings";

/**
 * Collapses "https://host/", "https://host", " https://host/app "
 * to the bare origin "https://host". Throws on garbage or non-http(s) input.
 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Server URL must include the scheme, e.g. https://example.com — got "${raw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Server URL must be http(s) — got "${url.protocol}"`);
  }
  return url.origin;
}

export async function loadSettings(): Promise<ConnectorSettings> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  const value = (stored[STORAGE_KEY] ?? {}) as Partial<ConnectorSettings>;
  return {
    serverUrl: typeof value.serverUrl === "string" ? value.serverUrl : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    features: {
      bibliography: value.features?.bibliography ?? DEFAULT_SETTINGS.features.bibliography,
      readLater: value.features?.readLater ?? DEFAULT_SETTINGS.features.readLater,
    },
  };
}

export async function saveSettings(settings: ConnectorSettings): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: settings });
}
```

- [ ] Write `test/shared/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeServerUrl } from "../../src/shared/settings";

describe("normalizeServerUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeServerUrl("https://host.example/")).toBe("https://host.example");
    expect(normalizeServerUrl("https://host.example///")).toBe("https://host.example");
  });
  it("drops paths, queries and fragments, trims whitespace", () => {
    expect(normalizeServerUrl("  https://host.example/app/?x=1#y ")).toBe("https://host.example");
  });
  it("keeps non-default ports", () => {
    expect(normalizeServerUrl("http://lan-ip:8377/")).toBe("http://lan-ip:8377");
  });
  it("returns empty string for empty input", () => {
    expect(normalizeServerUrl("")).toBe("");
    expect(normalizeServerUrl("   ")).toBe("");
  });
  it("throws on garbage and non-http schemes", () => {
    expect(() => normalizeServerUrl("host.example")).toThrow(/scheme/);
    expect(() => normalizeServerUrl("ftp://host.example")).toThrow(/http/);
  });
});
```

- [ ] Write `test/shared/messages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SOURCE } from "../../src/shared/source";
import { pageRequestFromRelay, pageResponseToRelay } from "../../src/shared/messages";

describe("relay message mapping", () => {
  it("builds the normative page request verbatim", () => {
    const req = pageRequestFromRelay({
      source: SOURCE,
      type: "relay-to-page",
      requestId: "r1",
      payload: { url: "https://example.com/a", title: "A", mode: "source" },
    });
    expect(req).toEqual({
      source: "notees-connector",
      type: "notees-capture-request",
      requestId: "r1",
      payload: { url: "https://example.com/a", title: "A", mode: "source" },
    });
  });
  it("maps ok page responses", () => {
    expect(
      pageResponseToRelay({
        source: SOURCE,
        type: "notees-capture-response",
        requestId: "r2",
        ok: true,
        objectId: "obj-9",
      }),
    ).toEqual({ source: "notees-connector", type: "relay-from-page", requestId: "r2", ok: true, objectId: "obj-9" });
  });
  it("maps error page responses with the normative error subset", () => {
    const out = pageResponseToRelay({
      source: SOURCE,
      type: "notees-capture-response",
      requestId: "r3",
      ok: false,
      error: { code: "not_authenticated", message: "no session" },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("not_authenticated");
  });
});
```

- [ ] `pnpm test && pnpm typecheck` green.

---

### Task 3: Options page + settings persistence + host-permission grant

**Files**
- Modify: `src/options/index.html` (rewrite)
- Create: `src/options/options.ts`
- Create: `src/options/options.css`
- Create: `test/options/options.test.ts`

**Interfaces**
- Consumes: `loadSettings`, `saveSettings`, `normalizeServerUrl`, `ConnectorSettings` (Task 2); `probeServer` (Task 4 — options.ts imports it from `../background/probe`; this task's test mocks that module, so both tasks stay green in listed order).
- Produces: storage key `"settings"` (via `saveSettings`); a `permissions.request` grant for exactly `${serverUrl}/*`.

**Steps**

- [ ] Write `src/options/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Notees Connector settings</title>
    <link rel="stylesheet" href="./options.css" />
  </head>
  <body>
    <main>
      <h1>Notees Connector</h1>
      <form id="settings-form">
        <label>
          Notees server URL
          <input id="server-url" type="url" placeholder="https://your-host" autocomplete="off" />
        </label>
        <p class="hint">The connection permission prompt that follows grants this extension access to <em>only</em> this origin.</p>
        <label>
          API key (optional — minted in Notees settings with the <code>capture.write</code> scope)
          <input id="api-key" type="password" placeholder="nk_…" autocomplete="off" />
        </label>
        <fieldset>
          <legend>Capture features</legend>
          <label><input id="feat-bibliography" type="checkbox" /> Bibliography capture</label>
          <label><input id="feat-readlater" type="checkbox" /> Read later</label>
        </fieldset>
        <button id="save" type="submit">Save</button>
        <button id="test" type="button">Test connection</button>
        <p id="status" role="status"></p>
      </form>
    </main>
    <script type="module" src="./options.ts"></script>
  </body>
</html>
```

- [ ] Write `src/options/options.css` (minimal but functional — no design system in this repo):

```css
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 2rem auto; max-width: 34rem; padding: 0 1rem; }
label { display: block; margin: 0.75rem 0; }
input[type="url"], input[type="password"] { box-sizing: border-box; width: 100%; padding: 0.4rem; margin-top: 0.25rem; }
fieldset { margin: 1rem 0; border: 1px solid CanvasText; border-radius: 4px; }
fieldset label { margin: 0.25rem 0; }
.hint { font-size: 0.85rem; opacity: 0.75; }
#status.ok { color: #1a7f37; }
#status.err { color: #cf222e; }
button { padding: 0.4rem 0.9rem; margin-right: 0.5rem; }
```

- [ ] Write `src/options/options.ts`:

```ts
import browser from "webextension-polyfill";
import {
  ConnectorSettings,
  loadSettings,
  normalizeServerUrl,
  saveSettings,
} from "../shared/settings";
import { probeServer } from "../background/probe";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const statusEl = $("status");

function setStatus(text: string, kind: "ok" | "err" | ""): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

async function readForm(): Promise<ConnectorSettings> {
  const serverUrl = normalizeServerUrl(($("server-url") as HTMLInputElement).value);
  return {
    serverUrl,
    apiKey: ($("api-key") as HTMLInputElement).value.trim(),
    features: {
      bibliography: ($("feat-bibliography") as HTMLInputElement).checked,
      readLater: ($("feat-readlater") as HTMLInputElement).checked,
    },
  };
}

/** Grant the extension access to exactly the configured origin. */
async function requestOriginPermission(serverUrl: string): Promise<boolean> {
  if (!serverUrl) return false;
  try {
    return await browser.permissions.request({ origins: [`${serverUrl}/*`] });
  } catch {
    return false;
  }
}

async function persist(settings: ConnectorSettings): Promise<void> {
  await saveSettings(settings);
  await browser.runtime.sendMessage({
    source: "notees-connector",
    type: "settings-changed",
    features: settings.features,
  }).catch(() => undefined); // background may be asleep; menus rebuild on wake via storage.onChanged too
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  ($("server-url") as HTMLInputElement).value = settings.serverUrl;
  ($("api-key") as HTMLInputElement).value = settings.apiKey;
  ($("feat-bibliography") as HTMLInputElement).checked = settings.features.bibliography;
  ($("feat-readlater") as HTMLInputElement).checked = settings.features.readLater;

  $("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    let settings: ConnectorSettings;
    try {
      settings = await readForm();
    } catch (err) {
      setStatus((err as Error).message, "err");
      return;
    }
    if (settings.serverUrl) {
      const granted = await requestOriginPermission(settings.serverUrl);
      if (!granted) setStatus("Origin permission denied — tab relay and REST capture will not work.", "err");
    }
    await persist(settings);
    setStatus("Saved.", "ok");
  });

  $("test").addEventListener("click", async () => {
    let settings: ConnectorSettings;
    try {
      settings = await readForm();
    } catch (err) {
      setStatus((err as Error).message, "err");
      return;
    }
    if (!settings.serverUrl || !settings.apiKey) {
      setStatus("Enter the server URL and an API key to test the connection.", "err");
      return;
    }
    setStatus("Probing…", "");
    const result = await probeServer(settings.serverUrl, settings.apiKey);
    setStatus(
      result.ok
        ? "Connection OK — the server accepted the API key."
        : result.error === "unauthorized"
          ? "The server rejected the API key (401/403)."
          : "Could not reach the server — check the URL and network.",
      result.ok ? "ok" : "err",
    );
  });
}

declare global {
  interface Window {
    __noteesOptionsInit?: boolean;
  }
}

export { init };

// Self-initialize in the real page; the guard keeps jsdom tests able to re-init per case.
if (!window.__noteesOptionsInit) {
  window.__noteesOptionsInit = true;
  void init();
}
```

- [ ] Write `test/options/options.test.ts` (jsdom; probe mocked so this task is green before Task 4 exists — vitest resolves the mock):

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

vi.mock("../../src/background/probe", () => ({
  probeServer: vi.fn(),
}));

import { probeServer } from "../../src/background/probe";

async function typeAndSave() {
  (document.getElementById("server-url") as HTMLInputElement).value = "https://host.example/";
  (document.getElementById("api-key") as HTMLInputElement).value = "nk_test";
  document.getElementById("feat-readlater")!.click(); // uncheck
  document.getElementById("settings-form")!.dispatchEvent(
    new Event("submit", { cancelable: true }),
  );
  await vi.waitFor(() => {
    expect(document.getElementById("status")!.textContent).toBe("Saved.");
  });
}

describe("options page", () => {
  beforeEach(async () => {
    document.body.innerHTML = `
      <form id="settings-form">
        <input id="server-url" type="url" /><input id="api-key" type="password" />
        <input id="feat-bibliography" type="checkbox" checked />
        <input id="feat-readlater" type="checkbox" checked />
        <button id="test" type="button"></button><p id="status"></p>
      </form>`;
    delete (window as { __noteesOptionsInit?: boolean }).__noteesOptionsInit;
    vi.spyOn(fakeBrowser.permissions, "request").mockResolvedValue(true as never);
    const mod = await import("../../src/options/options");
    await (mod as unknown as { init?: () => Promise<void> }).init?.();
  });

  it("normalizes the URL, saves settings, and requests exactly the configured origin", async () => {
    await typeAndSave();
    const stored = await fakeBrowser.storage.local.get("settings");
    expect(stored.settings).toMatchObject({
      serverUrl: "https://host.example",
      apiKey: "nk_test",
      features: { bibliography: true, readLater: false },
    });
    expect(fakeBrowser.permissions.request).toHaveBeenCalledWith({
      origins: ["https://host.example/*"],
    });
  });

  it("rejects a misconfigured URL with a visible error and does not save", async () => {
    (document.getElementById("server-url") as HTMLInputElement).value = "not-a-url";
    document.getElementById("settings-form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => {
      expect(document.getElementById("status")!.className).toBe("err");
    });
    expect(await fakeBrowser.storage.local.get("settings")).toEqual({});
    expect(fakeBrowser.permissions.request).not.toHaveBeenCalled();
  });

  it("test-connection button reports probe failure", async () => {
    (document.getElementById("server-url") as HTMLInputElement).value = "https://host.example";
    (document.getElementById("api-key") as HTMLInputElement).value = "nk_bad";
    vi.mocked(probeServer).mockResolvedValue({ ok: false, error: "unauthorized" });
    document.getElementById("test")!.dispatchEvent(new Event("click"));
    await vi.waitFor(() => {
      expect(document.getElementById("status")!.textContent).toContain("rejected the API key");
    });
  });
});
```

- [ ] Note the deliberate split in `options.ts`: `export { init }` exists for tests, and the module self-initializes under the `window.__noteesOptionsInit` guard (the page uses the guard path; tests delete the flag per case — already reflected in the code and test above).
- [ ] `pnpm test && pnpm typecheck` green.

---

### Task 4: Server probe (`GET /api/features`)

**Files**
- Create: `src/background/probe.ts`
- Create: `test/background/probe.test.ts`

**Interfaces**
- Consumes: `GET {serverUrl}/api/features` with header `X-API-Key` → 200 `{features:[…]}`; 401/403 = bad key (normative).
- Produces:
```ts
export type ProbeResult = { ok: true } | { ok: false; error: "unauthorized" | "unreachable" };
export async function probeServer(serverUrl: string, apiKey: string): Promise<ProbeResult>;
```

**Steps**

- [ ] Write `src/background/probe.ts`:

```ts
const PROBE_TIMEOUT_MS = 10000;

export type ProbeResult = { ok: true } | { ok: false; error: "unauthorized" | "unreachable" };

/** Validates settings: GET {serverUrl}/api/features with X-API-Key. 401/403 → bad key. */
export async function probeServer(serverUrl: string, apiKey: string): Promise<ProbeResult> {
  if (!serverUrl || !apiKey) return { ok: false, error: "unreachable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${serverUrl}/api/features`, {
      headers: { "X-API-Key": apiKey },
      signal: controller.signal,
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: "unauthorized" };
    return { ok: false, error: "unreachable" };
  } catch {
    return { ok: false, error: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] Write `test/background/probe.test.ts` (Review Focus #1 — key present, server unreachable):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeServer } from "../../src/background/probe";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => fetchMock.mockReset());

describe("probeServer", () => {
  it("succeeds on 200", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ features: [] }), { status: 200 }));
    expect(await probeServer("https://host.example", "nk_ok")).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("https://host.example/api/features", {
      headers: { "X-API-Key": "nk_ok" },
      signal: expect.any(AbortSignal),
    });
  });
  it("treats 401 and 403 as a bad key", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    expect(await probeServer("https://host.example", "nk_bad")).toEqual({ ok: false, error: "unauthorized" });
    fetchMock.mockResolvedValue(new Response("{}", { status: 403 }));
    expect(await probeServer("https://host.example", "nk_bad")).toEqual({ ok: false, error: "unauthorized" });
  });
  it("server unreachable → unreachable (offline, DNS, timeout)", async () => {
    fetchMock.mockRejectedValue(new TypeError("NetworkError"));
    expect(await probeServer("https://host.example", "nk_ok")).toEqual({ ok: false, error: "unreachable" });
    fetchMock.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    expect(await probeServer("https://host.example", "nk_ok")).toEqual({ ok: false, error: "unreachable" });
  });
  it("never sends the key anywhere but the configured origin", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await probeServer("https://host.example", "nk_secret");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://host.example/api/features");
    expect(url).not.toContain("nk_secret");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("nk_secret");
  });
});
```

- [ ] `pnpm test && pnpm typecheck` green. Re-run the options tests — Task 3's mocked probe now resolves to the real module path without changes.

---

### Task 5: REST capture client (`POST /api/capture/web-page`)

**Files**
- Create: `src/background/rest-client.ts`
- Create: `test/background/rest-client.test.ts`

**Interfaces**
- Consumes (normative): `POST {serverUrl}/api/capture/web-page`, header `X-API-Key`, body `{url, title, mode, identifiers?, note?}` → 201 `{objectId, collectionId?}`; 403 `{code:"feature_disabled"}`; 409 `{code:"e2ee_required"}`; 401 = bad key.
- Produces: `captureViaRest(settings, payload): Promise<CaptureOutcome>` using the shared `CaptureOutcome` type (Task 2).

**Steps**

- [ ] Write `src/background/rest-client.ts`:

```ts
import { CaptureOutcome, CapturePayload } from "../shared/capture-types";
import { ConnectorSettings } from "../shared/settings";

const CAPTURE_TIMEOUT_MS = 15000;

/**
 * Direct REST transport. The API key leaves the extension only inside this
 * function, only in the X-API-Key header, only to `${settings.serverUrl}/api/…`.
 */
export async function captureViaRest(
  settings: ConnectorSettings,
  payload: CapturePayload,
): Promise<CaptureOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
  try {
    const res = await fetch(`${settings.serverUrl}/api/capture/web-page`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": settings.apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.status === 201) {
      const body = (await res.json()) as { objectId: string; collectionId?: string };
      return { ok: true, transport: "rest", objectId: body.objectId, collectionId: body.collectionId };
    }
    let code: "not_authenticated" | "feature_disabled" | "e2ee_required" | "http_error" = "http_error";
    let message = `Server answered ${res.status}`;
    try {
      const body = (await res.json()) as { code?: string; message?: string };
      if (res.status === 401) code = "not_authenticated";
      else if (body.code === "feature_disabled") code = "feature_disabled";
      else if (body.code === "e2ee_required") code = "e2ee_required";
      if (body.message) message = body.message;
    } catch {
      // non-JSON error body — keep the status-based message
    }
    return { ok: false, error: { code, message } };
  } catch {
    return { ok: false, error: { code: "network_error", message: "Could not reach the Notees server" } };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] Write `test/background/rest-client.test.ts` (covers Review Focus #1 and #3, and the 409 normative shape):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureViaRest } from "../../src/background/rest-client";
import { ConnectorSettings } from "../../src/shared/settings";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const settings: ConnectorSettings = {
  serverUrl: "https://host.example",
  apiKey: "nk_test",
  features: { bibliography: true, readLater: true },
};

const payload = { url: "https://example.com/a", title: "A", mode: "source" as const };

afterEach(() => fetchMock.mockReset());

describe("captureViaRest", () => {
  it("201 → ok with objectId/collectionId", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ objectId: "obj-1", collectionId: "col-1" }), { status: 201 }),
    );
    expect(await captureViaRest(settings, payload)).toEqual({
      ok: true, transport: "rest", objectId: "obj-1", collectionId: "col-1",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://host.example/api/capture/web-page");
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("nk_test");
  });
  it("403 feature_disabled → mapped failure (normative body)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: "feature_disabled" }), { status: 403 }),
    );
    const out = await captureViaRest(settings, payload);
    expect(out).toEqual({ ok: false, error: { code: "feature_disabled", message: "Server answered 403" } });
  });
  it("409 e2ee_required → mapped failure (normative body)", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: "e2ee_required", message: "E2EE workspace" }), { status: 409 }),
    );
    const out = await captureViaRest(settings, payload);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("e2ee_required");
      expect(out.error.message).toBe("E2EE workspace");
    }
  });
  it("401 → not_authenticated", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    const out = await captureViaRest(settings, payload);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("not_authenticated");
  });
  it("offline / unreachable → network_error, never throws", async () => {
    fetchMock.mockRejectedValue(new TypeError("NetworkError"));
    expect(await captureViaRest(settings, payload)).toEqual({
      ok: false, error: { code: "network_error", message: "Could not reach the Notees server" },
    });
  });
});
```

- [ ] `pnpm test && pnpm typecheck` green.

---

### Task 6: Notees-tab discovery + programmatic bridge injection

**Files**
- Create: `src/background/tabs.ts`
- Create: `test/background/tabs.test.ts`

**Interfaces**
- Consumes: `browser.tabs.query({})`; `browser.tabs.executeScript(tabId, { file: "content-bridge.js" })` (MV2 + activeTab/granted origin).
- Produces:
```ts
export async function findNoteesTab(serverUrl: string): Promise<browser.tabs.Tab | null>;
export async function ensureBridge(tabId: number): Promise<void>; // re-injection safe
```

**Steps**

- [ ] Write `src/background/tabs.ts`:

```ts
import browser from "webextension-polyfill";

function sameOrigin(url: string | undefined, serverUrl: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === serverUrl;
  } catch {
    return false; // about:, moz-extension:, etc.
  }
}

/** A Notees tab = any tab whose URL origin equals the configured server origin. */
export async function findNoteesTab(serverUrl: string): Promise<browser.tabs.Tab | null> {
  if (!serverUrl) return null;
  const tabs = await browser.tabs.query({});
  return tabs.find((t) => sameOrigin(t.url, serverUrl)) ?? null;
}

/**
 * Injects the postMessage bridge into a serverUrl-origin tab.
 * The bridge itself is idempotent (Task 7) — safe to call on every capture.
 */
export async function ensureBridge(tabId: number): Promise<void> {
  await browser.tabs.executeScript(tabId, { file: "content-bridge.js" });
}
```

- [ ] Write `test/background/tabs.test.ts` (Review Focus #5 — matching uses the normalized origin):

```ts
import { describe, expect, it, vi } from "vitest";
import browser from "webextension-polyfill";
import { fakeBrowser } from "@webext-core/fake-browser";
import { ensureBridge, findNoteesTab } from "../../src/background/tabs";

describe("findNoteesTab", () => {
  it("matches only tabs on the configured server origin", async () => {
    vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([
      { id: 1, url: "https://host.example/app/page" },
      { id: 2, url: "https://other.example/" },
      { id: 3, url: "https://host.example.evil/" },
      { id: 4, url: undefined },
    ] as never);
    const tab = await findNoteesTab("https://host.example");
    expect(tab?.id).toBe(1);
  });
  it("returns null when no serverUrl or no matching tab", async () => {
    vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([{ id: 2, url: "https://other.example/" }] as never);
    expect(await findNoteesTab("")).toBeNull();
    expect(await findNoteesTab("https://host.example")).toBeNull();
  });
});

describe("ensureBridge", () => {
  it("injects the bridge script into the given tab", async () => {
    const spy = vi.spyOn(browser.tabs, "executeScript").mockResolvedValue([undefined] as never);
    await ensureBridge(7);
    expect(spy).toHaveBeenCalledWith(7, { file: "content-bridge.js" });
  });
});
```

- [ ] `pnpm test && pnpm typecheck` green.

---

### Task 7: Content-script postMessage bridge

**Files**
- Create: `src/content/bridge.ts` (rewrite)
- Create: `test/content/bridge.test.ts`

**Interfaces**
- Consumes: internal `relay-to-page` runtime messages (Task 2 shape) from the background.
- Produces: postMessage'd `notees-capture-request` to the page; runtime `relay-from-page` messages to the background, both via the Task 2 mappers. Page-side shapes are normative (verbatim `source`/`type` strings).

**Steps**

- [ ] Write `src/content/bridge.ts`:

```ts
import browser from "webextension-polyfill";
import { SOURCE } from "../shared/source";
import {
  PageCaptureResponse,
  RelayToPage,
  pageRequestFromRelay,
  pageResponseToRelay,
} from "../shared/messages";

declare global {
  interface Window {
    __noteesConnectorBridgeInstalled?: boolean;
  }
}

function install(): void {
  // background → page
  browser.runtime.onMessage.addListener((msg: RelayToPage) => {
    if (msg?.source !== SOURCE || msg.type !== "relay-to-page") return;
    const request = pageRequestFromRelay(msg);
    // targetOrigin is this page's own origin: the script only runs in serverUrl tabs
    window.postMessage(request, window.location.origin);
  });

  // page → background
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data as PageCaptureResponse;
    if (data?.source !== SOURCE || data.type !== "notees-capture-response") return;
    void browser.runtime.sendMessage(pageResponseToRelay(data));
  });
}

// Idempotent: ensureBridge may inject into the same tab repeatedly.
if (!window.__noteesConnectorBridgeInstalled) {
  window.__noteesConnectorBridgeInstalled = true;
  install();
}
```

- [ ] Write `test/content/bridge.test.ts` (jsdom; verifies both directions and the origin guard):

```ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";

async function importBridge() {
  // fresh module per test so the install guard re-runs
  vi.resetModules();
  return import("../../src/content/bridge");
}

describe("content bridge", () => {
  it("forwards relay-to-page runtime messages to the page as notees-capture-request", async () => {
    const sent: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data) => sent.push(data));
    await importBridge();
    const listener = fakeBrowser.runtime.onMessage.listeners[0] as (msg: unknown) => void;
    listener({
      source: "notees-connector",
      type: "relay-to-page",
      requestId: "r1",
      payload: { url: "https://example.com/a", title: "A", mode: "readlater" },
    });
    expect(sent).toEqual([
      {
        source: "notees-connector",
        type: "notees-capture-request",
        requestId: "r1",
        payload: { url: "https://example.com/a", title: "A", mode: "readlater" },
      },
    ]);
  });

  it("forwards page notees-capture-response messages to the background as relay-from-page", async () => {
    const spy = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(undefined as never);
    await importBridge();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: window.location.origin,
        data: {
          source: "notees-connector",
          type: "notees-capture-response",
          requestId: "r2",
          ok: false,
          error: { code: "not_authenticated", message: "no session" },
        },
      }),
    );
    expect(spy).toHaveBeenCalledWith({
      source: "notees-connector",
      type: "relay-from-page",
      requestId: "r2",
      ok: false,
      error: { code: "not_authenticated", message: "no session" },
    });
  });

  it("ignores foreign messages", async () => {
    const spy = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(undefined as never);
    await importBridge();
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: window.location.origin,
        data: { source: "evil", type: "notees-capture-response", requestId: "x", ok: true, objectId: "y" },
      }),
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("installs only once", async () => {
    await importBridge();
    const count = fakeBrowser.runtime.onMessage.listeners.length;
    await importBridge();
    expect(fakeBrowser.runtime.onMessage.listeners.length).toBe(count);
  });
});
```

- [ ] If `fakeBrowser.runtime.onMessage.listeners` is not exposed in the installed version, fall back to capturing the listener via `vi.spyOn(fakeBrowser.runtime.onMessage, "addListener")` and invoking the captured callback directly. Keep whichever works pinned in this test.
- [ ] `pnpm test && pnpm typecheck` green.

---

### Task 8: Relay client (background side, with timeout)

**Files**
- Create: `src/background/relay.ts`
- Create: `test/background/relay.test.ts`

**Interfaces**
- Consumes: `browser.tabs.sendMessage(tabId, RelayToPage)`; `browser.runtime.onMessage` for `RelayFromPage` (Task 2 shapes).
- Produces: `captureViaRelay(tabId, payload): Promise<CaptureOutcome>`.

**Steps**

- [ ] Write `src/background/relay.ts`:

```ts
import browser from "webextension-polyfill";
import { SOURCE } from "../shared/source";
import { CaptureOutcome, CapturePayload } from "../shared/capture-types";
import { RelayFromPage, RelayToPage } from "../shared/messages";

export const RELAY_TIMEOUT_MS = 15000;

export async function captureViaRelay(tabId: number, payload: CapturePayload): Promise<CaptureOutcome> {
  const requestId = crypto.randomUUID();
  return new Promise<CaptureOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: CaptureOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.runtime.onMessage.removeListener(listener);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: { code: "failed", message: "The Notees tab did not answer" } });
    }, RELAY_TIMEOUT_MS);

    const listener = (msg: RelayFromPage) => {
      if (msg?.source !== SOURCE || msg.type !== "relay-from-page" || msg.requestId !== requestId) return;
      finish(msg.ok
        ? { ok: true, transport: "tab-relay", objectId: msg.objectId }
        : { ok: false, error: msg.error });
    };
    browser.runtime.onMessage.addListener(listener);

    const message: RelayToPage = { source: SOURCE, type: "relay-to-page", requestId, payload };
    browser.tabs.sendMessage(tabId, message).catch(() => {
      finish({ ok: false, error: { code: "failed", message: "Could not reach the Notees tab" } });
    });
  });
}
```

- [ ] Write `test/background/relay.test.ts` (uses fake timers for the timeout case and a captured onMessage listener for the happy path):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import browser from "webextension-polyfill";
import { fakeBrowser } from "@webext-core/fake-browser";
import { RELAY_TIMEOUT_MS, captureViaRelay } from "../../src/background/relay";

const payload = { url: "https://example.com/a", title: "A", mode: "source" as const };

function captureListener() {
  let listener: ((msg: unknown) => void) | undefined;
  vi.spyOn(fakeBrowser.runtime.onMessage, "addListener").mockImplementation((fn) => {
    listener = fn as (msg: unknown) => void;
  });
  return (msg: unknown) => {
    if (!listener) throw new Error("no listener registered");
    listener(msg);
  };
}

afterEach(() => vi.restoreAllMocks());

describe("captureViaRelay", () => {
  it("resolves ok on relay-from-page ok", async () => {
    const emit = captureListener();
    vi.spyOn(browser.tabs, "sendMessage").mockResolvedValue(undefined as never);
    const promise = captureViaRelay(3, payload);
    emit({ source: "notees-connector", type: "relay-from-page", requestId: expect.any(String), ok: true, objectId: "obj-7" });
    const sent = vi.mocked(browser.tabs.sendMessage).mock.calls[0][1] as { requestId: string };
    emit({ source: "notees-connector", type: "relay-from-page", requestId: sent.requestId, ok: true, objectId: "obj-7" });
    expect(await promise).toEqual({ ok: true, transport: "tab-relay", objectId: "obj-7" });
  });

  it("resolves failure on relay-from-page error (e.g. logged-out tab)", async () => {
    const emit = captureListener();
    vi.spyOn(browser.tabs, "sendMessage").mockResolvedValue(undefined as never);
    const promise = captureViaRelay(3, payload);
    const sent = vi.mocked(browser.tabs.sendMessage).mock.calls[0][1] as { requestId: string };
    emit({ source: "notees-connector", type: "relay-from-page", requestId: sent.requestId, ok: false, error: { code: "not_authenticated", message: "no session" } });
    expect(await promise).toEqual({ ok: false, error: { code: "not_authenticated", message: "no session" } });
  });

  it("times out when the page never answers", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(browser.tabs, "sendMessage").mockResolvedValue(undefined as never);
      const promise = captureViaRelay(3, payload);
      vi.advanceTimersByTime(RELAY_TIMEOUT_MS + 1);
      expect(await promise).toEqual({ ok: false, error: { code: "failed", message: "The Notees tab did not answer" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails cleanly when sendMessage rejects (tab navigated away)", async () => {
    vi.spyOn(browser.tabs, "sendMessage").mockRejectedValue(new Error("no receiver") as never);
    expect(await captureViaRelay(3, payload)).toEqual({ ok: false, error: { code: "failed", message: "Could not reach the Notees tab" } });
  });
});
```

- [ ] `pnpm test && pnpm typecheck` green.

---

### Task 9: DOI / ISBN meta extraction

**Files**
- Create: `src/capture/extract-in-page.ts`
- Create: `test/capture/extract-in-page.test.ts`

**Interfaces**
- Produces:
```ts
export function extractInPage(): { doi?: string; isbn?: string }; // fully self-contained — no module-scope references
export function normalizeDoi(raw: string): string | null;
export async function extractIdentifiers(tabId: number): Promise<CaptureIdentifiers>; // background helper, executeScript-based
```
- `extractInPage` is stringified into `browser.tabs.executeScript({ code })` — it may only reference its own locals and `document`.

**Steps**

- [ ] Write `src/capture/extract-in-page.ts`:

```ts
import browser from "webextension-polyfill";
import { CaptureIdentifiers } from "../shared/capture-types";

/**
 * Normalizes "doi:10.1234/foo", "https://doi.org/10.1234/foo",
 * "http://dx.doi.org/10.1234/foo", or a bare "10.1234/foo" to "10.1234/foo".
 * Returns null when the value is not DOI-shaped (e.g. an ISBN in dc.identifier).
 */
export function normalizeDoi(raw: string): string | null {
  const withPrefix = raw.match(/(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\S+)/i);
  if (withPrefix) return withPrefix[1].replace(/[.;,]+$/, "");
  const bare = raw.match(/^(10\.\d{4,9}\/\S+)$/i);
  return bare ? bare[1].replace(/[.;,]+$/, "") : null;
}

/**
 * Self-contained page-side extractor. Runs via executeScript code-string:
 * it must not reference anything outside its own body (no imports, no closures).
 */
export function extractInPage(): { doi?: string; isbn?: string } {
  const contentOf = (names: string[]): string | null => {
    for (const name of names) {
      const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
      const content = el?.getAttribute("content")?.trim();
      if (content) return content;
    }
    return null;
  };
  const stripDoi = (raw: string): string | null => {
    const withPrefix = raw.match(/(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\S+)/i);
    if (withPrefix) return withPrefix[1].replace(/[.;,]+$/, "");
    const bare = raw.match(/^(10\.\d{4,9}\/\S+)$/i);
    return bare ? bare[1].replace(/[.;,]+$/, "") : null;
  };
  const out: { doi?: string; isbn?: string } = {};
  const doiRaw = contentOf(["citation_doi", "dc.identifier", "DC.Identifier", "prism.doi"]);
  if (doiRaw) {
    const doi = stripDoi(doiRaw);
    if (doi) out.doi = doi;
  }
  const isbn = contentOf(["citation_isbn"]);
  if (isbn) out.isbn = isbn;
  return out;
}

/** Runs the extractor in the tab; any failure (absent meta, restricted page) → {}. */
export async function extractIdentifiers(tabId: number): Promise<CaptureIdentifiers> {
  try {
    const results = (await browser.tabs.executeScript(tabId, {
      code: `(${extractInPage.toString()})()`,
    })) as { doi?: string; isbn?: string }[] | undefined;
    return results?.[0] ?? {};
  } catch {
    return {}; // Review Focus #4: absent DOI must never fail the capture
  }
}
```

- [ ] Write `test/capture/extract-in-page.test.ts` (jsdom; Review Focus #4):

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractInPage, normalizeDoi } from "../../src/capture/extract-in-page";

describe("normalizeDoi", () => {
  it.each([
    ["10.1234/foo.bar", "10.1234/foo.bar"],
    ["doi:10.1234/foo.bar", "10.1234/foo.bar"],
    ["https://doi.org/10.1234/foo.bar", "10.1234/foo.bar"],
    ["http://dx.doi.org/10.1234/foo.bar.", "10.1234/foo.bar"],
  ])("%s → %s", (raw, expected) => expect(normalizeDoi(raw)).toBe(expected));
  it.each([["9780123456789"], ["urn:isbn:9780123456789"], ["not-a-doi"]])("%s → null", (raw) =>
    expect(normalizeDoi(raw)).toBeNull(),
  );
});

describe("extractInPage", () => {
  it("reads citation_doi", () => {
    document.head.innerHTML = `<meta name="citation_doi" content="doi:10.1234/foo">`;
    expect(extractInPage()).toEqual({ doi: "10.1234/foo" });
  });
  it("falls back to dc.identifier when citation_doi is absent", () => {
    document.head.innerHTML = `<meta name="dc.identifier" content="https://doi.org/10.5555/abc">`;
    expect(extractInPage()).toEqual({ doi: "10.5555/abc" });
  });
  it("ignores non-DOI dc.identifier values and collects citation_isbn", () => {
    document.head.innerHTML = `
      <meta name="dc.identifier" content="9780123456789">
      <meta name="citation_isbn" content="9780123456786">`;
    expect(extractInPage()).toEqual({ isbn: "9780123456786" });
  });
  it("returns {} when no meta tags exist", () => {
    document.head.innerHTML = "";
    expect(extractInPage()).toEqual({});
  });
  // Pin the executeScript contract: this function is stringified into a page
  // via `(${extractInPage.toString()})()` — it must not reference module scope.
  it("is self-contained when stringified (no imports/closures)", () => {
    const src = extractInPage.toString();
    expect(src).not.toMatch(/\bimport\b|\brequire\b|\bexport\b|__vite/);
  });
});
```

- [ ] `pnpm test && pnpm typecheck` green. Note the deliberate duplication of the DOI regex inside `extractInPage`: it must stay self-contained — add a comment in the test pinning that constraint, and a test asserting `extractInPage.toString()` contains no import identifiers.

---

### Task 10: Transport selection state machine

**Files**
- Create: `src/background/transport.ts`
- Create: `test/background/transport.test.ts`

**Interfaces**
- Consumes: `findNoteesTab`, `ensureBridge` (Task 6); `captureViaRelay` (Task 8); `captureViaRest` (Task 5); `ConnectorSettings`, `CapturePayload`, `CaptureOutcome` (Task 2).
- Produces:
```ts
export async function selectTransport(settings: ConnectorSettings): Promise<"tab-relay" | "rest">;
export async function captureWithTransport(settings: ConnectorSettings, payload: CapturePayload): Promise<CaptureOutcome>;
```

**Steps**

- [ ] Write `src/background/transport.ts`:

```ts
import { CaptureOutcome, CapturePayload } from "../shared/capture-types";
import { ConnectorSettings } from "../shared/settings";
import { captureViaRest } from "./rest-client";
import { captureViaRelay } from "./relay";
import { ensureBridge, findNoteesTab } from "./tabs";

export type Transport = "tab-relay" | "rest";

/**
 * Per-capture transport selection:
 *  1. Notees tab open (origin === serverUrl) → tab relay (zero credentials, E2EE-safe).
 *  2. Else direct REST.
 */
export async function selectTransport(settings: ConnectorSettings): Promise<Transport> {
  if (settings.serverUrl && (await findNoteesTab(settings.serverUrl))) return "tab-relay";
  return "rest";
}

export async function captureWithTransport(
  settings: ConnectorSettings,
  payload: CapturePayload,
): Promise<CaptureOutcome> {
  const tab = settings.serverUrl ? await findNoteesTab(settings.serverUrl) : null;
  if (tab?.id != null) {
    try {
      await ensureBridge(tab.id);
      const outcome = await captureViaRelay(tab.id, payload);
      if (outcome.ok) return outcome;
      // not_authenticated / feature_disabled are final; "failed" falls through to REST
      if (outcome.error.code !== "failed") return outcome;
    } catch {
      // bridge/relay blew up — fall through to REST
    }
  }
  if (!settings.apiKey) {
    return { ok: false, error: { code: "not_authenticated", message: "Open Notees or add an API key in the connector settings" } };
  }
  return captureViaRest(settings, payload);
}
```

- [ ] Write `test/background/transport.test.ts` (module mocks; covers Review Focus #2 and #3):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorSettings } from "../../src/shared/settings";

vi.mock("../../src/background/tabs", () => ({
  findNoteesTab: vi.fn(),
  ensureBridge: vi.fn(),
}));
vi.mock("../../src/background/relay", () => ({ captureViaRelay: vi.fn() }));
vi.mock("../../src/background/rest-client", () => ({ captureViaRest: vi.fn() }));

import { captureWithTransport } from "../../src/background/transport";
import { findNoteesTab, ensureBridge } from "../../src/background/tabs";
import { captureViaRelay } from "../../src/background/relay";
import { captureViaRest } from "../../src/background/rest-client";

const settings = (over: Partial<ConnectorSettings> = {}): ConnectorSettings => ({
  serverUrl: "https://host.example",
  apiKey: "nk_test",
  features: { bibliography: true, readLater: true },
  ...over,
});
const payload = { url: "https://example.com/a", title: "A", mode: "source" as const };

beforeEach(() => vi.clearAllMocks());

describe("captureWithTransport", () => {
  it("Notees tab open → relay; success returns without touching REST", async () => {
    vi.mocked(findNoteesTab).mockResolvedValue({ id: 5 } as never);
    vi.mocked(captureViaRelay).mockResolvedValue({ ok: true, transport: "tab-relay", objectId: "o1" });
    expect(await captureWithTransport(settings(), payload)).toEqual({ ok: true, transport: "tab-relay", objectId: "o1" });
    expect(ensureBridge).toHaveBeenCalledWith(5);
    expect(captureViaRest).not.toHaveBeenCalled();
  });
  it("logged-out tab → not_authenticated is final (no REST fallback)", async () => {
    vi.mocked(findNoteesTab).mockResolvedValue({ id: 5 } as never);
    vi.mocked(captureViaRelay).mockResolvedValue({ ok: false, error: { code: "not_authenticated", message: "no session" } });
    const out = await captureWithTransport(settings(), payload);
    expect(out).toEqual({ ok: false, error: { code: "not_authenticated", message: "no session" } });
    expect(captureViaRest).not.toHaveBeenCalled();
  });
  it("relay generic failure → falls back to REST", async () => {
    vi.mocked(findNoteesTab).mockResolvedValue({ id: 5 } as never);
    vi.mocked(captureViaRelay).mockResolvedValue({ ok: false, error: { code: "failed", message: "tab did not answer" } });
    vi.mocked(captureViaRest).mockResolvedValue({ ok: true, transport: "rest", objectId: "o2" });
    expect(await captureWithTransport(settings(), payload)).toEqual({ ok: true, transport: "rest", objectId: "o2" });
  });
  it("offline, no tab, has key → REST outcome (network_error) passes through", async () => {
    vi.mocked(findNoteesTab).mockResolvedValue(null);
    vi.mocked(captureViaRest).mockResolvedValue({ ok: false, error: { code: "network_error", message: "Could not reach the Notees server" } });
    expect(await captureWithTransport(settings(), payload)).toEqual({ ok: false, error: { code: "network_error", message: "Could not reach the Notees server" } });
  });
  it("no tab and no API key → not_authenticated without calling REST", async () => {
    vi.mocked(findNoteesTab).mockResolvedValue(null);
    const out = await captureWithTransport(settings({ apiKey: "" }), payload);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe("not_authenticated");
    expect(captureViaRest).not.toHaveBeenCalled();
  });
  it("no serverUrl configured at all → straight to REST path guard", async () => {
    vi.mocked(findNoteesTab).mockResolvedValue(null);
    const out = await captureWithTransport(settings({ serverUrl: "" }), payload);
    expect(out.ok).toBe(false);
    expect(findNoteesTab).not.toHaveBeenCalled();
  });
});
```

- [ ] `pnpm test && pnpm typecheck` green.

---

### Task 11: User notifications

**Files**
- Create: `src/background/notify.ts`
- Create: `test/background/notify.test.ts`

**Interfaces**
- Consumes: `CaptureFailure` (Task 2).
- Produces:
```ts
export async function notify(title: string, message: string): Promise<void>;
export async function notifyFailure(error: CaptureFailure): Promise<void>; // maps codes → copy
```

**Steps**

- [ ] Write `src/background/notify.ts`:

```ts
import browser from "webextension-polyfill";
import { CaptureFailure } from "../shared/capture-types";

const ICON_URL = browser.runtime.getURL("icons/icon.svg");

export async function notify(title: string, message: string): Promise<void> {
  await browser.notifications.create({ type: "basic", iconUrl: ICON_URL, title, message });
}

const COPY: Record<CaptureFailure["code"], [string, string]> = {
  e2ee_required: [
    "Open Notees to capture",
    "This workspace is end-to-end encrypted, so the extension cannot write to it directly. Open your Notees tab and capture again — the tab relay keeps everything encrypted.",
  ],
  not_authenticated: [
    "Notees is not signed in",
    "Sign in to the open Notees tab, or add an API key in the connector settings, then try again.",
  ],
  feature_disabled: [
    "Feature not enabled",
    "Enable bibliography capture or read-it-later in your Notees workspace settings.",
  ],
  network_error: [
    "Notees server unreachable",
    "Check the server URL and your network connection in the connector settings.",
  ],
  http_error: ["Notees capture failed", "The server returned an unexpected error."],
  failed: ["Notees capture failed", "Something went wrong while capturing this page."],
};

export async function notifyFailure(error: CaptureFailure): Promise<void> {
  const [title, message] = COPY[error.code] ?? COPY.failed;
  await notify(title, `${message}${error.message ? ` (${error.message})` : ""}`);
}
```

- [ ] Write `test/background/notify.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";
import { notifyFailure } from "../../src/background/notify";

describe("notifyFailure", () => {
  it("409 e2ee_required → 'open Notees' guidance", async () => {
    const spy = vi.spyOn(fakeBrowser.notifications, "create").mockResolvedValue("n1" as never);
    await notifyFailure({ code: "e2ee_required", message: "E2EE workspace" });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "basic", title: "Open Notees to capture" }),
    );
    expect(spy.mock.calls[0][0].message).toContain("Open your Notees tab");
  });
  it("network_error → server-unreachable guidance", async () => {
    const spy = vi.spyOn(fakeBrowser.notifications, "create").mockResolvedValue("n2" as never);
    await notifyFailure({ code: "network_error", message: "Could not reach the Notees server" });
    expect(spy.mock.calls[0][0].title).toBe("Notees server unreachable");
  });
  it("not_authenticated → sign-in guidance", async () => {
    const spy = vi.spyOn(fakeBrowser.notifications, "create").mockResolvedValue("n3" as never);
    await notifyFailure({ code: "not_authenticated", message: "no session" });
    expect(spy.mock.calls[0][0].title).toBe("Notees is not signed in");
  });
});
```

- [ ] `pnpm test && pnpm typecheck` green.

---

### Task 12: Toolbar button + context menus + keyboard shortcut + wiring

**Files**
- Create: `src/background/menus.ts`
- Create: `src/background/capture-command.ts`
- Modify: `src/background/index.ts` (full rewrite)
- Create: `test/background/menus.test.ts`
- Create: `test/background/capture-command.test.ts`

**Interfaces**
- Consumes: everything from Tasks 2–11; `browser.browserAction.onClicked`, `browser.contextMenus.onClicked`, `browser.storage.onChanged`; settings-changed internal message `{ source, type: "settings-changed", features }` from the options page (Task 3).
- Produces:
```ts
export const MENU_SOURCE_ID = "notees-capture-source";
export const MENU_READLATER_ID = "notees-capture-readlater";
export function buildMenus(features: { bibliography: boolean; readLater: boolean }): void;
export async function performCapture(mode: CaptureMode, tab: browser.tabs.Tab, settings: ConnectorSettings): Promise<void>;
```

**Steps**

- [ ] Write `src/background/menus.ts`:

```ts
import browser from "webextension-polyfill";

export const MENU_SOURCE_ID = "notees-capture-source";
export const MENU_READLATER_ID = "notees-capture-readlater";

/** (Re)build context menus from the feature toggles. */
export function buildMenus(features: { bibliography: boolean; readLater: boolean }): void {
  void browser.contextMenus.removeAll().then(() => {
    if (features.bibliography) {
      browser.contextMenus.create({
        id: MENU_SOURCE_ID,
        title: "Save to bibliography",
        contexts: ["page", "link"],
      });
    }
    if (features.readLater) {
      browser.contextMenus.create({
        id: MENU_READLATER_ID,
        title: "Read later",
        contexts: ["page", "link"],
      });
    }
  });
}
```

- [ ] Write `src/background/capture-command.ts`:

```ts
import browser from "webextension-polyfill";
import { CaptureMode, CapturePayload } from "../shared/capture-types";
import { ConnectorSettings } from "../shared/settings";
import { extractIdentifiers } from "../capture/extract-in-page";
import { captureWithTransport } from "./transport";
import { notify, notifyFailure } from "./notify";

function titleOf(tab: browser.tabs.Tab): string {
  return tab.title?.trim() || tab.url || "Untitled page";
}

/**
 * One capture request end to end: DOI/ISBN enrichment (REST path only),
 * transport selection, success/failure notification.
 */
export async function performCapture(
  mode: CaptureMode,
  tab: browser.tabs.Tab,
  settings: ConnectorSettings,
): Promise<void> {
  if (!tab.id || !tab.url) return;
  const enabled = mode === "source" ? settings.features.bibliography : settings.features.readLater;
  if (!enabled) {
    await notify("Feature not enabled", "Turn this feature on in the connector settings.");
    return;
  }
  const identifiers = mode === "source" ? await extractIdentifiers(tab.id) : {};
  const payload: CapturePayload = {
    url: tab.url,
    title: titleOf(tab),
    mode,
    // REST-only enrichment; key omitted entirely when nothing was found
    ...(Object.keys(identifiers).length ? { identifiers } : {}),
  };
  const outcome = await captureWithTransport(settings, payload);
  if (outcome.ok) {
    await notify(
      mode === "source" ? "Saved to bibliography" : "Saved to Read later",
      `${payload.title} — ${payload.url}`,
    );
  } else {
    await notifyFailure(outcome.error);
  }
}
```

- [ ] Write `src/background/index.ts`:

```ts
import browser from "webextension-polyfill";
import { SOURCE } from "../shared/source";
import { CaptureMode } from "../shared/capture-types";
import { ConnectorSettings, loadSettings } from "../shared/settings";
import { buildMenus, MENU_READLATER_ID, MENU_SOURCE_ID } from "./menus";
import { performCapture } from "./capture-command";

async function currentSettings(): Promise<ConnectorSettings> {
  return loadSettings();
}

async function activeTab(): Promise<browser.tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function captureDefault(tab: browser.tabs.Tab | undefined): Promise<void> {
  if (!tab) return;
  const settings = await currentSettings();
  const mode: CaptureMode = settings.features.bibliography ? "source" : "readlater";
  await performCapture(mode, tab, settings);
}

// Toolbar button + Ctrl+Alt+S (commands._execute_browser_action).
browser.browserAction.onClicked.addListener((tab) => void captureDefault(tab));

// Context menus.
browser.runtime.onInstalled.addListener(() => {
  void currentSettings().then((s) => buildMenus(s.features));
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings?.newValue) {
    buildMenus((changes.settings.newValue as ConnectorSettings).features);
  }
});
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  const mode: CaptureMode | null =
    info.menuItemId === MENU_SOURCE_ID ? "source"
    : info.menuItemId === MENU_READLATER_ID ? "readlater"
    : null;
  if (!mode) return;
  // "link" context: capture the link target instead of the page
  const target = info.linkUrl ? { ...tab, url: info.linkUrl, title: info.linkText ?? tab.title } : tab;
  void currentSettings().then((s) => performCapture(mode, target, s));
});

// Options page nudge (storage.onChanged covers persistence; this wakes a sleeping background).
browser.runtime.onMessage.addListener((msg: { source?: string; type?: string; features?: ConnectorSettings["features"] }) => {
  if (msg?.source === SOURCE && msg.type === "settings-changed" && msg.features) {
    buildMenus(msg.features);
  }
});
```

- [ ] Write `test/background/menus.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "@webext-core/fake-browser";
import { buildMenus, MENU_READLATER_ID, MENU_SOURCE_ID } from "../../src/background/menus";

beforeEach(() => fakeBrowser.reset());

describe("buildMenus", () => {
  it("creates both entries when both toggles are on", async () => {
    const create = vi.spyOn(fakeBrowser.contextMenus, "create").mockReturnValue(1 as never);
    buildMenus({ bibliography: true, readLater: true });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const ids = create.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual([MENU_SOURCE_ID, MENU_READLATER_ID]);
    expect(create.mock.calls[0][0]).toMatchObject({ title: "Save to bibliography", contexts: ["page", "link"] });
    expect(create.mock.calls[1][0]).toMatchObject({ title: "Read later", contexts: ["page", "link"] });
  });
  it("omits the bibliography entry when the toggle is off", async () => {
    const create = vi.spyOn(fakeBrowser.contextMenus, "create").mockReturnValue(1 as never);
    buildMenus({ bibliography: false, readLater: true });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect((create.mock.calls[0][0] as { id: string }).id).toBe(MENU_READLATER_ID);
  });
});
```

- [ ] Write `test/background/capture-command.test.ts` (Review Focus #2 and #4 through the orchestration layer):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { browser } from "webextension-polyfill";
import type { ConnectorSettings } from "../../src/shared/settings";

vi.mock("../../src/background/transport", () => ({ captureWithTransport: vi.fn() }));
vi.mock("../../src/background/notify", () => ({ notify: vi.fn(), notifyFailure: vi.fn() }));
vi.mock("../../src/capture/extract-in-page", () => ({ extractIdentifiers: vi.fn() }));

import { performCapture } from "../../src/background/capture-command";
import { captureWithTransport } from "../../src/background/transport";
import { notify, notifyFailure } from "../../src/background/notify";
import { extractIdentifiers } from "../../src/capture/extract-in-page";

const settings: ConnectorSettings = {
  serverUrl: "https://host.example",
  apiKey: "nk_test",
  features: { bibliography: true, readLater: true },
};
const tab = { id: 9, url: "https://example.com/paper", title: "A paper" } as browser.tabs.Tab;

beforeEach(() => vi.clearAllMocks());

describe("performCapture (source mode)", () => {
  it("attaches DOI identifiers and notifies on success", async () => {
    vi.mocked(extractIdentifiers).mockResolvedValue({ doi: "10.1234/foo" });
    vi.mocked(captureWithTransport).mockResolvedValue({ ok: true, transport: "rest", objectId: "o1" });
    await performCapture("source", tab, settings);
    expect(captureWithTransport).toHaveBeenCalledWith(settings, {
      url: "https://example.com/paper",
      title: "A paper",
      mode: "source",
      identifiers: { doi: "10.1234/foo" },
    });
    expect(notify).toHaveBeenCalledWith("Saved to bibliography", expect.stringContaining("A paper"));
  });
  it("omits the identifiers key when no DOI/ISBN meta was found", async () => {
    vi.mocked(extractIdentifiers).mockResolvedValue({});
    vi.mocked(captureWithTransport).mockResolvedValue({ ok: true, transport: "rest", objectId: "o1" });
    await performCapture("source", tab, settings);
    expect(captureWithTransport).toHaveBeenCalledWith(settings, {
      url: "https://example.com/paper",
      title: "A paper",
      mode: "source",
    });
  });
  it("capture failure maps to notifyFailure", async () => {
    vi.mocked(extractIdentifiers).mockResolvedValue({});
    vi.mocked(captureWithTransport).mockResolvedValue({ ok: false, error: { code: "e2ee_required", message: "E2EE" } });
    await performCapture("source", tab, settings);
    expect(notifyFailure).toHaveBeenCalledWith({ code: "e2ee_required", message: "E2EE" });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("performCapture (readlater mode)", () => {
  it("skips DOI extraction (identifiers are REST+source only) — no identifiers key at all", async () => {
    vi.mocked(captureWithTransport).mockResolvedValue({ ok: true, transport: "tab-relay", objectId: "o2" });
    await performCapture("readlater", tab, settings);
    expect(extractIdentifiers).not.toHaveBeenCalled();
    expect(captureWithTransport).toHaveBeenCalledWith(settings, {
      url: "https://example.com/paper",
      title: "A paper",
      mode: "readlater",
    });
  });
  it("notifies when the feature toggle is off, without capturing", async () => {
    await performCapture("readlater", tab, { ...settings, features: { bibliography: true, readLater: false } });
    expect(captureWithTransport).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Feature not enabled", expect.any(String));
  });
});
```

- [ ] `pnpm test && pnpm typecheck` green. Note: the readlater test asserts the payload has **no `identifiers` key** — keep `capture-command.ts` spreading `extractIdentifiers` directly so this stays true.

---

### Task 13: Build, package (unsigned XPI), README

**Files**
- Create: `/root/projects/notees-connector/README.md`
- Modify: `package.json` (pin engines; verify scripts from Task 1 still correct)
- Create: `test/build-output.test.ts`

**Interfaces**
- Produces: `web-ext-artifacts/notees_connector-0.1.0.zip` (unsigned XPI) via `pnpm pack`.

**Steps**

- [ ] Write `test/build-output.test.ts` — pins the contract between vite output and manifest references (a rename would silently ship a broken extension):

```ts
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  execSync("pnpm build", { stdio: "inherit" });
});

describe("built extension", () => {
  it("manifest references files that exist in dist/", () => {
    const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
    for (const script of manifest.background.scripts) {
      expect(existsSync(`dist/${script}`), `dist/${script}`).toBe(true);
    }
    expect(existsSync(`dist/${manifest.options_ui.page}`)).toBe(true);
    expect(existsSync(`dist/${manifest.browser_action.default_icon}`)).toBe(true);
  });
  it("background bundle contains no bare module imports (content-script-safe IIFE)", () => {
    const bg = readFileSync("dist/background.js", "utf8");
    expect(bg).not.toMatch(/^import /m);
  });
  it("content bridge bundle exposes the install guard", () => {
    const bridge = readFileSync("dist/content-bridge.js", "utf8");
    expect(bridge).toContain("__noteesConnectorBridgeInstalled");
  });
});
```

- [ ] `pnpm lint:ext` → `web-ext lint` reports no errors (SVG-icon and unsigned-XPI warnings acceptable; record them in README).
- [ ] `pnpm pack` → verify `web-ext-artifacts/notees_connector-0.1.0.zip` exists; unzip -l shows manifest.json, background.js, content-bridge.js, options.html, icons/icon.svg.
- [ ] Write `README.md`: what it does, install (Firefox → about:debugging → This Firefox → Load Temporary Add-on, or `xpinstall.signatures.required` caveat for persistent unsigned installs), settings walkthrough (server URL, API key minted in Notees settings with `capture.write` scope, feature toggles), transport behavior (tab relay preferred; 409 e2ee_required → open Notees), dev commands (`pnpm dev`, `pnpm start`, `pnpm test`, `pnpm pack`). **No fleet hostnames/IPs** — use `https://<host>` placeholders (Global Constraints).
- [ ] Planned follow-up (documented, not in this slice): PNG icon set (SVG does not render in some OS notification servers), `web-ext sign` for AMO self-distribution, Chrome/MV3 port (non-goal per spec).

---

## Self-review notes

- **Spec coverage:** one generic extension with two toggles ✓ (Tasks 2/3/12); per-capture transport selection with all three normative outcomes ✓ (Tasks 5–10; `e2ee_required` → notification Task 11); tab-relay via postMessage bridge ✓ (Task 7, verbatim request/response shapes); direct REST with scoped key ✓ (Tasks 4/5); DOI from `citation_doi`/`dc.identifier` on the REST path ✓ (Task 9); toolbar/context-menu/shortcut saves ✓ (Task 12); self-distributed XPI via web-ext ✓ (Task 13); URL+title+metadata only, no body capture ✓ (no body access anywhere; extractor touches `<head>` meta only).
- **Placeholder scan:** all code blocks are complete, compilable implementations; no TODO/placeholder markers.
- **Type consistency:** `notees-capture-request` / `notees-capture-response` / `source: "notees-connector"` appear verbatim in `src/shared/messages.ts` and the bridge; internal `relay-to-page` / `relay-from-page` shapes are documented in exactly one place (Task 2) and used identically in Tasks 7, 8, and 12. Failure codes form one union in `CaptureFailureCode` (`not_authenticated` | `feature_disabled` | `e2ee_required` | `network_error` | `http_error` | `failed`); the relay only ever produces the `not_authenticated` | `feature_disabled` | `failed` subset, the REST client maps 401 to `not_authenticated`, and REST-only codes never leak into relay error objects. `CapturePayload.identifiers` is REST-path-only and omitted from the payload when empty.
- **Known ordering coupling:** Task 3's options page imports `probe.ts` created in Task 4; Task 3's test mocks that module, so both tasks stay green in listed order.
