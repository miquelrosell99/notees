/**
 * The OpenAPI 3.1 contract of the HTTP surface — served at
 * GET /api/openapi.json and gated in CI by the route-coverage test
 * (test/openapi-coverage.test.ts): every route the Fastify app actually
 * registers must appear here, so the document cannot drift from the code.
 *
 * Hand-maintained route table, honest about depth: summaries, parameters,
 * request bodies, and the pinned error taxonomy are normative; entity
 * response schemas are described where the API pins the shape (error
 * envelope, probes, create/update bodies) and left open
 * (`additionalProperties: true`, no invented fields) elsewhere. Cross-cutting
 * facts live in top-level extensions, all backed by code:
 *
 *  - `x-error-codes` — the pinned taxonomy (src/errors.ts).
 *  - `x-rate-limits`  — the three real fixed-window limiters.
 *  - `x-api-key-scopes` — the scope vocabulary and enforcement rules.
 *  - `x-revision-checks` — which mutations honor `baseRevision`, and
 *    the honest note that other mutating routes have no natural revision.
 */

import { ERROR_TAXONOMY } from "./errors.js";
import { API_SCOPES } from "./scopes.js";

type HttpMethod = "get" | "post" | "patch" | "put" | "delete";

type JsonSchema = Record<string, unknown>;

interface OperationSpec {
  summary: string;
  description?: string;
  tags: [string, ...string[]];
  /** Path parameters beyond `:id` — a plain string is described as uuid;
   * pass `{ description, format? }` when the surface's identity law differs
   * (share tokens are opaque base64url, not uuid). */
  params?: Record<string, string | { description: string; format?: string }>;
  /** Query parameters the route reads (name → description). */
  query?: Record<string, { description: string; type?: string; required?: boolean }>;
  requestBody?: JsonSchema;
  /** Response for the success status: description + schema. */
  success?: { status?: number; description: string; schema?: JsonSchema };
  /** scope a scoped API key must carry for this operation. */
  requiredScope?: string;
  /** the mutation honors the Idempotency-Key header. */
  idempotency?: boolean;
  /** Extra error codes this operation throws, beyond the base {401,403,429}. */
  errors?: string[];
  /** WebSocket endpoint (not plain HTTP) — documented, flagged. */
  webSocket?: boolean;
  /**
   * Auth-free route (healthz, version, meta, openapi, server-info, setup,
   * login): answers carry no 401/403 (the global 429 still applies unless
   * rateLimitExempt).
   */
  public?: boolean;
  /** Exempt from the global per-IP limiter (only /healthz). */
  rateLimitExempt?: boolean;
}

/** OperationSpec plus its route path while building (path stripped before emit). */
interface InternalOperationSpec extends OperationSpec {
  __path?: string;
}

const errorRef: JsonSchema = { $ref: "#/components/schemas/ErrorEnvelope" };

function errorResponse(description: string): JsonSchema {
  return {
    description,
    content: { "application/json": { schema: errorRef } },
  };
}

function jsonContent(schema: JsonSchema | undefined): JsonSchema {
  return {
    "application/json": {
      schema: schema ?? { type: "object", additionalProperties: true },
    },
  };
}

/** The shared error set: success first, then auth (unless public), then route-specific codes. */
function responsesFor(spec: OperationSpec): JsonSchema {
  const responses: JsonSchema = {};
  const successStatus = spec.success?.status ?? 200;
  responses[String(successStatus)] = {
    description: spec.success?.description ?? "Success",
    content: jsonContent(spec.success?.schema),
  };
  const base = spec.public === true
    ? []
    : ["unauthenticated", "forbidden"];
  const codes = new Set<string>([
    ...base,
    ...(spec.rateLimitExempt === true ? [] : ["rate_limited"]),
    ...(spec.errors ?? []),
  ]);
  for (const code of codes) {
    const entry = ERROR_TAXONOMY[code as keyof typeof ERROR_TAXONOMY];
    if (entry === undefined) continue;
    responses[String(entry.status)] = errorResponse(`${code}: ${entry.description}`);
  }
  responses.default = errorResponse("internal: unclassified server failure");
  return responses;
}

function operationFor(spec: InternalOperationSpec): JsonSchema {
  const parameters: JsonSchema[] = [];
  const idPattern = /\/:id(\/|$)/;
  if (idPattern.test(spec.__path ?? "")) {
    parameters.push({
      name: "id",
      in: "path",
      required: true,
      // Surfaces whose identity law is NOT UUIDv7 (plugin ids are
      // reverse-domain or UUID) pass their own description via params.
      description:
        spec.params?.id ?? "UUIDv7 node/class/property-schema/workspace id (identity is always the uuid).",
      schema: spec.params?.id !== undefined ? { type: "string" } : { type: "string", format: "uuid" },
    });
  }
  for (const [name, param] of Object.entries(spec.params ?? {})) {
    if (name === "id") continue; // handled above — the identity law differs per surface
    const description = typeof param === "string" ? param : param.description;
    const format = typeof param === "string" ? "uuid" : (param.format ?? "string");
    parameters.push({
      name,
      in: "path",
      required: true,
      description,
      schema: { type: "string", ...(format === "uuid" ? { format: "uuid" } : {}) },
    });
  }
  for (const [name, param] of Object.entries(spec.query ?? {})) {
    parameters.push({
      name,
      in: "query",
      required: param.required ?? false,
      description: param.description,
      schema: { type: param.type ?? "string" },
    });
  }
  const operation: JsonSchema = {
    summary: spec.summary,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    tags: spec.tags,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(spec.requestBody !== undefined
      ? {
          requestBody: {
            required: true,
            content: jsonContent(spec.requestBody),
          },
        }
      : {}),
    responses: responsesFor(spec),
  };
  if (spec.requiredScope !== undefined) operation["x-required-scope"] = spec.requiredScope;
  if (spec.idempotency === true) operation["x-idempotency-key"] = true;
  if (spec.webSocket === true) operation["x-webSocket"] = true;
  return operation;
}

/** uuid-shaped object id used across request bodies. */
const objectIdField: JsonSchema = { type: "string", format: "uuid" };

const createObjectBody: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    isClass: { type: "boolean", description: "true declares a class node (always a root)" },
    isEmbedded: { type: "boolean", description: "embedding flag for parented non-class nodes (Revision 12)" },
    name: { type: "string", description: "initial text content (title-is-content)" },
    contentAst: { type: "array", items: { type: "object", additionalProperties: true }, description: "SCHEMA.md content tokens" },
    classIds: { type: "array", items: objectIdField },
    parentId: { ...objectIdField, nullable: true },
    id: { ...objectIdField, description: "caller-chosen id (deterministic ids); a taken id fails 409 conflict" },
  },
};

const updateObjectBody: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    isEmbedded: { type: "boolean", description: "embedding-flag toggle (promotion/demotion, Revision 12)" },
    icon: { type: "string" },
    color: { description: "preset token or #RRGGBB; null clears (SCHEMA.md color grammar)" },
    contentAst: { type: "array", items: { type: "object", additionalProperties: true } },
    coverAssetId: { ...objectIdField, nullable: true, description: "page cover asset node; null clears (wire node field)" },
    bannerAssetId: { ...objectIdField, nullable: true, description: "page banner asset node; null clears (wire node field)" },
    aliasedNodeId: { ...objectIdField, nullable: true, description: "the main page a node alias points at; null clears (wire node field)" },
    baseRevision: {
      type: "object",
      additionalProperties: false,
      properties: { physical: { type: "integer" }, logical: { type: "integer" } },
      description:
        "optimistic-concurrency guard: the node's `hlc` as last seen; a stale value fails 409 conflict. The field never enters the op payload (HTTP-layer check only).",
    },
  },
};

