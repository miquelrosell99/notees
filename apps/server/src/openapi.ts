/**
 * The OpenAPI 3.1 contract of the HTTP surface (§34.33 AG4) — served at
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
 *  - `x-error-codes` — the AC2 pinned taxonomy (src/errors.ts).
 *  - `x-rate-limits`  — the three real fixed-window limiters (AG10).
 *  - `x-api-key-scopes` — the AG3 scope vocabulary and enforcement rules.
 *  - `x-revision-checks` — which mutations honor `baseRevision` (AG5), and
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
  /** Path parameters beyond `:id` (always described as uuid). */
  params?: Record<string, string>;
  /** Query parameters the route reads (name → description). */
  query?: Record<string, { description: string; type?: string; required?: boolean }>;
  requestBody?: JsonSchema;
  /** Response for the success status: description + schema. */
  success?: { status?: number; description: string; schema?: JsonSchema };
  /** §34.33 AG3: scope a scoped API key must carry for this operation. */
  requiredScope?: string;
  /** §34.33 AG5: the mutation honors the Idempotency-Key header. */
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
      description: "UUIDv7 node/class/property-schema/workspace id (identity is always the uuid).",
      schema: { type: "string", format: "uuid" },
    });
  }
  for (const [name, description] of Object.entries(spec.params ?? {})) {
    parameters.push({
      name,
      in: "path",
      required: true,
      description,
      schema: { type: "string", format: "uuid" },
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
    presentAsMain: { type: "boolean", description: "render bit for parented non-class nodes" },
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
    presentAsMain: { type: "boolean", description: "render-bit toggle (promotion/demotion)" },
    icon: { type: "string" },
    color: { description: "preset token or #RRGGBB; null clears (SCHEMA.md color grammar)" },
    contentAst: { type: "array", items: { type: "object", additionalProperties: true } },
    baseRevision: {
      type: "object",
      additionalProperties: false,
      properties: { physical: { type: "integer" }, logical: { type: "integer" } },
      description:
        "§34.33 AG5 optimistic-concurrency guard: the node's `hlc` as last seen; a stale value fails 409 conflict. The field never enters the op payload (HTTP-layer check only).",
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
        "optional scope set (§34.33 AG3); omit for the unrestricted M1 default. Scoped keys are object-API-only: the relay surface rejects them with 403 scope_denied.",
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
      "§34.33 AG5. The default workspace id is a fixed system uuid (identity.ts), safe to expose unauthenticated; per-account workspace listing lives behind auth at GET /api/workspaces.",
    tags: ["Meta"],
    public: true,
  }],
  ["get", "/api/openapi.json", {
    summary: "This OpenAPI 3.1 document (the published HTTP contract, §34.33 AG4)",
    tags: ["Meta"],
    public: true,
  }],
  ["get", "/api/operations", {
    summary: "Paginated read of the workspace's relay operation log (§34.33 AG5 agent-safety feed)",
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
    summary: "First-run probe: setupRequired, version, protocol versions",
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
  ["post", "/api/auth/logout", {
    summary: "Revoke the current session (session token required)",
    tags: ["Account"],
  }],
  ["get", "/api/auth/me", {
    summary: "The authenticated account",
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
  ["get", "/api/workspaces", {
    summary: "The account's workspaces (membership view, with envelope stats)",
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
  ["get", "/api/workspaces/:id/export.zip", {
    summary: "Full-workspace Markdown zip (one file per page, manifest, optional assets/)",
    tags: ["Workspaces"],
    requiredScope: "export",
    query: {
      includeAssets: { description: "1 bundles the CAS bytes of every asset_ref'd asset under assets/", type: "string" },
    },
    success: { description: "application/zip bundle", schema: { type: "string", format: "binary" } },
    errors: ["validation_failed", "not_found"],
  }],
  ["get", "/api/nodes/:id/location", {
    summary: "Which of the account's workspaces holds a node (deep-link resolution)",
    tags: ["Workspaces"],
    errors: ["not_found"],
  }],
  ["get", "/api/api-keys", {
    summary: "List the account's API keys (session required; keys are name + scopes + prefix)",
    tags: ["Account"],
  }],
  ["post", "/api/api-keys", {
    summary: "Mint an API key (full token returned exactly once; sha256 at rest)",
    description:
      "§34.33 AG3: an optional `scopes` list makes the key a scoped object-API credential. Omit scopes for the unrestricted M1 default.",
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
  ["get", "/api/objects", {
    summary: "List objects (paginated, filterable)",
    description:
      "`presentAsMain` selects the document-chrome rows (pages), its negation the inline body; `trashed=true` scans the trash. Cursor pagination by id (nextCursor).",
    tags: ["Objects"],
    requiredScope: "objects.read",
    query: {
      isClass: { description: "class identity bit filter (true/false)", type: "string" },
      presentAsMain: { description: "render-bit filter (true/false)", type: "string" },
      class: { description: "class uuid — members of that class", type: "string" },
      parent: { description: "direct-children filter (parent_id)", type: "string" },
      trashed: { description: "true lists inactive (trashed) rows", type: "string" },
      q: { description: "full-text search term", type: "string" },
      property: { description: "`<schemaId>:<value>` exact property match", type: "string" },
      limit: { description: "page size (default 50, max 500)", type: "integer" },
      cursor: { description: "id cursor from a previous nextCursor", type: "string" },
    },
    errors: ["validation_failed"],
  }],
  ["post", "/api/objects", {
    summary: "Create an object (or declare a class with isClass: true)",
    description:
      "Every write is an envelope through the one write path. A caller-chosen `id` that is taken fails 409 conflict (idempotent-create, kept distinct from Idempotency-Key replay).",
    tags: ["Objects"],
    requestBody: createObjectBody,
    success: { status: 201, description: "{ id, object }" },
    requiredScope: "objects.write",
    idempotency: true,
    errors: ["validation_failed", "not_found", "conflict"],
  }],
  ["get", "/api/objects/:id", {
    summary: "Fetch one object (contentAst, classes, properties)",
    tags: ["Objects"],
    requiredScope: "objects.read",
    errors: ["not_found"],
  }],
  ["patch", "/api/objects/:id", {
    summary: "Update an object (render bit, icon, color, contentAst)",
    description:
      "§34.33 AG5: the only mutation with a natural per-node revision — the node's `hlc`, bumped by object.update/object.move — so it is the only route honoring the optional `baseRevision` guard (409 conflict on stale). Property slots carry their own per-slot revision and are LWW by the op log; a base check there would be misleading and is deliberately not offered.",
    tags: ["Objects"],
    requestBody: updateObjectBody,
    requiredScope: "objects.write",
    idempotency: true,
    errors: ["validation_failed", "not_found", "conflict"],
  }],
  ["delete", "/api/objects/:id", {
    summary: "Trash an object (subtree); ?permanent=true&confirm=<id> hard-deletes",
    tags: ["Objects"],
    requiredScope: "objects.delete",
    idempotency: true,
    query: {
      permanent: { description: "hard-delete instead of trash", type: "string" },
      confirm: { description: "must equal the object id when permanent=true", type: "string" },
    },
    errors: ["validation_failed", "not_found"],
  }],
  ["get", "/api/objects/:id/children", {
    summary: "Direct children in child-position order (both render zones; active only)",
    tags: ["Objects"],
    requiredScope: "objects.read",
    errors: ["not_found"],
  }],
  ["post", "/api/objects/:id/restore", {
    summary: "Restore from the trash (whole-tree, the object.restore op)",
    tags: ["Objects"],
    requiredScope: "objects.write",
    idempotency: true,
    errors: ["not_found", "validation_failed"],
  }],
  ["get", "/api/objects/:id/backlinks", {
    summary: "Edges pointing at the node (mentions, typed links, property refs)",
    tags: ["Objects"],
    requiredScope: "objects.read",
  }],
  ["get", "/api/objects/:id/effective-properties", {
    summary: "Authored property values ∪ derived class-binding defaults (source/boundBy)",
    tags: ["Objects"],
    requiredScope: "objects.read",
  }],
  ["put", "/api/objects/:id/classes/:classId", {
    summary: "Assign the object to a class (idempotent OR-Set add via the object.create carrier)",
    tags: ["Objects"],
    params: { classId: "class uuid (a class node's id — classes are nodes)" },
    requiredScope: "objects.write",
    idempotency: true,
    errors: ["validation_failed", "not_found"],
  }],
  ["delete", "/api/objects/:id/classes/:classId", {
    summary: "Remove the class membership (idempotent tombstone)",
    tags: ["Objects"],
    params: { classId: "class uuid" },
    requiredScope: "objects.write",
    idempotency: true,
    errors: ["validation_failed", "not_found"],
  }],
  ["post", "/api/objects/:id/properties", {
    summary: "Set a typed property value (property.set)",
    tags: ["Properties"],
    requestBody: propertyWriteBody,
    requiredScope: "objects.write",
    idempotency: true,
    errors: ["validation_failed", "not_found"],
  }],
  ["delete", "/api/objects/:id/properties/:propertySchemaId", {
    summary: "Unset a typed property value (property.unset; ?idx selects the slot)",
    tags: ["Properties"],
    params: { propertySchemaId: "property schema uuid" },
    requiredScope: "objects.write",
    idempotency: true,
    query: { idx: { description: "slot index (default 0)", type: "integer" } },
    errors: ["validation_failed", "not_found"],
  }],

  // --- search & query -------------------------------------------------------------------
  ["get", "/api/search", {
    summary: "Full-text search over active nodes (FTS index)",
    tags: ["Search & Query"],
    requiredScope: "search",
    query: {
      q: { description: "search term", type: "string", required: true },
      isClass: { description: "class identity bit filter", type: "string" },
      presentAsMain: { description: "render-bit filter", type: "string" },
      limit: { description: "max results (default 50, max 500)", type: "integer" },
    },
    errors: ["validation_failed"],
  }],
  ["post", "/api/query", {
    summary: "Arbitrary QueryAST execution (the compiled query language)",
    description:
      "The caller compiles its text DSL (or builds an AST) and posts it; the server runs the parameterized AST→SQL compiler (@notees/query) against the derived store. Unparseable ASTs and unsupported compilations are 422 — fail loud, never half-executed.",
    tags: ["Search & Query"],
    requestBody: queryBody,
    requiredScope: "search",
    errors: ["validation_failed"],
  }],

  // --- classes & property schemas -------------------------------------------------------
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
  ["get", "/api/properties/:id/values", {
    summary: "Values asserted for a property schema (across nodes)",
    tags: ["Properties"],
    requiredScope: "objects.read",
  }],

  // --- assets ---------------------------------------------------------------------------
  ["post", "/api/assets", {
    summary: "Multipart upload (magic-byte sniffed; CAS by sha256)",
    description:
      "Idempotency-Key is deliberately NOT honored here: identical bytes dedupe to one CAS hash, which is the honest idempotency story for uploads. Optional multipart field `objectId` emits an asset.attach envelope.",
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

  // --- relay (WIRE.md §1–2) -----------------------------------------------------------
  ["post", "/api/relay/v2/batch", {
    summary: "Ingest a batch of envelopes (idempotent by envelope id)",
    description:
      "Scoped API keys are rejected on the whole relay surface with 403 scope_denied — scoped keys are object-API credentials (§34.33 AG3).",
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
    tags: ["Relay"],
    query: { workspaceId: { description: "workspace uuid", type: "string", required: true } },
    success: { description: "the serialized derived-state SQLite bytes", schema: { type: "string", format: "binary" } },
    errors: ["validation_failed", "not_found"],
  }],
  ["put", "/api/relay/v2/snapshot/data", {
    summary: "Publish snapshot bytes (raw body)",
    tags: ["Relay"],
    query: {
      workspaceId: { description: "workspace uuid", type: "string", required: true },
      physical: { description: "HLC physical component", type: "integer", required: true },
      logical: { description: "HLC logical component", type: "integer", required: true },
    },
    success: { status: 201, description: "the new snapshot id" },
    errors: ["validation_failed"],
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
      "Not plain HTTP: upgrade endpoint. Auth via ?token= or Authorization header; the credential is re-checked per batch frame. Fail loud on newer framing versions (WIRE.md §2).",
    tags: ["Relay"],
    params: { workspaceId: "workspace uuid" },
    webSocket: true,
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
        "The HTTP surface of the Notees sync server: the object/assets machine API under /api (every write is an envelope through the one write path), the relay sync API under /api/relay/v2 (WIRE.md is its normative spec), and account routes. Auth: `X-API-Key` (operator key or per-user API key) or `Authorization: Bearer` (session token) on every route except the public probes; workspace selection via `X-Workspace-Id` (else the server default). This document is served at GET /api/openapi.json and gated by a route-coverage test (every registered route must appear here).",
    },
    servers: [{ url: "/" }],
    tags: [
      { name: "Meta", description: "Public probes and developer self-description" },
      { name: "Account", description: "Setup, sessions, profile, API keys" },
      { name: "Workspaces", description: "Membership-scoped workspace management and export" },
      { name: "Objects", description: "Node CRUD, class membership, trash/restore" },
      { name: "Properties", description: "Typed property values and schemas" },
      { name: "Search & Query", description: "FTS search and the compiled QueryAST" },
      { name: "Classes", description: "The class catalog (classes are nodes)" },
      { name: "Assets", description: "Content-addressed asset storage" },
      { name: "Relay", description: "Sync API — WIRE.md §1–2 is the normative spec" },
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
      note: "Single fixed-window limiters, in-process (restart clears counters). 429 answers carry code rate_limited (account lockouts: account_locked). Per-endpoint-class tightening is §34.33 AG10 follow-up.",
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
        appliesTo: "POST /api/auth/login",
        accountLockout: "5 failures within 15 min locks the account for 15 min (429 account_locked, in-memory)",
      },
    },
    "x-api-key-scopes": {
      note: "§34.33 AG3. POST /api/api-keys accepts an optional `scopes` list; keys created without one (and the operator key, and account sessions) are unrestricted. Enforcement is per-route via the x-required-scope operation extension: a scoped key calling a route outside its set gets 403 scope_denied.",
      vocabulary: API_SCOPES,
      reservedNotYetEnforced: [
        "relations.read",
        "relations.write",
        "annotations",
        "citations",
        "collections.write",
        "admin",
      ],
      mapping: {
        "objects.read": "GET /api/objects*, /api/classes*, /api/property-schemas*, /api/properties/:id/values, /api/objects/:id/backlinks|effective-properties|children, GET /api/operations",
        "objects.write": "POST/PATCH /api/objects, class assign/unassign, property set/unset, restore, POST /api/property-schemas",
        "objects.delete": "DELETE /api/objects/:id",
        "assets.read": "GET /api/assets/*",
        "assets.write": "POST /api/assets",
        "search": "GET /api/search, POST /api/query",
        "export": "GET /api/workspaces/:id/export.zip",
      },
      relaySurface: "scoped keys are rejected on all /api/relay/v2 routes (403 scope_denied)",
      accountRoutes: "account routes keep requiring an account session (or key self-revocation); scopes never widen that",
    },
    "x-revision-checks": {
      note: "§34.33 AG5. Only PATCH /api/objects/:id honors the optional `baseRevision` guard: the node row's (hlc_physical, hlc_logical) — bumped by object.update and object.move — is the one natural per-node revision. Property slots carry per-slot LWW rows, deletes/restore trash-state semantics have no meaningful base, and creates address a not-yet-existing node; a base check on those would be misleading, so it is deliberately not offered (op-log LWW governs).",
      honoredBy: ["PATCH /api/objects/:id"],
      staleBaseAnswer: "409 conflict",
    },
    "x-idempotency-key": {
      note: "§34.33 AG5. Operations flagged x-idempotency-key replay the first successful (2xx) response within 24h for an identical replay (method + URL + body); a key reused with a different request fails 409 idempotency_replay. Multipart uploads are excluded (CAS hash dedupe). In-memory, single-process.",
      window: "24h",
      replayHeader: "x-idempotency-replay: true marks a replayed response",
    },
  };
}

/**
 * The documented route inventory, in Fastify form (method + `:param` path)
 * with each route's enforced scope. The coverage test compares this against
 * the live Fastify registration (a route added in code but not here fails
 * CI), and app.ts builds the AG3 enforcement map from `requiredScope` — the
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
