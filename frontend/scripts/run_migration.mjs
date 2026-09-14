/**
 * Minimal vite-node substitute: runs frontend/scripts/migrate_legacy_structure.ts
 * through Vite's ssrLoadModule so it gets TS transpilation and the `@/` alias
 * resolution from vite.config.ts. (vite-node is not installed — vitest 4
 * dropped it as a dependency.)
 *
 * Run from the repo root:  node frontend/scripts/run_migration.mjs
 */
import { createServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const server = await createServer({
  root: frontendRoot,
  configFile: path.join(frontendRoot, 'vite.config.ts'),
  logLevel: 'warn',
  server: { middlewareMode: true },
});

try {
  await server.ssrLoadModule('/scripts/migrate_legacy_structure.ts');
} finally {
  await server.close();
}