const propertyWriteBody: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["propertySchemaId", "value"],
  properties: {
    propertySchemaId: objectIdField,
    value: {},
    idx: { type: "integer", minimum: 0, default: 0 },
    metadata: { type: "object", additionalProperties: true },
  },
};

const queryBody: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ast"],
  properties: {
    ast: { description: "the versioned QueryAST (validated fail-loud by parseQueryAst)" },
  },
};

const apiKeyCreateBody: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string" },
    scopes: {
      type: "array",
      items: { type: "string", enum: API_SCOPES },
      description:
        "optional scope set; omit for the unrestricted default. Scoped keys are object-API-only: the relay surface rejects them with 403 scope_denied.",
    },
  },
};

/**
 * The route table. Keys are Fastify-style paths (`:param`); the builder
 * converts them to OpenAPI `{param}` form. The coverage test asserts this
 * table ↔ the live Fastify registration are the same set.
 */
const ROUTES: Array<[HttpMethod, string, InternalOperationSpec]> = [
  // --- public probes & developer self-description -------------------------------
  ["get", "/healthz", {
    summary: "Liveness probe (auth-free, for doctors and load balancers)",
    tags: ["Meta"],
    public: true,
    rateLimitExempt: true,
    success: { description: `{ "ok": true }` },
  }],
  ["get", "/api/version", {
    summary: "Server + wire protocol version probe (auth-free)",
    tags: ["Meta"],
    public: true,
  }],
  ["get", "/api/meta", {
    summary: "Server self-description: version, wire protocol versions, default workspace, setup state",
    description:
      "The default workspace id is a fixed system uuid (identity.ts), safe to expose unauthenticated; per-account workspace listing lives behind auth at GET /api/workspaces.",
    tags: ["Meta"],
    public: true,
  }],
  ["get", "/api/openapi.json", {
    summary: "This OpenAPI 3.1 document (the published HTTP contract)",
    tags: ["Meta"],
    public: true,
  }],
  ["get", "/api/operations", {
    summary: "Paginated read of the workspace's relay operation log (agent-safety feed)",
    description:
      "Cursor-paginated over the server seq, same shape as relay catch-up. Read access: any authenticated principal with workspace membership (or the operator key); scoped API keys need the objects.read scope.",
    tags: ["Meta"],
    query: {
      workspaceId: { description: "workspace uuid (defaults to the server default workspace)", type: "string" },
      afterSeq: { description: "return envelopes with seq > afterSeq", type: "integer" },
      limit: { description: "page size (default 1000, max 10000)", type: "integer" },
    },
    requiredScope: "objects.read",
    errors: ["validation_failed", "not_found"],
  }],

  // --- account & auth ---------------------------------------------------------------
  ["get", "/api/server-info", {
    summary: "First-run probe: setupRequired, signupEnabled, version, protocol versions",
    tags: ["Account"],
    public: true,
  }],
  ["post", "/api/setup", {
    summary: "Initial setup: create the first (admin) account (refused once any account exists)",
    tags: ["Account"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string", minLength: 8, maxLength: 256 },
        displayName: { type: "string" },
      },
    },
    success: { status: 201, description: "session token, account, and the KDF record" },
    public: true,
    errors: ["validation_failed", "already_provisioned", "rate_limited"],
  }],
  ["post", "/api/auth/signup", {
    summary: "Open registration (NOTEES_SIGNUP_ENABLED only): create a non-admin account",
    description: "Gated by the NOTEES_SIGNUP_ENABLED env flag (default off): when disabled the route answers 404 — the surface does not exist at all. The account starts workspace-less; the login screen only offers the link while /api/server-info advertises signupEnabled.",
    tags: ["Account"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string", minLength: 8, maxLength: 256 },
        displayName: { type: "string" },
      },
    },
    success: { status: 201, description: "session token, the new account (isAdmin false), and the KDF record" },
    public: true,
    errors: ["validation_failed", "not_found", "conflict", "rate_limited"],
  }],
  ["post", "/api/auth/login", {
    summary: "Email + password → session token",
    tags: ["Account"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["email", "password"],
      properties: { email: { type: "string" }, password: { type: "string" } },
    },
    public: true,
    errors: ["validation_failed", "invalid_credentials", "account_locked", "rate_limited"],
  }],
  ["post", "/api/auth/unlock", {
    summary: "Email + password → the kdf record ONLY (no session is minted)",
    description:
      "The unlock re-prompt's password check: validates the password (same scrypt verify, per-IP rate limit and per-account lockout as login — it is a password oracle) and returns the password-derived key record so the client can re-derive the master key. The caller already holds a live credential, so NO session row is created.",
    tags: ["Account"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["email", "password"],
      properties: { email: { type: "string" }, password: { type: "string" } },
    },
    public: true,
    success: { description: "{ kdf } — the password-derived key record; no token, no session" },
    errors: ["validation_failed", "invalid_credentials", "account_locked", "rate_limited"],
  }],
  ["post", "/api/auth/change-password", {
    summary: "Rewrap the master key under a new password (session required)",
    description:
      "Installs a replacement kdf record. The current password is verified; the new record's keyFp (HMAC fingerprint of the master key) MUST match the stored record's — the sameness gate that stops a mistyped new password from locking every other device out. Legacy stored records without a fingerprint are accepted with a one-time server warning. Sessions and API keys stay valid (the master key is unchanged); other devices need the new password at next unlock.",
    tags: ["Account"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["currentPassword", "newKdfRecord"],
      properties: {
        currentPassword: { type: "string" },
        newKdfRecord: { type: "object", additionalProperties: false, description: "the full scrypt kdf record INCLUDING keyFp" },
      },
    },
    errors: ["validation_failed", "invalid_credentials", "unauthenticated"],
  }],
  ["post", "/api/auth/logout", {
    summary: "Revoke the current session (session token required)",
    tags: ["Account"],
  }],
  ["get", "/api/auth/me", {
    summary: "The authenticated account (the operator key answers as a synthetic owner identity)",
    tags: ["Account"],
  }],
  ["patch", "/api/auth/me", {
    summary: "Update profile fields (display name, name, surnames, avatar)",
    tags: ["Account"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      properties: {
        displayName: { type: ["string", "null"] },
        name: { type: ["string", "null"] },
        surnames: { type: ["string", "null"] },
        avatarUrl: { type: ["string", "null"] },
      },
    },
    errors: ["validation_failed"],
  }],
  ["get", "/api/me/prefs", {
    summary: "Per-user UI prefs: favorites + recents + the cards scheduler + the ADS API token (server-side UI state, not op-log state)",
    description:
      "favorites/recents are UI preferences, so they live in the sync server's per-user prefs store, NOT the operation log (\"device state is never an op\" stands). The row also carries the caller's own ADS (Astrophysics Data System) API credential for bibcode metadata lookups — `adsApiToken` is null when unset, returned to the OWNING user only, and sent on to api.adsabs.harvard.edu alone (the resolver's egress contract). Scoped to the authenticated principal (account session or per-user API key owner).",
    tags: ["Account"],
  }],
  ["post", "/api/admin/append", {
    summary: "OPERATOR: apply pre-built migration envelopes through the server (Path A appends, idempotent)",
    description:
      "The apply-through-server migration path: `scripts/migrate-*.mts --apply --server <url>` builds and protocol-validates its envelopes, then posts them here instead of writing relay.db directly. Runs through the one write path (relay ingest, then derived apply), so the server's own stores converge before the response — no restart, no derived-cache wipe. Whole batch is validated before anything is ingested; duplicate ids are ignored (idempotent re-runs answer an empty savedIds). OPERATOR API KEY ONLY — user sessions and per-user keys get 403.",
    tags: ["Admin"],
    requiredScope: "admin",
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "envelopes"],
      properties: {
        workspaceId: { type: "string", format: "uuid" },
        envelopes: { type: "array", items: { type: "object" }, description: "the migration's envelopes (1..10000), each validated through the envelope + payload schemas" },
      },
    },
    errors: ["validation_failed", "forbidden", "unauthenticated"],
  }],
  ["get", "/api/admin/convergence", {
    summary: "OPERATOR: per-workspace convergence state + whether specific envelope ids are applied",
    description:
      "The honest post-migration check THROUGH the server's own read path: how far the open derived handle has applied the log ({hydrated, lastSeq, latestSeq, pending, appliedCount}) and, per comma-separated `envelopeIds`, whether each is applied. Never probe derived/*.db with raw sqlite — snapshot-restore temp files, WAL raciness, and mistyped UUIDs all masquerade as \"not converged\" (2026-11-02). OPERATOR API KEY ONLY.",
    tags: ["Admin"],
    requiredScope: "admin",
    query: {
      workspaceId: { description: "the workspace", type: "string", required: true },
      envelopeIds: { description: "comma-separated envelope ids to check (a migration's batch)", type: "string" },
    },
    errors: ["validation_failed", "forbidden", "unauthenticated"],
  }],
  ["put", "/api/me/prefs", {
    summary: "Merge-patch per-user UI prefs (each present list replaces its column; order-preserving dedupe, then caps)",
    description:
      "favorites ≤ 500 and recents ≤ 50 uuid-shaped node ids (validated after dedupe); a present cardsAlgorithm (\"sm2\" | \"fsrs\") replaces the scalar; a present adsApiToken (string ≤ 256 chars, or null/\"\" to clear) replaces the ADS credential column. At least one key required. Last write wins per list — the client owns ordering. No idempotency key: a retry replays the same full-list body harmlessly.",
    tags: ["Account"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      properties: {
        favorites: { type: "array", items: objectIdField, description: "ordered starred node ids (cap 500)" },
        recents: { type: "array", items: objectIdField, description: "most-recent-first node ids (cap 50)" },
        cardsAlgorithm: { type: "string", enum: ["sm2", "fsrs"], description: "the memorization-cards scheduler" },
        adsApiToken: { type: ["string", "null"], description: "the ADS API credential (null/\"\" clears it)" },
      },
    },
    errors: ["validation_failed"],
  }],
  ["get", "/api/nodes/:nodeId/sections/:sectionKey/views", {
    summary: "Node-scoped hosted views (custom tabs) for one surface of one node, in tab order",
    description:
      "Cross-device UI state on the prefs channel (like favorites/recents — never op-log state), but node-scoped: every user of the deployment shares a node's tabs (applied to system sections too). The default view is derived-not-stored: no default row exists, an empty table renders factory behavior. sectionKey ∈ linked-references | unlinked-mentions | classed-nodes, or the '-' sentinel for the empty key (a query node's main query).",
    tags: ["Nodes"],
    params: {
      nodeId: "the page/class/query node the surface lives on",
      sectionKey: "linked-references | unlinked-mentions | classed-nodes | - (empty = main query)",
    },
  }],
  ["post", "/api/nodes/:nodeId/sections/:sectionKey/views", {
    summary: "Create a hosted view (appends after the last tab)",
    description:
      "queryAst must parse against QueryAST v2 (the same grammar the FilterBuilderModal produces — a transient filter persists verbatim). The name is unique per (node, section) — a collision is 409. There is deliberately no viewMode: view modes are transient surface state, not stored.",
    tags: ["Nodes"],
    params: {
      nodeId: "the page/class/query node the surface lives on",
      sectionKey: "linked-references | unlinked-mentions | classed-nodes | - (empty = main query)",
    },
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["name", "queryAst"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120, description: "tab label (unique per surface)" },
        queryAst: { description: "QueryAST v2 (validated against the zod schema)" },
      },
    },
    success: { status: 201, description: "the created view" },
    errors: ["validation_failed", "conflict"],
  }],
  ["patch", "/api/nodes/:nodeId/sections/:sectionKey/views/:viewId", {
    summary: "Patch a hosted view — rename it and/or rewrite its query",
    description:
      "The row must exist and live on this node+surface — anything else is 404. A name collision on the surface's unique key is 409. The queryAst, when present, must parse against QueryAST v2; a rename-only patch omits it. At least one of name/queryAst is required.",
    tags: ["Nodes"],
    params: {
      nodeId: "the page/class/query node the surface lives on",
      sectionKey: "linked-references | unlinked-mentions | classed-nodes | - (empty = main query)",
      viewId: "the node view id (uuid)",
    },
    requestBody: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 120 },
        queryAst: { description: "QueryAST v2 (validated against the zod schema)" },
      },
    },
    errors: ["validation_failed", "not_found", "conflict"],
  }],
  ["put", "/api/nodes/:nodeId/sections/:sectionKey/views/order", {
    summary: "Reorder the surface's views (the full ordered id list; sequences rewrite 0..n-1)",
    description:
      "The client owns ordering, like the prefs lists. orderedIds must name every view of the surface exactly once — anything else is 422.",
    tags: ["Nodes"],
    params: {
      nodeId: "the page/class/query node the surface lives on",
      sectionKey: "linked-references | unlinked-mentions | classed-nodes | - (empty = main query)",
    },
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["orderedIds"],
      properties: { orderedIds: { type: "array", minItems: 1, items: objectIdField } },
    },
    errors: ["validation_failed"],
  }],
  ["delete", "/api/nodes/:nodeId/sections/:sectionKey/views/:viewId", {
    summary: "Delete a hosted view (204)",
    description:
      "Deleting every row of a surface restores factory behavior — the default view is derived-not-stored, so reset-to-default is just this route over all rows.",
    tags: ["Nodes"],
    params: {
      nodeId: "the page/class/query node the surface lives on",
      sectionKey: "linked-references | unlinked-mentions | classed-nodes | - (empty = main query)",
      viewId: "the node view id (uuid)",
    },
    success: { status: 204, description: "deleted" },
    errors: ["not_found"],
  }],
  ["get", "/api/workspaces", {
    summary: "The account's workspaces (membership view, with envelope stats and per-workspace encrypted flag; the operator key sees the whole directory)",
    tags: ["Workspaces"],
  }],
  ["post", "/api/workspaces", {
    summary: "Create a workspace (the creator becomes owner; session required)",
    tags: ["Workspaces"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" } },
    },
    success: { status: 201, description: "the new workspace id" },
    errors: ["validation_failed"],
  }],
  ["patch", "/api/workspaces/:id", {
    summary: "Rename a workspace (owner-only; non-members get 404)",
    tags: ["Workspaces"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string", minLength: 1 } },
    },
    errors: ["validation_failed", "not_found", "conflict"],
  }],
  ["delete", "/api/workspaces/:id", {
    summary: "Delete a workspace AND its data (relay log, snapshots, derived db; owner-only)",
    tags: ["Workspaces"],
    errors: ["not_found", "conflict"],
  }],
  ["post", "/api/workspaces/:id/clone", {
    summary: "Clone a workspace from its derived snapshot image (owner-only; session required)",
    description:
      "Creates a FRESH envelope-empty workspace and installs a consistent snapshot image of the source's derived store (every workspace_id row rewritten). The clone's relay log starts EMPTY — the history is not in the log; the installed snapshot row is load-bearing (a derived wipe rehydrates from the snapshot, not the log). The source must carry node rows (422 otherwise); a failure after the workspace row is created rolls the half workspace back best-effort.",
    tags: ["Workspaces"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" } },
    },
    success: { status: 201, description: "the new workspace id, name, and node count" },
    errors: ["validation_failed", "not_found", "forbidden", "conflict"],
  }],
  ["get", "/api/workspaces/:id/key", {
    summary: "The workspace's wrapped E2EE key (member-scoped; opaque to the server)",
    description:
      "E2EE custody: one wrapped-key string per workspace, wrapped by the client with the account master key — the server never sees either key. A user without membership gets 404 (key existence is not revealed), as does a member when no key is stored; an API-key principal (operator) gets 403 — keys are user custody, not operator.",
    tags: ["Workspaces"],
    success: { description: "the wrapped key", schema: { type: "object", additionalProperties: false, properties: { wrappedKey: { type: "string" } }, required: ["wrappedKey"] } },
    errors: ["unauthenticated", "forbidden", "not_found"],
  }],
  ["put", "/api/workspaces/:id/key", {
    summary: "Store the workspace's wrapped E2EE key (member-scoped; FIRST write wins)",
    description:
      "Writes the opaque wrapped-key row. First write wins: when a row already exists the PUT is rejected with 409 and the stored key is left untouched — a concurrent first-opener must fetch and unwrap the winner's key (a blind upsert would permanently split the workspace's keys). Non-members get 403; the operator API key gets 403; unauthenticated 401.",
    tags: ["Workspaces"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["wrappedKey"],
      properties: { wrappedKey: { type: "string", minLength: 1, maxLength: 4096 } },
    },
    success: { status: 204, description: "stored" },
    errors: ["unauthenticated", "forbidden", "validation_failed", "conflict"],
  }],


  ["get", "/api/api-keys", {
    summary: "List the account's API keys (session required; keys are name + scopes + prefix)",
    tags: ["Account"],
  }],
  ["post", "/api/api-keys", {
    summary: "Mint an API key (full token returned exactly once; sha256 at rest)",
    description:
      "an optional `scopes` list makes the key a scoped object-API credential. Omit scopes for the unrestricted default.",
    tags: ["Account"],
    requestBody: apiKeyCreateBody,
    success: { status: 201, description: "the key row and the full token (once)" },
    errors: ["validation_failed"],
  }],
  ["delete", "/api/api-keys/:id", {
    summary: "Revoke an API key (session revokes any of the account's keys; a key may revoke only itself)",
    tags: ["Account"],
    errors: ["not_found", "conflict"],
  }],

  // --- objects ------------------------------------------------------------------------
















  ["get", "/api/features", {
    summary: "Workspace feature-toggle rows (the workspace_feature projection)",
    description:
      "The read half of the workspace.feature.set surface — one row per toggled feature ({feature, enabled, settings}; settings is NULL when the winning payload carried none). F2 semantics: an ABSENT row means ENABLED (the empty table is the pre-toggle state), so untoggled features do not appear — callers default them to on (the CLI's `feature list`).",
    tags: ["Objects"],
    requiredScope: "objects.read",
  }],

  // --- search & query -------------------------------------------------------------------

  ["get", "/api/resolve", {
    summary: "Resolve a node id from its exact display name, OR source metadata from an identifier (DOI / ISBN / arXiv / PMID / ADS bibcode)",
    description:
      "Two query modes on one route. `?name=` — case-insensitive exact-name match over the ranked FTS candidates (the one-round-trip name→id resolution; CLI `linked:`, query builders). 404 when no active node carries the exact name. `?doi=` / `?isbn=` / `?arxiv=` / `?pmid=` / `?ads=` — exactly one required (400 otherwise): the server's metadata resolver fetches the record from Crossref / OpenLibrary / arXiv / PubMed / ADS — the ONLY outbound egress the server ever makes, identifier-only (see the route module's privacy note) — and answers the unified record {classKey, title, authors[], editors[], fields{}, doi?, isbn?, pmid?, url?, year?, publisher?}. When the record carries a DOI, an Unpaywall lookup adds `pdf: { url }`, the open-access PDF link when one exists (never fails the resolve). Cached 24 h (server state). The workspace's `sources` settings can hard-off the egress: `resolverEnabled: false` → 403 resolver_disabled (absent = default ON). Provider failure/timeout → 502 resolver_unavailable; an unknown identifier → 404. The `?ads=` branch requires a USER principal (the operator key is not a user → 401) and takes the caller's ADS API token from the `x-ads-api-token` header (wrapped/keyed prefs blobs are opaque to the server — the web client sends its unwrapped credential) or, keyless, from their unwrapped prefs blob (`GET/PUT /api/me/prefs`); no token → 422.",
    tags: ["Search & Query"],
    requiredScope: "search",
    query: {
      name: { description: "the node's display name (name→id mode)", type: "string" },
      doi: { description: "a DOI — Crossref lookup (metadata mode)", type: "string" },
      isbn: { description: "an ISBN — OpenLibrary lookup (metadata mode)", type: "string" },
      arxiv: { description: "an arXiv id — arXiv API lookup (metadata mode)", type: "string" },
      pmid: { description: "a PubMed id — NCBI esummary lookup (metadata mode)", type: "string" },
      ads: { description: "an ADS bibcode — authenticated ADS lookup (metadata mode; needs the user's adsApiToken pref)", type: "string" },
    },
    errors: ["validation_failed", "not_found", "resolver_disabled", "resolver_unavailable"],
  }],
  ["post", "/api/resolve/pdf", {
    summary: "Resolve source metadata from a PDF — DOI extraction over the raw bytes, then the resolver",
    description:
      "The owner's PDF flow: intake a PDF either as a multipart upload (one file part, the /api/assets idiom) or via `?url=` for a server-side fetch (http(s) only — loopback/private/link-local literals refused by the SSRF guard; the cap applies to both paths: 25MB). The server scans the RAW BYTES (latin1 decode) with the DOI pattern, first hit wins (trailing punctuation trimmed, percent-entities decoded), resolves it through the ordinary DOI path (same pref gate, same 24 h cache, Crossref), and answers the unified metadata record plus — in `?url=` mode — `pdf: { url }`, the source URL the web client's create flow uploads to CAS. No DOI in the bytes → 422 no_identifier_found. The scan is dependency-free by design: a DOI in the first pages' uncompressed text layer suffices for the vast majority of papers; deflated object streams simply yield no hit. When both an upload and `?url=` arrive, `?url=` wins.",
    tags: ["Search & Query"],
    requestBody: { type: "string", format: "binary", description: "multipart/form-data with one PDF file part (absent in ?url= mode)" },
    query: {
      url: { description: "a public http(s) URL of the PDF for the server to fetch (SSRF-guarded; wins over an uploaded file)", type: "string" },
    },
    requiredScope: "search",
    errors: ["validation_failed", "no_identifier_found", "not_found", "resolver_disabled", "resolver_unavailable"],
  }],

  ["get", "/api/classes", {
    summary: "Class catalog (title-is-content names, parent classes, member counts)",
    tags: ["Classes"],
    requiredScope: "objects.read",
  }],
  ["get", "/api/classes/:id", {
    summary: "Class detail (bindings, members)",
    tags: ["Classes"],
    requiredScope: "objects.read",
    errors: ["not_found"],
  }],
  ["get", "/api/property-schemas", {
    summary: "Active property schemas",
    tags: ["Properties"],
    requiredScope: "objects.read",
  }],
  ["post", "/api/property-schemas", {
    summary: "Create a property schema (propertySchema.create)",
    tags: ["Properties"],
    requestBody: { type: "object", additionalProperties: true, description: "the propertySchema.create payload (protocol-pinned)" },
    success: { status: 201, description: "the created schema" },
    requiredScope: "objects.write",
    idempotency: true,
    errors: ["validation_failed", "not_found"],
  }],
  ["get", "/api/property-schemas/:id", {
    summary: "One active property schema",
    tags: ["Properties"],
    requiredScope: "objects.read",
    errors: ["not_found"],
  }],
  ["patch", "/api/property-schemas/:id", {
    summary: "Update a property schema (propertySchema.update: name, options, datePrecision, dateQualified)",
    tags: ["Properties"],
    requestBody: { type: "object", additionalProperties: true, description: "the propertySchema.update patch fields (protocol-pinned)" },
    requiredScope: "objects.write",
    idempotency: true,
    errors: ["validation_failed", "not_found"],
  }],
  ["delete", "/api/property-schemas/:id", {
    summary: "Delete a property schema (propertySchema.delete; soft-delete — authored values survive)",
    tags: ["Properties"],
    requiredScope: "objects.write",
    idempotency: true,
    errors: ["not_found"],
  }],
  ["post", "/api/classes/:id/properties", {
    summary: "Bind a property schema to a class (class.property.set: the active soft-unbind + pinned tier-flag patch — the binding's per-class mechanics; `required`/`defaultValue`/`sequence` retired)",
    tags: ["Classes", "Properties"],
    requestBody: { type: "object", additionalProperties: true, description: "the class.property.set patch fields + propertySchemaId (protocol-pinned)" },
    requiredScope: "objects.write",
    idempotency: true,
    errors: ["validation_failed", "not_found"],
  }],
  ["delete", "/api/classes/:id/properties/:propertySchemaId", {
    summary: "Remove a class binding (class.property.unset; authored values survive)",
    tags: ["Classes", "Properties"],
    params: { propertySchemaId: "property schema uuid" },
    requiredScope: "objects.write",
    idempotency: true,
    errors: ["not_found"],
  }],
  ["get", "/api/properties/:id/values", {
    summary: "Values asserted for a property schema (across nodes)",
    tags: ["Properties"],
    requiredScope: "objects.read",
  }],

  // --- assets ---------------------------------------------------------------------------
  ["get", "/api/assets", {
    summary: "Workspace asset index (newest first, ?limit=1..1000, default 100)",
    description:
      "Every asset row for the workspace (dedupe note: identical bytes still create one asset row per upload) with the object ids each asset is attached to (from the derived node_asset projection). Response: { assets: [{ assetId, hash, mimeType, size, originalName, uploadedAt, refs, objects }], limit, total }.",
    tags: ["Assets"],
    requiredScope: "assets.read",
    errors: ["validation_failed"],
  }],
  ["post", "/api/assets", {
    summary: "Multipart upload (magic-byte sniffed, audio extension fallback; CAS by sha256)",
    description:
      "Idempotency-Key is deliberately NOT honored here: identical bytes dedupe to one CAS hash, which is the honest idempotency story for uploads. Sniffing runs first (jpeg/png/webp/pdf/epub/audio); when it is inconclusive an audio extension hint (aac/m4a/ogg/flac, from the filename, media size cap) rescues container-less audio such as ADTS .aac — genuinely unknown binaries still reject 422. Optional multipart field `objectId` emits an asset.attach envelope.",
    tags: ["Assets"],
    requestBody: { type: "string", format: "binary", description: "multipart/form-data with one file part" },
    success: { status: 201, description: "{ assetId, hash, mimeType, size, originalName, refs }" },
    requiredScope: "assets.write",
    errors: ["validation_failed", "not_found"],
  }],
  ["get", "/api/assets/:id", {
    summary: "Download asset bytes (Range requests → 206)",
    tags: ["Assets"],
    requiredScope: "assets.read",
    errors: ["not_found", "validation_failed"],
  }],
  ["get", "/api/assets/:id/info", {
    summary: "Asset metadata (hash, mime, size, ref count)",
    tags: ["Assets"],
    requiredScope: "assets.read",
    errors: ["not_found"],
  }],

  // --- relay (WIRE.md) -----------------------------------------------------------
  ["post", "/api/relay/v2/batch", {
    summary: "Ingest a batch of envelopes (idempotent by envelope id)",
    description:
      "Scoped API keys are rejected on the whole relay surface with 403 scope_denied — scoped keys are object-API credentials.",
    tags: ["Relay"],
    requestBody: { type: "object", additionalProperties: true, required: ["envelopes"], properties: { envelopes: { type: "array", items: { type: "object", additionalProperties: true } } } },
    errors: ["validation_failed", "scope_denied"],
  }],
  ["post", "/api/relay/v2/catch-up", {
    summary: "Envelopes after a seq cursor (paginated log read)",
    tags: ["Relay"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId"],
      properties: {
        workspaceId: objectIdField,
        afterSeq: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", default: 1000 },
      },
    },
    errors: ["validation_failed"],
  }],
  ["get", "/api/relay/v2/snapshot", {
    summary: "Latest snapshot pointer for a workspace",
    tags: ["Relay"],
    query: { workspaceId: { description: "workspace uuid", type: "string", required: true } },
    errors: ["validation_failed"],
  }],
  ["get", "/api/relay/v2/snapshot/data", {
    summary: "Snapshot bytes (application/octet-stream)",
    description:
      "Served identity by default; when the request advertises gzip in Accept-Encoding the blob crosses gzipped with Content-Encoding: gzip (SQLite images compress ~4-5x). Clients that parse the body themselves without advertising gzip are unaffected.",
    tags: ["Relay"],
    query: { workspaceId: { description: "workspace uuid", type: "string", required: true } },
    success: { description: "the serialized derived-state SQLite bytes", schema: { type: "string", format: "binary" } },
    errors: ["validation_failed", "not_found"],
  }],
  ["put", "/api/relay/v2/snapshot/data", {
    summary: "Publish snapshot bytes (raw body); mode=import installs them as the workspace's derived store",
    description:
      "Default mode publishes a client-produced checkpoint (sanity-gated above the envelope threshold). mode=import instead INSTALLS the body as the target workspace's derived store — a snapshot image, usually from POST /api/workspaces/:id/clone's source side — rewriting every workspace_id row; the target must be envelope-empty (409 otherwise) and the body must carry node rows at ANY log size (422 otherwise). An imported workspace's log starts empty: the snapshot is load-bearing for rebuilds. A gzipped upload (Content-Encoding: gzip) is transparently decompressed before every sanity gate and the store — the 512 MiB route cap and every downstream check bound the COMPRESSED body; invalid gzip is rejected 400 and nothing is stored.",
    tags: ["Relay"],
    query: {
      workspaceId: { description: "workspace uuid", type: "string", required: true },
      physical: { description: "HLC physical component", type: "integer", required: true },
      logical: { description: "HLC logical component", type: "integer", required: true },
      mode: { description: '"import" installs the body as the workspace derived store (workspace_id rewritten) instead of publishing a checkpoint', type: "string" },
    },
    success: { status: 201, description: "the new snapshot id (plus nodeCount in import mode)" },
    errors: ["validation_failed", "conflict"],
  }],
  ["put", "/api/relay/v2/snapshot/data/part", {
    summary: "Stage one chunk of a multipart snapshot upload",
    description:
      "Part of the multipart flow for checkpoint images past the single-body threshold: the client PUTs each chunk (index-addressed, ≤64 MiB, gzip transfer encoding like the single PUT — decompressed before staging) and commits with POST /snapshot/data/commit. Each index stages exactly once; a duplicate index is rejected 422. Stale part dirs from a torn upload are wiped at boot.",
    tags: ["Relay"],
    query: {
      workspaceId: { description: "workspace uuid", type: "string", required: true },
      upload: { description: "client-generated multipart upload id (uuid)", type: "string", required: true },
      index: { description: "zero-based part index", type: "integer", required: true },
    },
    success: { status: 201, description: "the staged upload id and index" },
    errors: ["validation_failed"],
  }],
  ["post", "/api/relay/v2/snapshot/data/commit", {
    summary: "Concatenate a multipart snapshot upload and store the checkpoint",
    description:
      "Concatenates the upload's parts 0..parts-1 in order, runs the SAME sanity gate as the single PUT (node-row check above the envelope threshold), stores the checkpoint with the sealed flag, and deletes the staged parts. Unknown upload 404; a parts count that does not match the staged indexes 422.",
    tags: ["Relay"],
    query: {
      workspaceId: { description: "workspace uuid", type: "string", required: true },
      upload: { description: "multipart upload id (uuid)", type: "string", required: true },
      parts: { description: "number of parts (must match the staged indexes exactly)", type: "integer", required: true },
      physical: { description: "HLC physical component", type: "integer", required: true },
      logical: { description: "HLC logical component", type: "integer", required: true },
      sealed: { description: '"1" declares a sealed image (stored on the snapshot row, served in GET /snapshot meta)', type: "string" },
    },
    success: { status: 201, description: "the new snapshot id (same body shape as the single PUT)" },
    errors: ["validation_failed", "not_found"],
  }],
  ["post", "/api/relay/v2/compact", {
    summary: "Snapshot the derived state up to an HLC and optionally prune covered envelopes",
    tags: ["Relay"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "upToHlc"],
      properties: {
        workspaceId: objectIdField,
        upToHlc: {
          type: "object",
          additionalProperties: false,
          required: ["physical", "logical"],
          properties: { physical: { type: "integer" }, logical: { type: "integer" } },
        },
        prune: { type: "boolean", default: false },
        dataBase64: { type: "string", default: "" },
      },
    },
    errors: ["validation_failed"],
  }],
  ["get", "/api/relay/v2/stats", {
    summary: "Workspace relay stats (envelope/snapshot counts, max HLC, restore epoch)",
    tags: ["Relay"],
    query: { workspaceId: { description: "workspace uuid", type: "string", required: true } },
    errors: ["validation_failed"],
  }],
  ["get", "/api/relay/v2/ws/:workspaceId", {
    summary: "WebSocket sync socket (hello/ops/ack/error frames, framing version 2)",
    description:
      "Not plain HTTP: upgrade endpoint. Auth via Authorization header (native clients) or a single-use ?ticket= minted at POST /api/relay/v2/tickets (browsers); the principal is re-authorized per batch frame. Fail loud on newer framing versions (WIRE.md).",
    tags: ["Relay"],
    params: { workspaceId: "workspace uuid" },
    webSocket: true,
  }],
  ["post", "/api/relay/v2/tickets", {
    summary: "Mint a WebSocket admission ticket (single-use, 60 s, workspace-bound)",
    description:
      "Authenticated with the normal credential headers (X-API-Key / Authorization: Bearer). Returns {ticket, expiresAt}; the ticket admits one connection to /ws/{workspaceId} for its workspace and dies on first use — browser WebSocket clients cannot set upgrade headers, so this keeps bearer credentials out of URLs and their logs (WIRE.md §2).",
    tags: ["Relay"],
    requestBody: {
      type: "object",
      properties: { workspaceId: { type: "string", format: "uuid" } },
      required: ["workspaceId"],
      additionalProperties: false,
    },
    success: { description: "{ ticket: string, expiresAt: number (epoch ms) }" },
    errors: ["validation_failed", "unauthenticated", "forbidden", "scope_denied"],
  }],

  // --- plugins (manifest schema + inert registry; the RUNTIME is parked) ----
  ["get", "/api/plugins", {
    summary: "List installed plugin manifests (inert registry data — nothing is loaded or executed)",
    description:
      "The registry is server state, NOT log state (the prefs/shares ruling) — no envelope, no op type. The plugin runtime that would consume these rows (capability broker, subprocess host) is parked. Owner/admin-scoped: operator key or administrator account; a scoped API key needs the admin scope.",
    tags: ["Plugins"],
    requiredScope: "admin",
  }],
  ["post", "/api/plugins", {
    summary: "Install a plugin manifest (the body IS the manifest; zod-strict validated fail-loud)",
    description:
      "Idempotent on id+version: a repeat install answers the existing row (200, alreadyInstalled). The same id at a DIFFERENT version is 409 — versioned updates ship with the parked runtime. The manifest grammar (SCHEMA.md) is normative; `entrypoint`/`permissions` are reserved vocabulary, stored only.",
    tags: ["Plugins"],
    requestBody: {
      type: "object",
      additionalProperties: true,
      description: "the plugin manifest per the grammar (manifestVersion 1; strict — unknown keys rejected)",
    },
    success: { status: 201, description: "{ plugin, alreadyInstalled: false } (200 + alreadyInstalled: true on a repeat install)" },
    requiredScope: "admin",
    errors: ["validation_failed", "conflict"],
  }],
  ["delete", "/api/plugins/:id", {
    summary: "Uninstall a plugin (every version of the id; inert data deletion)",
    description:
      "Nothing was ever loaded, so there is nothing to unload — the row is deleted.",
    tags: ["Plugins"],
    params: { id: "plugin id (reverse-domain or UUID — identity, not the display name)" },
    requiredScope: "admin",
    errors: ["not_found"],
  }],
  ["post", "/api/plugins/:id/enabled", {
    summary: "Enable/disable a plugin ({ enabled: boolean }; stored bit only — a parked runtime reads nothing)",
    description: "Applies to every installed version of the id.",
    tags: ["Plugins"],
    params: { id: "plugin id (reverse-domain or UUID)" },
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["enabled"],
      properties: { enabled: { type: "boolean" } },
    },
    requiredScope: "admin",
    errors: ["validation_failed", "not_found"],
  }],

  // --- shares (READ-ONLY public page shares; the write-collab variant stays parked) ----
  ["post", "/api/shares", {
    summary: "Mint a public read-only share token for a page (owner/admin only)",
    description:
      "Share state is server-side coordination (like prefs), NOT operation-log state — no envelope, no op type. Returns the token and the public urlPath (`/s/<token>`; prefix the server origin for the full link). Threat note: possession of the URL IS the capability — the token is 24 random bytes (base64url), there is NO directory listing (unguessable tokens; unknown/revoked/expired all answer the same 404), revocation takes effect on the next request, and an optional expiresAt dies on its own. Classes are not shareable (422); trashed pages stop resolving immediately. Only the object API's default workspace can be shared (the object-authz scope).",
    tags: ["Shares"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["nodeId"],
      properties: {
        nodeId: objectIdField,
        expiresAt: { type: "integer", description: "epoch millis after which the link stops resolving; omit = no expiry (must be in the future)" },
      },
    },
    success: { status: 201, description: "{ share: { token, urlPath, nodeId, workspaceId, createdBy, createdAt, expiresAt, revokedAt } }" },
    errors: ["validation_failed", "not_found"],
  }],
  ["get", "/api/shares", {
    summary: "List share tokens (owner/admin only; ?nodeId= filters to one page)",
    description:
      "Every share of the default workspace, newest first — including revoked rows (revokedAt set), so managers see history. Scoped API keys authenticate as their user; the user must still be owner/admin.",
    tags: ["Shares"],
    query: {
      nodeId: { description: "filter to one node's shares", type: "string" },
    },
  }],
  ["put", "/api/shares/:token/artifact", {
    summary: "Attach (or replace) a share's sealed artifact — key-in-fragment (plan 08)",
    description:
      "Stores the SEALED artifact (b64u iv ‖ tag ‖ ct, self-contained HTML render sealed with the share key) verbatim. The decryption key never reaches any route — it lives only in the published link's #fragment; the viewer at GET /s/:token decrypts locally. Re-publish replaces the artifact; legacy rows without one keep the server-rendered path.",
    tags: ["Shares"],
    requestBody: {
      type: "object",
      additionalProperties: false,
      required: ["ciphertext"],
      properties: { ciphertext: { type: "string", minLength: 1 } },
    },
    success: { status: 204, description: "stored" },
    errors: ["unauthenticated", "forbidden", "not_found", "validation_failed"],
  }],
