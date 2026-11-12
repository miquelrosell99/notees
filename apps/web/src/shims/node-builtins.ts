/**
 * Browser stubs for node builtins reachable from @notees/store's file-backed
 * adapter (packages cannot be modified from apps/web). These are never
 * called in the browser — the web client opens stores over the sql.js
 * backend — they exist only so the browser bundle links.
 */

function unavailable(name: string): never {
  throw new Error(`${name} is not available in the browser`);
}

// --- node:fs -----------------------------------------------------------------

export function mkdtempSync(..._args: unknown[]): never {
  unavailable("node:fs mkdtempSync");
}

export function rmSync(..._args: unknown[]): never {
  unavailable("node:fs rmSync");
}

export function writeFileSync(..._args: unknown[]): never {
  unavailable("node:fs writeFileSync");
}

// --- node:os -----------------------------------------------------------------

export function tmpdir(): never {
  unavailable("node:os tmpdir");
}

// --- node:path ---------------------------------------------------------------

export function join(..._args: unknown[]): never {
  unavailable("node:path join");
}
