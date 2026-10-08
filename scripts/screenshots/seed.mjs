// Seed a synthetic knowledge workspace into a throwaway Notees v2 sync server
// (see run.sh). Plain creation against a fresh container — run.sh always wipes
// the runtime dir, so no idempotency dance is needed.
//
// Auth is the single-user API key (X-API-Key header; no cookie jar). The
// system class/property UUIDs below are the fixed seeds from
// packages/domain/src/seeds.ts (HARD RULE: never regenerated) — copied here so
// the script stays free of workspace-package dependencies.

const BASE = (process.env.API_URL ?? "http://localhost:8477").replace(/\/$/, "");
const API_KEY = process.env.API_KEY;
if (!API_KEY) throw new Error("API_KEY env var required");

// --- fixed system seeds (packages/domain/src/seeds.ts) ----------------------
const CLS = {
  source: "00000000-0000-0000-0001-000000000023",
  book: "00000000-0000-0000-0001-000000000024",
  paper: "00000000-0000-0000-0001-000000000025",
  agent: "00000000-0000-0000-0001-000000000029",
  person: "00000000-0000-0000-0001-000000000030",
  asset: "00000000-0000-0000-0001-000000000009",
  whiteboard: "00000000-0000-0000-0001-000000000010",
  card: "00000000-0000-0000-0001-000000000011",
};
const PROP = {
  attachments: "00000000-0000-0000-0000-000000000011",
  authors: "00000000-0000-0000-0000-000000000012",
  isbn: "00000000-0000-0000-0000-000000000013",
  publisher: "00000000-0000-0000-0000-000000000016",
  givenName: "00000000-0000-0000-0000-000000000021",
  familyName: "00000000-0000-0000-0000-000000000022",
  citekey: "00000000-0000-0000-0000-000000000023",
};