["delete", "/api/shares/:token", {
    summary: "Revoke a share link (owner/admin only; effective immediately)",
    description:
      "Sets revoked_at — the next GET /s/:token answers 404. The row stays for history; already-revoked or unknown tokens 404.",
    tags: ["Shares"],
    params: { token: { description: "the opaque share token (base64url, NOT a uuid)", format: "opaque" } },
    errors: ["not_found"],
  }],
  ["get", "/s/:token", {
    summary: "The public share view: one static read-only HTML document (UNAUTHENTICATED BY DESIGN)",
    description:
      "GET-only, no credentials, no app — the page title, its block tree as nested lists, and its properties, projected by the export serializer (no JavaScript, no external resource; a strict CSP, no-store caching, nosniff, and no-referrer ride along). Missing, revoked, expired tokens and trashed pages are indistinguishable 404s (no enumeration oracle). The global per-IP rate limit is the only throttle.",
    tags: ["Shares"],
    params: { token: { description: "the opaque share token from POST /api/shares", format: "opaque" } },
    success: { description: "text/html — the standalone read-only share document" },
    public: true,
    errors: ["not_found"],
  }],

  // --- workflows (issue #13 — server-side "when X on nodes matching Y, do Z") ----
  ["get", "/api/workflows", {
    summary: "List workflow rules of the default workspace (any authenticated principal)",
    description:
      "issue #13: rule definitions are server coordination state in relay.db (the prefs/shares/plugins ruling) — no envelope, no op type. Rules are evaluated post-ingest by the server-side engine; their EFFECTS are ordinary op envelopes written by a server actor (client claim \"rules-engine\") through the one write path, so every derived store converges on them. Read: any authenticated principal; writes are owner/admin only.",
    tags: ["Workflows"],
  }],
  ["post", "/api/workflows", {
    summary: "Create a workflow rule (owner/admin only; criteria + actions validated fail-loud)",
    description:
      "issue #13. Body: { name, enabled?, trigger: { opType }, criteria, actions }. trigger opType ∈ object.create | property.set | class.assign — the last is the semantic name for the wire's class-add carrier (a re-issued object.create carrying classIds; there is no class.assign op). criteria is a strict QueryAST v2 node filter (no aggregation — 422) compiled against the derived store and probed for the trigger envelope's affected nodes. actions (1..10): { type: \"property.set\", propertySchemaId, value, idx? } | { type: \"class.assign\", classId } — each translates to an EXISTING wire op at execution time (class.assign → object.create re-issue with classIds), validated against the wire payload schema. 409 at the 100-rules-per-workspace cap.",
    tags: ["Workflows"],
    requestBody: {
      type: "object",
      additionalProperties: true,
      description: "{ name, enabled?, trigger: { opType }, criteria: QueryAst v1, actions: [property.set | class.assign] } — strict; unknown keys rejected",
    },
    success: { status: 201, description: "{ rule }" },
    errors: ["validation_failed", "conflict"],
  }],
  ["get", "/api/workflows/:id", {
    summary: "One workflow rule (any authenticated principal)",
    description: "issue #13: 404 outside the default workspace.",
    tags: ["Workflows"],
    errors: ["not_found"],
  }],
  ["patch", "/api/workflows/:id", {
    summary: "Merge-patch a workflow rule (owner/admin only)",
    description:
      "issue #13: any of name/enabled/trigger/criteria/actions; present fields are re-validated exactly as on create (criteria: strict QueryAST, no aggregation, trial-compiled).",
    tags: ["Workflows"],
    requestBody: {
      type: "object",
      additionalProperties: true,
      description: "subset of the create body; at least one field required",
    },
    errors: ["validation_failed", "not_found"],
  }],
  ["delete", "/api/workflows/:id", {
    summary: "Delete a workflow rule (owner/admin only)",
    description: "issue #13: the run audit is NOT cascade-deleted — the rows stay in relay.db for forensics but become unreachable through the API (runs list 404s with the rule gone).",
    tags: ["Workflows"],
    errors: ["not_found"],
  }],
  ["get", "/api/workflows/:id/runs", {
    summary: "The append-only run audit of a rule, newest first (any authenticated principal; capped page)",
    description:
      "issue #13: one row per (rule, trigger envelope, matched node) firing attempt. outcome ∈ actions_written | actions_failed | skipped_loop | skipped_depth_cap — the last two are the loop policy made observable: engine envelopes never re-trigger the same rule (skipped_loop), and rule chains beyond depth 1 do not execute (skipped_depth_cap). A failed action ingest is recorded with its error and never blocks the triggering ingest.",
    tags: ["Workflows"],
    errors: ["not_found"],
  }],
];

