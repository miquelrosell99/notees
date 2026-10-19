/**
 * Compatibility barrel — the historical import surface
 * (`@/core/workspace-client.js`). The implementation lives in the
 * `workspace-client/` folder module beside this file; this shim re-exports it
 * unchanged so existing importers keep working.
 */
export * from "./workspace-client/index.js";
