// In-page: fetch the server snapshot bytes + init sql.js (the app's own wasm)
// and count node_asset rows — decisive bytes × sql.js test.
import { chromium } from "playwright";

const API = "http://localhost:8377";
const WS = "3b30e070-039b-47bc-ad0d-2440a2f173c5";
const KEY = (await import("node:fs")).readFileSync(
  "/etc/periphery/stacks/notees/config/notees/sync/api_key.txt",
  "utf8",
).trim();

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
const page = await browser.newPage();
page.on("console", (m) => console.log("page:", m.text().slice(0, 200)));

const result = await page.evaluate(async ({ api, ws, key }) => {
  const metaRes = await fetch(`${api}/api/relay/v2/snapshot?workspaceId=${ws}`, { headers: { "x-api-key": key } });
  const meta = await metaRes.json();
  const dataRes = await fetch(`${api}/api/relay/v2/snapshot/data?workspaceId=${ws}`, { headers: { "x-api-key": key } });
  const bytes = new Uint8Array(await dataRes.arrayBuffer());

  const wasmUrl = "/assets/" + (await (await fetch("/sql-wasm-url.txt")).text()).trim();
  return { meta: { id: meta.snapshotId, upToSeq: meta.upToSeq, hasSnapshot: meta.hasSnapshot }, bytes: bytes.length, wasmUrl };
}, { api: API, ws: WS, key: KEY });
console.log("meta+bytes:", JSON.stringify(result));

// find the wasm path from the app bundle instead
const html = await (await fetch("http://localhost:8378/")).text();
const bundleName = /src="\/assets\/(index-[A-Za-z0-9_-]+\.js)"/.exec(html)?.[1];
const bundle = await (await fetch(`http://localhost:8378/assets/${bundleName}`)).text();
const wasmName = /sql-wasm-[A-Za-z0-9_-]+\.wasm/.exec(bundle)?.[0] ?? "sql-wasm.wasm";
console.log("wasm:", wasmName);

const check = await page.evaluate(async ({ api, ws, key, wasm }) => {
  const [{ default: initSqlJs }, metaRes] = await Promise.all([
    import("/assets/sql-js.js").catch(() => ({ default: null })),
    fetch(`${api}/api/relay/v2/snapshot?workspaceId=${ws}`, { headers: { "x-api-key": key } }),
  ]);
  return { hasSqlJsModule: initSqlJs !== null };
}, { api: API, ws: WS, key: KEY, wasm: wasmName });
console.log("sql-js module check:", JSON.stringify(check));
await browser.close();
