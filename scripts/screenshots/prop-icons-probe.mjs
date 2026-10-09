// Repro probe for the block-row property-icon layout (bullet/inline display
// positions). Seeds the TEST workspace (never the personal one) with a Task
// class bound to a bullet-display select + an inline-display select, a page
// with a parent block and a wrapping child Task block carrying values + a
// backlink, then dumps the row geometry and screenshots the result.
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const WS = "c491595f-9f94-5ade-a620-e30ed063d8d2";
const SYNC = "http://localhost:8377";
const WEB = process.env.PROBE_BASE ?? "http://localhost:8378";
const API_KEY = readFileSync("../../config/notees/sync/api_key.txt", "utf8").trim();

async function api(pathname, { method = "GET", body } = {}) {
  const res = await fetch(SYNC + pathname, {
    method,
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "x-workspace-id": WS },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
const uuid = () => crypto.randomUUID();

// --- seed (idempotent-ish: fixed probe ids, 409s ignored) -------------------
const estadoId = uuid();
const prioridadId = uuid();
try {
  await api("/api/property-schemas", {
    method: "POST",
    body: {
      propertySchemaId: estadoId,
      name: "Estado",
      type: "select",
      display: "bullet",
      options: [
        { id: "hecho", label: "Hecho", icon: "mdiCheckCircle", color: "green" },
        { id: "pendiente", label: "Pendiente", icon: "mdiClockOutline", color: "yellow" },
      ],
    },
  });
  await api("/api/property-schemas", {
    method: "POST",
    body: {
      propertySchemaId: prioridadId,
      name: "Prioridad",
      type: "select",
      display: "inline",
      options: [
        { id: "alta", label: "Alta", icon: "mdiArrowUpBold", color: "red" },
        { id: "baja", label: "Baja", icon: "mdiArrowDownBold", color: "blue" },
      ],
    },
  });
  const { id: taskClass } = await api("/api/objects", { method: "POST", body: { isClass: true, name: "Task" } });
  await api(`/api/classes/${taskClass}/properties`, { method: "POST", body: { propertySchemaId: estadoId, sequence: 0 } });
  await api(`/api/classes/${taskClass}/properties`, { method: "POST", body: { propertySchemaId: prioridadId, sequence: 1 } });

  const { id: pageId } = await api("/api/objects", { method: "POST", body: { presentAsMain: true, name: "Layout repro — property icons" } });
  const { id: parentBlock } = await api("/api/objects", {
    method: "POST",
    body: { parentId: pageId, contentAst: [{ type: "text", text: "Respuesta recibida, pero falta esta información." }] },
  });
  const { id: childBlock } = await api("/api/objects", {
    method: "POST",
    body: {
      parentId: parentBlock,
      classIds: [taskClass],
      contentAst: [
        { type: "text", text: "Volver a preguntar a James Holder si se puede empezar un proceso de certificación en dedicated estando ya en proceso de certificación 2023/09/28" },
      ],
    },
  });
  await api(`/api/objects/${childBlock}/properties`, { method: "POST", body: { propertySchemaId: estadoId, value: "hecho", idx: 0 } });
  await api(`/api/objects/${childBlock}/properties`, { method: "POST", body: { propertySchemaId: prioridadId, value: "alta", idx: 0 } });
  // A backlink so the right-gutter toggle renders.
  await api("/api/objects", {
    method: "POST",
    body: {
      parentId: pageId,
      contentAst: [
        { type: "text", text: "Follow up: " },
        { type: "mention", targetNodeId: childBlock, text: "Volver a preguntar…", linkId: uuid() },
      ],
    },
  });
  console.log("seeded page:", pageId);
  var pageIdToOpen = pageId;
} catch (err) {
  console.error("seed failed:", err.message);
  process.exit(1);
}

// --- browser -----------------------------------------------------------------
const login = await fetch(`${SYNC}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "miquelroselltarrago@gmail.com", password: process.env.NOTEES_ADMIN_PASSWORD ?? "" }),
});
const loginBody = await login.json();
if (!login.ok) throw new Error(`login -> ${login.status}: ${JSON.stringify(loginBody)}`);
const sessionToken = loginBody.token;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: Number(process.env.PROBE_W ?? 1500), height: 950 } });
const page = await ctx.newPage();
page.on("console", (msg) => console.log("console:", msg.type(), msg.text().slice(0, 200)));
page.on("pageerror", (err) => console.log("pageerror:", String(err).slice(0, 300)));
await page.addInitScript(([url, t, ws]) => {
  localStorage.setItem("notees.serverUrl", url);
  localStorage.setItem("notees.sessionToken", t);
  localStorage.setItem("notees.workspaceId", ws);
}, [SYNC, sessionToken, WS]);
await page.goto(`${WEB}/${pageIdToOpen}`, { waitUntil: "commit", timeout: 60_000 });
await page.waitForTimeout(8000);
await page.screenshot({ path: "/tmp/prop-icons-boot.jpg", type: "jpeg", quality: 90 });
try {
  await page.waitForSelector(".nt-block-row", { timeout: 40_000 });
} catch {
  console.log("no .nt-block-row; body text:", (await page.evaluate(() => document.body.innerText.slice(0, 400))));
  await page.screenshot({ path: "/tmp/prop-icons-boot.jpg", type: "jpeg", quality: 90 });
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(3000);

const geometry = await page.evaluate(() => {
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
  };
  return Array.from(document.querySelectorAll(".nt-block")).map((block) => {
    const row = block.querySelector(":scope > .nt-block-row");
    if (!row) return null;
    const content = row.querySelector(":scope > .nt-block-content");
    const range = document.createRange();
    let firstLine = null;
    if (content) {
      range.selectNodeContents(content);
      firstLine = Array.from(range.getClientRects()).sort((a, b) => a.top - b.top || a.left - b.left)[0] ?? null;
    }
    return {
      text: content?.textContent?.trim().slice(0, 45) ?? null,
      row: r(row),
      grip: r(row.querySelector(":scope > .nt-block-grip")),
      bulletDot: r(row.querySelector(":scope > .nt-block-grip .nt-bullet-dot")),
      bulletIcon: r(row.querySelector(":scope > .nt-block-grip .nt-bullet-icon")),
      bulletProps: r(row.querySelector(":scope > .nt-block-bullet-props")),
      inlineProps: r(row.querySelector(":scope > .nt-block-inline-props")),
      content: r(content),
      contentFirstLine: firstLine
        ? { x: +firstLine.x.toFixed(1), y: +firstLine.y.toFixed(1), h: +firstLine.height.toFixed(1) }
        : null,
      rowEnd: r(row.querySelector(":scope > .nt-block-row-end")),
      blockX: +block.getBoundingClientRect().x.toFixed(1),
    };
  }).filter(Boolean);
});
console.log(JSON.stringify(geometry, null, 1));
await page.screenshot({ path: "/tmp/prop-icons.jpg", type: "jpeg", quality: 90 });
await browser.close();
