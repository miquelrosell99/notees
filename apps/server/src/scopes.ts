/**
 * Scoped API keys (§34.33 AG3): the scope vocabulary and its validation.
 *
 * Names follow the §26 granular set. Today's object/assets surface exercises
 * a subset — relations/annotations/citations/collections endpoints do not
 * exist yet, so their scope names are reserved vocabulary, not enforced
 * anywhere. A key created with NO scope list is unrestricted (the M1 default;
 * the operator key and account sessions are always unrestricted). Scoped keys
 * are object-API credentials: the relay surface rejects them with 403
 * `scope_denied` (routes-relay.ts), and account routes keep requiring a
 * session regardless of scopes.
 *
 * Enforcement is declarative: each object/assets route carries
 * `config: { requiredScope }` and the plugin preHandler in app.ts checks the
 * authenticated key's scope set against it. Routes without the tag stay
 * unrestricted.
 */

import type { FastifyRequest } from "fastify";

import { AppError } from "./errors.js";

export const API_SCOPES = [
  "objects.read",
  "objects.write",
  "objects.delete",
  "relations.read",
  "relations.write",
  "assets.read",
  "assets.write",
  "annotations",
  "citations",
  "collections.write",
  "search",
  "export",
  "admin",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES);

export const MAX_SCOPES_PER_KEY = 32;

/**
 * Validate a caller-supplied scope list (POST /api-keys body). Returns the
 * normalized list, or null when the input is not a valid scope list (null/
 * undefined means "unrestricted" and is accepted separately by the route).
 */
export function parseApiScopes(input: unknown): string[] | null | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || input.length > MAX_SCOPES_PER_KEY) return null;
  const scopes: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string" || !API_SCOPE_SET.has(entry)) return null;
    if (!scopes.includes(entry)) scopes.push(entry);
  }
  return scopes;
}

/** A key with no scope list (null) can do anything; otherwise the set must contain the scope. */
export function scopeAllows(keyScopes: readonly string[] | null, required: ApiScope): boolean {
  return keyScopes === null || keyScopes.includes(required);
}

/**
 * Enforcement against the route-scope map built from the OpenAPI route
 * table (app.ts) — the document's `x-required-scope` per operation IS the
 * enforcement declaration, so doc and middleware cannot drift. Scoped keys
 * lacking the route's scope get 403 `scope_denied`; unrestricted principals
 * (sessions, operator key, unscoped keys) pass. Runs after authentication,
 * before the handler.
 */
export type RouteScopeMap = ReadonlyMap<string, ApiScope>;

export function routeScopeKey(method: string, path: string): string {
  return `${method} ${path}`;
}

export function buildRouteScopeMap(
  routes: ReadonlyArray<{ method: string; path: string; requiredScope?: string }>,
): RouteScopeMap {
  const map = new Map<string, ApiScope>();
  for (const route of routes) {
    if (route.requiredScope !== undefined) {
      map.set(routeScopeKey(route.method, route.path), route.requiredScope as ApiScope);
    }
  }
  return map;
}

export function enforceRouteScope(
  request: FastifyRequest,
  keyScopes: readonly string[] | null,
  routeScopes: RouteScopeMap,
): void {
  if (keyScopes === null) return;
  const routePath = request.routeOptions.url ?? "";
  let required = routeScopes.get(routeScopeKey(request.method, routePath));
  if (required === undefined && request.method === "HEAD") {
    // Fastify auto-registers HEAD for GET routes.
    required = routeScopes.get(routeScopeKey("GET", routePath));
  }
  if (required === undefined) return;
  if (!scopeAllows(keyScopes, required)) {
    throw new AppError(403, "scope_denied", `this route requires the "${required}" API-key scope`);
  }
}
