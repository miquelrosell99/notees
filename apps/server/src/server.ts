/**
 * Server entry: listen on the configured port; log a freshly generated API
 * key exactly once; shut down cleanly on signals.
 */

import { loadConfig } from "./config.js";
import { buildServer } from "./app.js";

const config = loadConfig();
const { app } = await buildServer(config);

if (config.generatedKey) {
  // One-time bootstrap notice — the key is also in <dataDir>/api_key.txt.
  console.error(`[notees] generated API key (stored at ${config.dataDir}/api_key.txt): ${config.apiKey}`);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port: config.port, host: config.host });