function toOpenApiPath(fastifyPath: string): string {
  return fastifyPath.replace(/:([A-Za-z]+)/g, "{$1}");
}

/** Build the document. Called once per process by routes-meta; cached there. */
export function buildOpenApiDocument(serverVersion: string): JsonSchema {
  const paths: JsonSchema = {};
  for (const [method, fastifyPath, spec] of ROUTES) {
    const openApiPath = toOpenApiPath(fastifyPath);
    const pathItem = ((paths[openApiPath] ??= {}) as JsonSchema);
    pathItem[method] = operationFor({ ...spec, __path: fastifyPath });
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Notees server API",
      version: serverVersion,
      description:
        "The HTTP surface of the Notees sync server: the object/assets machine API under /api (every write is an envelope through the one write path), the relay sync API under /api/relay/v2 (WIRE.md is its normative spec), and account routes. Auth: `X-API-Key` (operator key or per-user API key) or `Authorization: Bearer` (session token) on every route except the public probes; workspace selection via `X-Workspace-Id` (else the server default). This document is served at GET /api/openapi.json and gated by a route-coverage test (every registered route must appear here). Versioning policy: paths stay UNVERSIONED forever (`/api/*`, no `/api/v2`); the API version IS the server's X.Y.Z semver, self-described at `GET /api/meta` (`version`) and `GET /api/version`; additive changes ship inside a version per the WIRE.md culture (additive-doesn't-bump, fail-loud on a newer `protocolVersion`); wire-affecting changes ride the three-client lockstep (git tags remain the release mechanism).",
    },
    servers: [{ url: "/" }],
    "x-versioning-policy": {
      scheme: "server-semver",
      versionHeader: null,
      versionProbe: ["GET /api/meta", "GET /api/version"],
      pathsVersioned: false,
      additiveCulture: "WIRE.md — additive-doesn't-bump; fail-loud on newer protocolVersion",
      decided: " (X.Y.Z from v3.0.0; the 2.0.0-mN milestone tags retired)",
    },
    tags: [
      { name: "Meta", description: "Public probes and developer self-description" },
      { name: "Account", description: "Setup, sessions, profile, API keys" },
      { name: "Workspaces", description: "Membership-scoped workspace management and export" },
      { name: "Objects", description: "Node CRUD, class membership, trash/restore" },
      { name: "Properties", description: "Typed property values and schemas" },
      { name: "Search & Query", description: "FTS search and the compiled QueryAST" },
      { name: "Classes", description: "The class catalog (classes are nodes)" },
      { name: "Assets", description: "Content-addressed asset storage" },
      { name: "Relay", description: "Sync API — WIRE.md is the normative spec" },
      { name: "Plugins", description: "Inert plugin-manifest registry (schema + storage shipped; the runtime is parked)" },
      { name: "Shares", description: "Read-only public page shares — token management (owner/admin) + the unauthenticated GET /s/:token view" },
      { name: "Workflows", description: "Server-side workflow rules (issue #13) — \"when X happens to nodes matching Y, do Z\": rule CRUD (read: any authenticated principal; write: owner/admin) + the append-only run audit. Coordination state, not log state; effects are ordinary ops by a server actor" },
    ],
    paths,
    components: {
      schemas: {
        ErrorEnvelope: {
          type: "object",
          additionalProperties: false,
          required: ["error"],
          properties: {
            error: {
              type: "object",
              additionalProperties: false,
              required: ["code", "message", "status"],
              properties: {
                code: { type: "string", enum: Object.keys(ERROR_TAXONOMY) },
                message: { type: "string" },
                status: { type: "integer" },
              },
            },
          },
        },
      },
    },
    // Cross-cutting facts, all backed by code (see module header).
    "x-error-codes": Object.fromEntries(
      Object.entries(ERROR_TAXONOMY).map(([code, entry]) => [
        code,
        { status: entry.status, description: entry.description },
      ]),
    ),
    "x-rate-limits": {
      note: "Single fixed-window limiters, in-process (restart clears counters). 429 answers carry code rate_limited (account lockouts: account_locked). Per-endpoint-class tightening is follow-up work.",
      global: {
        default: "10000 req/min/IP",
        env: "NOTEES_GLOBAL_REQ_PER_MINUTE",
        appliesTo: "every route except /healthz",
      },
      relayBatch: {
        default: "30000 envelopes/min/workspace",
        env: "NOTEES_RELAY_BATCH_PER_MINUTE",
        appliesTo: "POST /api/relay/v2/batch (and WS batch frames), charged per envelope",
      },
      login: {
        default: "10 attempts/min/IP",
        env: "NOTEES_LOGIN_PER_MINUTE",
        appliesTo: "POST /api/auth/login, POST /api/auth/signup",
        accountLockout: "5 failures within 15 min locks the account for 15 min (429 account_locked, in-memory)",
      },
    },
    "x-api-key-scopes": {
      note: "POST /api/api-keys accepts an optional `scopes` list; keys created without one (and the operator key, and account sessions) are unrestricted. Enforcement is per-route via the x-required-scope operation extension: a scoped key calling a route outside its set gets 403 scope_denied.",
      vocabulary: API_SCOPES,
      reservedNotYetEnforced: [
        "relations.read",
        "relations.write",
        "annotations",
        "citations",
        "collections.write",
      ],
      mapping: {
        "objects.read": "GET /api/classes*, /api/property-schemas*, /api/properties/:id/values, GET /api/features, GET /api/operations (plan-07 retired the object/search/query content reads — clients read their local derived stores)",
        "objects.write": "POST/PATCH/DELETE /api/property-schemas, class property bind/unbind (plan-07 retired the object write API — content changes ride the relay log)",
        "objects.delete": "retired with the object API (plan-07)",
        "assets.read": "GET /api/assets/*",
        "assets.write": "POST /api/assets",
        "search": "GET /api/resolve (name→id + the metadata resolver), POST /api/resolve/pdf (the PDF→DOI flow) — /api/search and /api/query retired (plan-07)",
        "export": "retired (plan-07) — the web client builds the workspace zip locally",
        "admin": "the whole /api/plugins surface — the FIRST enforcement of the reserved admin scope; sessions additionally require the administrator flag (routes-plugins requireAdmin)",
      },
      relaySurface: "scoped keys are rejected on all /api/relay/v2 routes (403 scope_denied)",
      accountRoutes: "account routes keep requiring an account session (or key self-revocation); scopes never widen that",
    },
    "x-revision-checks": {
      note: "Only PATCH /api/objects/:id honors the optional `baseRevision` guard: the node row's (hlc_physical, hlc_logical) — bumped by object.update and object.move — is the one natural per-node revision. Property slots carry per-slot LWW rows, deletes/restore trash-state semantics have no meaningful base, and creates address a not-yet-existing node; a base check on those would be misleading, so it is deliberately not offered (op-log LWW governs).",
      honoredBy: ["PATCH /api/objects/:id"],
      staleBaseAnswer: "409 conflict",
    },
    "x-idempotency-key": {
      note: "Operations flagged x-idempotency-key replay the first successful (2xx) response within 24h for an identical replay (method + URL + body); a key reused with a different request fails 409 idempotency_replay. Multipart uploads are excluded (CAS hash dedupe). In-memory, single-process.",
      window: "24h",
      replayHeader: "x-idempotency-replay: true marks a replayed response",
    },
  };
}

/**
 * The documented route inventory, in Fastify form (method + `:param` path)
 * with each route's enforced scope. The coverage test compares this against
 * the live Fastify registration (a route added in code but not here fails
 * CI), and app.ts builds the scope-enforcement map from `requiredScope` — the
 * OpenAPI `x-required-scope` extension and the middleware are one source of
 * truth.
 */
export function documentedRoutes(): Array<{ method: string; path: string; requiredScope?: string }> {
  return ROUTES.map(([method, path, spec]) => ({
    method: method.toUpperCase(),
    path,
    ...(spec.requiredScope !== undefined ? { requiredScope: spec.requiredScope } : {}),
  }));
}