// --- tiny API client ---------------------------------------------------------
async function api(pathname, { method = "GET", body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { "content-type": "application/json", "x-api-key": API_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

/** POST /objects → id. Parented blocks carry parentId + a content token stream. */
async function createObject(payload) {
  const { id } = await api("/api/objects", { method: "POST", body: payload });
  return id;
}

async function setProperty(objectId, propertySchemaId, value, idx = 0, metadata) {
  await api(`/api/objects/${objectId}/properties`, {
    method: "POST",
    body: { propertySchemaId, value, idx, ...(metadata !== undefined ? { metadata } : {}) },
  });
}

// --- minimal one-page PDF (the upload pipeline sniffs magic bytes; plain
// text files are rejected — a small real PDF stands in for the notes file) ---
function minimalPdf(lines) {
  const content =
    "BT /F1 11 Tf 54 738 Td 16 TL\n" +
    lines.map((l) => `(${l.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`).join("\n") +
    "\nET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// --- seed --------------------------------------------------------------------
console.log(`seeding ${BASE} ...`);

// People (authors is node-typed to agent; person extends agent).
const kuhnId = await createObject({
  presentAsMain: true,
  name: "Thomas S. Kuhn",
  classIds: [CLS.agent, CLS.person],
});
await setProperty(kuhnId, PROP.givenName, "Thomas");
await setProperty(kuhnId, PROP.familyName, "Kuhn");

const lakatosId = await createObject({
  presentAsMain: true,
  name: "Imre Lakatos",
  classIds: [CLS.agent, CLS.person],
});
await setProperty(lakatosId, PROP.givenName, "Imre");
await setProperty(lakatosId, PROP.familyName, "Lakatos");

const mayaId = await createObject({
  presentAsMain: true,
  name: "Maya Chen",
  classIds: [CLS.agent, CLS.person],
});
await setProperty(mayaId, PROP.givenName, "Maya");
await setProperty(mayaId, PROP.familyName, "Chen");

// Sources: a book and a paper (both classed source + their sub-type).
const kuhnBookId = await createObject({
  presentAsMain: true,
  name: "The Structure of Scientific Revolutions",
  classIds: [CLS.source, CLS.book],
});
await setProperty(kuhnBookId, PROP.authors, { nodeId: kuhnId }, 0);
await setProperty(kuhnBookId, PROP.citekey, "kuhn1962");
await setProperty(kuhnBookId, PROP.publisher, "University of Chicago Press");
await setProperty(kuhnBookId, PROP.isbn, "0226458083");

const lakatosPaperId = await createObject({
  presentAsMain: true,
  name: "Falsification and the Methodology of Scientific Research Programmes",
  classIds: [CLS.source, CLS.paper],
});
await setProperty(lakatosPaperId, PROP.authors, { nodeId: lakatosId }, 0);
await setProperty(lakatosPaperId, PROP.citekey, "lakatos1970");

// Attachment: the web client's flow is upload bytes -> asset-class node ->
// asset.attach (node_asset) -> attachments property ({ nodeId } ref). The
// multipart objectId field performs the attach server-side.
const pdfName = "kuhn-ch3-notes.pdf";
const assetNodeId = await createObject({ presentAsMain: true, name: pdfName, classIds: [CLS.asset] });
const form = new FormData();
form.append("objectId", assetNodeId);
form.append("file", new Blob([minimalPdf([
  "Kuhn - Structure of Scientific Revolutions, ch. 3",
  "The Nature of Normal Science",
  "",
  "- normal science: puzzle solving within a paradigm",
  "- anomalies accumulate; crisis precedes revolution",
  "- reading group notes, 2026-09-24",
])]), pdfName);
const uploadRes = await fetch(`${BASE}/api/assets`, {
  method: "POST",
  headers: { "x-api-key": API_KEY },
  body: form,
});
const upload = await uploadRes.json();
if (!uploadRes.ok) throw new Error(`asset upload -> ${uploadRes.status}: ${JSON.stringify(upload)}`);
await setProperty(kuhnBookId, PROP.attachments, { nodeId: assetNodeId }, 0);
console.log(`asset uploaded: ${upload.assetId} (${pdfName}, ${upload.size} bytes) -> ${assetNodeId}`);

// Meeting note: blocks with marks, a mention chip, a typed-link mark with a
// locator, and a quote token.
const meetingId = await createObject({ presentAsMain: true, name: "Weekly sync · 2026-09-24" });
const blocks = [
  [{ type: "text", text: "Decisions", marks: ["bold"] }],
  [{ type: "text", text: "Ship the citations seed revision before the reading group." }],
  [
    { type: "text", text: "Follow up with " },
    { type: "mention", targetNodeId: mayaId, text: "Maya Chen", linkId: crypto.randomUUID() },
    { type: "text", text: " on the bibliography import pipeline." },
  ],
  [
    { type: "text", text: "Reading group discusses " },
    {
      type: "typed_link",
      verb: "cites",
      text: "Structure of Scientific Revolutions",
      metadata: { locator: "ch. 3" },
    },
    { type: "text", text: " on Thursday — bring the annotated PDF." },
  ],
  [
    {
      type: "quote",
      children: [
        { type: "text", text: "Normal science … is predicated on the assumption that the scientific community knows what the world is like" },
      ],
    },
  ],
];
for (const contentAst of blocks) {
  await createObject({ presentAsMain: false, parentId: meetingId, contentAst });
}

// Reading list: intro + two live query blocks (list of sources; aggregate
// grid counting workspace nodes by type).
const readingListId = await createObject({ presentAsMain: true, name: "Reading list" });
await createObject({
  presentAsMain: false,
  parentId: readingListId,
  contentAst: [{ type: "text", text: "Everything worth reading, kept live by queries." }],
});
await createObject({
  presentAsMain: false,
  parentId: readingListId,
  contentAst: [
    {
      type: "query",
      queryAst: {
        version: 1,
        scope: { type: "entire_workspace" },
        root: { type: "group", logic: "and", children: [{ type: "class", classId: CLS.source }] },
        sort: [{ field: "name", dir: "asc" }],
      },
      view: { mode: "list" },
    },
  ],
});
await createObject({
  presentAsMain: false,
  parentId: readingListId,
  contentAst: [
    {
      type: "query",
      queryAst: {
        version: 1,
        scope: { type: "entire_workspace" },
        root: { type: "group", logic: "and", children: [] },
        aggregation: { dimensions: [{ kind: "isClass" }], measures: [{ function: "count" }] },
      },
    },
  ],
});

// Whiteboard: page classed whiteboard with a whiteboard token (cards are child
// blocks, geometry keyed by node id; shapes/strokes are layout-only). Blocks
// are parented to the page (the render bit unset = inline body), so the page
// comes first and the layout references the card ids created under it.
const whiteboardId = await createObject({
  presentAsMain: true,
  name: "Research whiteboard",
  classIds: [CLS.whiteboard],
});
const wbCards = [
  { name: "Paradigm shift", text: "Incommensurable frameworks", x: 60, y: 60, w: 260, h: 110 },
  { name: "Normal science", text: "Puzzle solving inside a paradigm", x: 430, y: 70, w: 260, h: 110 },
  { name: "Anomaly detection", text: "Crises accumulate", x: 230, y: 290, w: 280, h: 110 },
];
const cards = {};
for (const card of wbCards) {
  const id = await createObject({
    presentAsMain: false,
    parentId: whiteboardId,
    name: card.name,
    classIds: [CLS.card],
    contentAst: [{ type: "text", text: card.text }],
  });
  cards[id] = { x: card.x, y: card.y, w: card.w, h: card.h };
}
await api(`/api/objects/${whiteboardId}`, {
  method: "PATCH",
  body: {
    contentAst: [
      {
        type: "whiteboard",
        layout: {
          cards,
          shapes: [
            { id: crypto.randomUUID(), kind: "rect", x: 40, y: 270, w: 680, h: 160, label: "crisis" },
            { id: crypto.randomUUID(), kind: "ellipse", x: 410, y: 40, w: 300, h: 170 },
            { id: crypto.randomUUID(), kind: "arrow", x: 330, y: 150, w: 130, h: 130, label: "triggers" },
          ],
          strokes: [{ id: crypto.randomUUID(), points: [120, 240, 200, 210, 290, 250, 360, 220] }],
        },
      },
    ],
  },
});

console.log("seeded:", {
  people: [kuhnId, lakatosId, mayaId],
  sources: [kuhnBookId, lakatosPaperId],
  meetingId,
  readingListId,
  whiteboardId,
});
