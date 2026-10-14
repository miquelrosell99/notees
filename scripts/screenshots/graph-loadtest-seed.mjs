// Stage-3 load-test data management for the graph renderer go/no-go.
// Modes:
//   node graph-loadtest-seed.mjs count   → paginated active-object count (baseline / verify)
//   node graph-loadtest-seed.mjs seed    → 50k object.create envelopes + 25k mention
//                                          edges (contentAst mention tokens), via the
//                                          relay /batch route (the one lawful write
//                                          path — the op log is the only authority).
//                                          Ids land in /tmp/graph-loadtest-probe-ids.json.
//   node graph-loadtest-seed.mjs delete  → permanent object.delete for every seeded
//                                          id (batched), then sample-404 + count verify.
// Auth: the operator API key (config/notees/sync/api_key.txt — the diag-probe
// precedent), X-API-Key on the relay surface. TEST workspace only (law 8).
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "http://localhost:8377";
const RELAY = API + "/api/relay/v2";
const WS = "c491595f-9f94-5ade-a620-e30ed063d8d2"; // test workspace (law 8)
const KEY = readFileSync("/etc/periphery/stacks/notees/config/notees/sync/api_key.txt", "utf8").trim();
const IDS_PATH = "/tmp/graph-loadtest-probe-ids.json";
const BASELINE_PATH = "/tmp/graph-loadtest-baseline.json";
const NODE_COUNT = 50_000;
const EDGE_COUNT = 25_000;
const BATCH = 1000; // relay MAX_BATCH_ENVELOPES

const PROBE_ACTOR = "10ad7e57-0000-7000-8000-000000000001";

