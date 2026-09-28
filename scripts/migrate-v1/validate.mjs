// Offline validation of transformed envelopes against the REAL v2 protocol
// schemas (the same zod schemas the server's /batch endpoint enforces).
// Usage: node validate.mjs
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { envelopeSchema, payloadSchemaFor } from "../../packages/protocol/dist/index.js";

const workspaces = [
  "3b30e070-039b-47bc-ad0d-2440a2f173c5",
  "b42cb292-39f8-4d70-aa4d-a5fb7be12f8d",
  "bca97d7b-0dc0-48aa-9d14-abf67e1fdad3",
];

let total = 0;
let failures = 0;

function check(env) {
  total += 1;
  const parsed = envelopeSchema.safeParse(env);
  if (!parsed.success) {
    failures += 1;
    if (failures <= 5) {
      console.log("ENVELOPE FAIL", env.id, env.opType, parsed.error.issues[0]);
    }
    return;
  }
  const schema = payloadSchemaFor(env.opType);
  if (schema === undefined) {
    failures += 1;
    if (failures <= 5) console.log("UNKNOWN OP TYPE", env.id, env.opType);
    return;
  }
  const payload = schema.safeParse(env.payload);
  if (!payload.success) {
    failures += 1;
    if (failures <= 5) {
      console.log("PAYLOAD FAIL", env.id, env.opType, JSON.stringify(env.payload).slice(0, 200));
      console.log("  issue:", JSON.stringify(payload.error.issues[0]).slice(0, 400));
    }
    return;
  }
  if (JSON.stringify(env.payload).length > 1_000_000) {
    failures += 1;
    if (failures <= 5) console.log("PAYLOAD TOO BIG", env.id, env.opType);
  }
}

for (const ws of workspaces) {
  const rl = createInterface({ input: createReadStream(new URL(`.extract/${ws}.v2.jsonl`, import.meta.url)) });
  for await (const line of rl) {
    if (line.trim()) check(JSON.parse(line));
  }
  console.log(`${ws}: running total ${total}`);
}
console.log(`\nvalidated ${total} envelopes, failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