function uuidv7(now = Date.now()) {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const t = BigInt(now);
  for (let i = 5; i >= 0; i--) b[i] = Number((t >> BigInt((5 - i) * 8)) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let lastPhysical = 0;
let logical = 0;
function nextHlc() {
  const physical = Date.now();
  if (physical === lastPhysical) logical += 1;
  else {
    lastPhysical = physical;
    logical = 0;
  }
  return { physical, logical };
}

function envelope(objectId, opType, payload) {
  return {
    id: uuidv7(),
    protocolVersion: 3,
    workspaceId: WS,
    actorId: PROBE_ACTOR,
    deviceId: "probe-graph-loadtest",
    client: "agent:loadtest",
    hlc: nextHlc(),
    affectedNodeIds: [objectId],
    opType,
    timestamp: new Date().toISOString(),
    payload,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postBatch(envelopes) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RELAY + "/batch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ envelopes }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 200) {
      const body = await res.json();
      if (body.savedCount !== envelopes.length) {
        throw new Error(`batch saved ${body.savedCount}/${envelopes.length}`);
      }
      return;
    }
    if (res.status === 429 && attempt < 12) {
      console.log(`429 rate-limited, waiting 15s (attempt ${attempt + 1})`);
      await sleep(15_000);
      continue;
    }
    throw new Error(`batch failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

async function countObjects() {
  let cursor = "";
  let total = 0;
  for (;;) {
    const url = `${API}/api/objects?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(url, { headers: { "x-api-key": KEY }, signal: AbortSignal.timeout(120_000) });
    if (res.status !== 200) throw new Error(`count page failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    total += body.objects.length;
    if (body.nextCursor === null || body.objects.length === 0) return total;
    cursor = body.nextCursor;
  }
}

const mode = process.argv[2];

if (mode === "count") {
  const t0 = Date.now();
  const total = await countObjects();
  console.log(`COUNT ${total} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
} else if (mode === "seed") {
  const t0 = Date.now();
  // Mint every id up front so mention targets resolve exactly.
  const ids = Array.from({ length: NODE_COUNT }, () => uuidv7());
  let done = 0;
  for (let start = 0; start < NODE_COUNT; start += BATCH) {
    const envelopes = [];
    for (let i = start; i < Math.min(start + BATCH, NODE_COUNT); i++) {
      const id = ids[i];
      const name = `probe ${String(i).padStart(6, "0")}`;
      let contentAst = [{ type: "text", text: name }];
      if (i < EDGE_COUNT) {
        let target = (i * 7 + 12_345) % NODE_COUNT;
        if (target === i) target = (target + 1) % NODE_COUNT;
        contentAst.push({ type: "mention", targetNodeId: ids[target], text: `probe ${String(target).padStart(6, "0")}` });
      }
      envelopes.push(envelope(id, "object.create", { objectId: id, classIds: [], contentAst }));
    }
    await postBatch(envelopes);
    done += envelopes.length;
    console.log(`seeded ${done}/${NODE_COUNT} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  writeFileSync(IDS_PATH, JSON.stringify(ids));
  console.log(`SEED_DONE ${NODE_COUNT} nodes in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${IDS_PATH}`);
} else if (mode === "edges") {
  // 25k mention BLOCKS: parented present_as_main=false children whose rich
  // content survives (a MAIN page's own content flattens to text-only — the
  // first seed pass learned this the hard way: 2 edges). The graph rolls each
  // block's mention up to its containing page (packages/store graph.ts).
  if (!existsSync(IDS_PATH)) throw new Error(`missing ${IDS_PATH}`);
  const parentIds = JSON.parse(readFileSync(IDS_PATH, "utf8"));
  const t0 = Date.now();
  const blockIds = [];
  let done = 0;
  for (let start = 0; start < EDGE_COUNT; start += BATCH) {
    const envelopes = [];
    for (let i = start; i < Math.min(start + BATCH, EDGE_COUNT); i++) {
      const id = uuidv7();
      blockIds.push(id);
      const parent = parentIds[i]; // blocks ride the first 25k probe pages
      let target = (i * 7 + 12_345) % NODE_COUNT;
      if (target === i) target = (target + 1) % NODE_COUNT;
      envelopes.push(
        envelope(id, "object.create", {
          objectId: id,
          classIds: [],
          presentAsMain: false,
          parentId: parent,
          contentAst: [{ type: "mention", targetNodeId: parentIds[target], text: `probe ${String(target).padStart(6, "0")}` }],
        }),
      );
    }
    await postBatch(envelopes);
    done += envelopes.length;
    console.log(`edge blocks ${done}/${EDGE_COUNT} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  writeFileSync("/tmp/graph-loadtest-probe-block-ids.json", JSON.stringify(blockIds));
  console.log(`EDGES_DONE ${EDGE_COUNT} mention blocks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else if (mode === "delete") {
  if (!existsSync(IDS_PATH)) throw new Error(`missing ${IDS_PATH}`);
  const ids = JSON.parse(readFileSync(IDS_PATH, "utf8"));
  const t0 = Date.now();
  let done = 0;
  for (let start = 0; start < ids.length; start += BATCH) {
    const slice = ids.slice(start, start + BATCH);
    await postBatch(slice.map((id) => envelope(id, "object.delete", { objectId: id, permanent: true })));
    done += slice.length;
    if (done % 5000 === 0 || done === ids.length) {
      console.log(`deleted ${done}/${ids.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
  }
  // Verify: sampled ids must 404, count must return to baseline.
  let missing = 0;
  for (let k = 0; k < 25; k++) {
    const id = ids[Math.floor(Math.random() * ids.length)];
    const res = await fetch(`${API}/api/objects/${id}`, { headers: { "x-api-key": KEY } });
    if (res.status === 404) missing++;
    else console.log(`sample ${id} → ${res.status} (expected 404)`);
  }
  const total = await countObjects();
  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")).count : null;
  console.log(
    `DELETE_DONE ${ids.length} permanent deletes in ${((Date.now() - t0) / 1000).toFixed(1)}s; ` +
      `sampled 404s ${missing}/25; active objects now ${total}` +
      (baseline !== null ? ` (baseline ${baseline} → ${total === baseline ? "MATCH" : "MISMATCH"})` : ""),
  );
} else {
  console.error("usage: graph-loadtest-seed.mjs count|seed|delete");
  process.exit(1);
}
