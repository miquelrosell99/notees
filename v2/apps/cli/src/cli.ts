#!/usr/bin/env node
/**
 * `notees` — the Notees v2 CLI.
 *
 * Every command supports --json (stable machine output), --server <url> and
 * --key <nk_…> (env NOTEES_SERVER / NOTEES_API_KEY as fallbacks) and the
 * global --profile. Exit codes: 0 ok, 1 domain error, 2 usage, 3 auth,
 * 4 conflict, 5 network. Destructive commands require --yes: without it they
 * print a blast-radius preview and exit 2 (never an interactive prompt when
 * --json or non-tty).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Command, CommanderError, Option } from "commander";

import {
  bundleMarkdown,
  concatBundleMarkdown,
  deriveDisplayName,
  type ExportContext,
  type ExportNode,
} from "@notees/export";

import { ApiClient } from "./client.js";
import { CliError, EXIT } from "./exit-codes.js";
import { defaultStatePath, serverState } from "./state.js";
import { DEFAULT_WORKSPACE_ID } from "./uuid.js";

const API_KEY_PATTERN = /^nk_[A-Za-z0-9_-]{32}$/;

export interface CliIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  stdin?: NodeJS.ReadableStream | undefined;
  isTty?: boolean;
}

const defaultIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
  isTty: process.stdout.isTTY === true,
};

interface GlobalOptions {
  json?: boolean;
  server?: string;
  key?: string;
  profile?: string;
}

interface CommandContext {
  io: CliIo;
  opts: GlobalOptions;
  client: ApiClient;
  statePath: string;
}

function emit(ctx: CommandContext, human: string, machine: unknown): void {
  if (ctx.opts.json) {
    ctx.io.stdout.write(`${JSON.stringify(machine, null, 2)}\n`);
  } else {
    ctx.io.stdout.write(human);
  }
}

function failUsage(message: string): never {
  throw new CliError(EXIT.usage, message);
}

function requireServerAndKey(opts: GlobalOptions): { server: string; apiKey: string } {
  const server = opts.server ?? process.env.NOTEES_SERVER;
  const apiKey = opts.key ?? process.env.NOTEES_API_KEY;
  if (server === undefined || server.length === 0) {
    failUsage("server URL required: pass --server <url> or set NOTEES_SERVER");
  }
  if (apiKey === undefined || apiKey.length === 0) {
    failUsage("API key required: pass --key <nk_…> or set NOTEES_API_KEY");
  }
  if (!API_KEY_PATTERN.test(apiKey)) {
    failUsage(`API key must match ${API_KEY_PATTERN} (got "${apiKey.slice(0, 8)}…")`);
  }
  return { server, apiKey };
}

function readStdin(io: CliIo): Promise<string> {
  const stdin = io.stdin ?? process.stdin;
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding?.("utf8");
    stdin.on("data", (chunk) => {
      data += String(chunk);
    });
    stdin.on("end", () => resolve(data));
    stdin.on("error", reject);
  });
}

function queryString(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== "");
  if (entries.length === 0) return "";
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}`;
}

// --- command handlers --------------------------------------------------------

async function objectGet(ctx: CommandContext, id: string): Promise<void> {
  const body = await ctx.client.getJson<{ object: unknown }>(`/api/v1/objects/${encodeURIComponent(id)}`);
  emit(ctx, `${JSON.stringify(body.object, null, 2)}\n`, body);
}

async function objectCreate(ctx: CommandContext, options: {
  nodeType?: string;
  name?: string;
  class?: string[];
  parent?: string;
  stdin?: boolean;
}): Promise<void> {
  let body: Record<string, unknown> = {};
  if (options.stdin === true) {
    const raw = await readStdin(ctx.io);
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new CliError(EXIT.usage, "--stdin body is not valid JSON");
    }
  }
  if (options.nodeType !== undefined) body.nodeType = options.nodeType;
  if (options.name !== undefined) body.name = options.name;
  if (options.parent !== undefined) body.parentId = options.parent;
  const classIds = options.class ?? [];
  if (classIds.length > 0) body.classIds = classIds;
  const created = await ctx.client.postJson<{ id: string; object: unknown }>("/api/v1/objects", body);
  // Non-json prints the new id only (script-friendly).
  emit(ctx, `${created.id}\n`, created);
}

async function objectUpdate(ctx: CommandContext, id: string, options: {
  name?: string;
  nodeType?: string;
  icon?: string;
  color?: string;
}): Promise<void> {
  const body: Record<string, unknown> = {};
  if (options.name !== undefined) body.name = options.name;
  if (options.nodeType !== undefined) body.nodeType = options.nodeType;
  if (options.icon !== undefined) body.icon = options.icon;
  if (options.color !== undefined) body.color = options.color;
  if (Object.keys(body).length === 0) {
    failUsage("object update requires at least one of --name, --nodeType, --icon, --color");
  }
  const updated = await ctx.client.patchJson<{ object: unknown }>(
    `/api/v1/objects/${encodeURIComponent(id)}`,
    body,
  );
  emit(ctx, `${JSON.stringify(updated.object, null, 2)}\n`, updated);
}

async function objectDelete(ctx: CommandContext, id: string, options: { permanent?: boolean; yes?: boolean }): Promise<void> {
  const permanent = options.permanent === true;
  if (options.yes !== true) {
    // Blast-radius preview — never prompt when --json or non-tty.
    let preview: { name?: string | null; nodeType?: string } = {};
    try {
      const fetched = await ctx.client.getJson<{ object: { name?: string | null; nodeType?: string } }>(
        `/api/v1/objects/${encodeURIComponent(id)}`,
      );
      preview = fetched.object;
    } catch (error) {
      if (error instanceof CliError && error.exitCode === EXIT.domain) throw error;
      throw error;
    }
    const scope = permanent ? "permanently delete (unrecoverable)" : "move to trash";
    const label = preview.name !== null && preview.name !== undefined && preview.name.length > 0 ? `"${preview.name}"` : id;
    ctx.io.stderr.write(
      `Refusing to ${scope} ${label} (${preview.nodeType ?? "object"}) without confirmation.\n` +
        `Re-run with --yes to proceed. Deleted object id: ${id}\n`,
    );
    throw new CliError(EXIT.usage, "destructive command requires --yes", { preview });
  }
  const query = permanent ? `?permanent=true&confirm=${encodeURIComponent(id)}` : "";
  const result = await ctx.client.deleteJson<{ id: string; deleted: boolean; permanent: boolean }>(
    `/api/v1/objects/${encodeURIComponent(id)}${query}`,
  );
  emit(ctx, `deleted ${result.id}${result.permanent ? " (permanent)" : ""}\n`, result);
}

async function objectList(ctx: CommandContext, options: {
  nodeType?: string;
  class?: string[];
  q?: string;
  limit?: string;
  cursor?: string;
}): Promise<void> {
  const classes = options.class ?? [];
  const query = queryString({
    nodeType: options.nodeType,
    ...(classes.length === 1 ? { class: classes[0] } : {}),
    q: options.q,
    limit: options.limit !== undefined ? Number.parseInt(options.limit, 10) : undefined,
    cursor: options.cursor,
  });
  const body = await ctx.client.getJson<unknown>(`/api/v1/objects${query}`);
  emit(ctx, `${JSON.stringify(body, null, 2)}\n`, body);
}

async function search(ctx: CommandContext, queryText: string, options: { nodeType?: string }): Promise<void> {
  const query = queryString({ q: queryText, nodeType: options.nodeType });
  const body = await ctx.client.getJson<unknown>(`/api/v1/search${query}`);
  emit(ctx, `${JSON.stringify(body, null, 2)}\n`, body);
}

async function classList(ctx: CommandContext): Promise<void> {
  const body = await ctx.client.getJson<unknown>("/api/v1/classes");
  emit(ctx, `${JSON.stringify(body, null, 2)}\n`, body);
}

async function backlinks(ctx: CommandContext, id: string): Promise<void> {
  const body = await ctx.client.getJson<unknown>(`/api/v1/objects/${encodeURIComponent(id)}/backlinks`);
  emit(ctx, `${JSON.stringify(body, null, 2)}\n`, body);
}

async function assetAdd(ctx: CommandContext, filePath: string, options: { object?: string }): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new CliError(EXIT.usage, `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const form = new FormData();
  form.append("file", new Blob([bytes]), basename(filePath));
  if (options.object !== undefined) form.append("objectId", options.object);
  const body = await ctx.client.postMultipart<{ assetId: string }>("/api/v1/assets", form);
  emit(ctx, `${body.assetId}\n`, body);
}

async function assetGet(ctx: CommandContext, id: string, options: { output?: string }): Promise<void> {
  const response = await ctx.client.getBytes(`/api/v1/assets/${encodeURIComponent(id)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (options.output !== undefined) {
    writeFileSync(options.output, bytes);
    emit(ctx, `wrote ${bytes.length} bytes to ${options.output}\n`, { output: options.output, bytes: bytes.length });
    return;
  }
  ctx.io.stdout.write(bytes.toString("binary"));
}

async function syncStatus(ctx: CommandContext): Promise<void> {
  const stats = await ctx.client.getJson<{ envelopeCount: number; restoreEpoch: number; maxHlc: { physical: number; logical: number } }>(
    `/api/relay/v2/stats?workspaceId=${DEFAULT_WORKSPACE_ID}`,
  );
  const stateKey = `${ctx.opts.profile ?? "default"}:${ctx.client.server}`;
  const local = serverState(ctx.statePath, stateKey);
  const cursorSeq = local.cursorSeq ?? 0;
  const machine = {
    server: ctx.client.server,
    workspaceId: DEFAULT_WORKSPACE_ID,
    envelopeCount: stats.envelopeCount,
    restoreEpoch: stats.restoreEpoch,
    maxHlc: stats.maxHlc,
    localCursorSeq: cursorSeq,
    behind: Math.max(0, stats.envelopeCount - cursorSeq),
  };
  emit(
    ctx,
    `server ${machine.server}: ${machine.envelopeCount} envelopes (restoreEpoch ${machine.restoreEpoch})\n` +
      `local cursor: seq ${machine.localCursorSeq} — ${machine.behind} behind\n`,
    machine,
  );
}

async function doctor(ctx: CommandContext): Promise<void> {
  const report: { check: string; ok: boolean; detail: string }[] = [];
  let worst: number = EXIT.ok;

  const push = (check: string, ok: boolean, detail: string, code: number) => {
    report.push({ check, ok, detail });
    if (!ok && code > worst) worst = code;
  };

  const server = ctx.opts.server ?? process.env.NOTEES_SERVER;
  const apiKey = ctx.opts.key ?? process.env.NOTEES_API_KEY;
  push("server configured", server !== undefined && server.length > 0, server ?? "missing (--server or NOTEES_SERVER)", EXIT.usage);
  push("api key configured", apiKey !== undefined && apiKey.length > 0, apiKey !== undefined ? "present" : "missing (--key or NOTEES_API_KEY)", EXIT.usage);
  if (apiKey !== undefined) {
    push("api key shape", API_KEY_PATTERN.test(apiKey), API_KEY_PATTERN.test(apiKey) ? "nk_ + 32 chars" : "malformed", EXIT.usage);
  }

  if (server !== undefined && server.length > 0) {
    try {
      const version = await ctx.client.getJson<{ name: string; version: string; protocolVersion: number }>("/api/v1/version");
      push("server reachable", true, `${version.name} ${version.version} (protocol v${version.protocolVersion})`, EXIT.ok);
    } catch (error) {
      if (error instanceof CliError) {
        push("server reachable", false, error.message, error.exitCode);
      } else {
        push("server reachable", false, String(error), EXIT.network);
      }
    }
    if (apiKey !== undefined && API_KEY_PATTERN.test(apiKey)) {
      try {
        await ctx.client.getJson<unknown>(`/api/relay/v2/stats?workspaceId=${DEFAULT_WORKSPACE_ID}`);
        push("authentication", true, "API key accepted", EXIT.ok);
      } catch (error) {
        if (error instanceof CliError) {
          push("authentication", false, error.message, error.exitCode);
        } else {
          push("authentication", false, String(error), EXIT.network);
        }
      }
    }
  }

  const lines = report.map((entry) => `${entry.ok ? "ok" : "FAIL"}  ${entry.check}: ${entry.detail}`);
  emit(ctx, `${lines.join("\n")}\n`, { ok: worst === EXIT.ok, checks: report });
  if (worst !== EXIT.ok) {
    throw new CliError(worst as 0 | 1 | 2 | 3 | 4 | 5, `doctor found failing checks (exit ${worst})`, { report });
  }
}

// --- export --------------------------------------------------------------------

interface ExportApiObject {
  id: string;
  nodeType: string;
  parentId: string | null;
  classIds: string[];
  name: string | null;
  contentAst?: unknown;
  properties?: { schemaId: string; schemaName: string; value: unknown; metadata?: unknown }[];
}

interface ApiEdgeRow {
  id: string;
  source_id: string;
  target_id: string | null;
  type: string;
  verb: string | null;
}

interface ApiObjectStub {
  id: string;
  nodeType: string;
  parentId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toExportNode(obj: ExportApiObject): ExportNode {
  const nodeType = (
    obj.nodeType === "page" || obj.nodeType === "class" ? obj.nodeType : "block"
  ) as ExportNode["nodeType"];
  return {
    id: obj.id,
    nodeType,
    name: obj.name ?? null,
    contentAst: Array.isArray(obj.contentAst) ? (obj.contentAst as ExportNode["contentAst"]) : [],
    classIds: Array.isArray(obj.classIds) ? obj.classIds : [],
    properties: (Array.isArray(obj.properties) ? obj.properties : []).map((property) => ({
      schemaId: property.schemaId,
      schemaName: property.schemaName,
      value: property.value,
      ...(isRecord(property.metadata) ? { metadata: property.metadata } : {}),
    })),
  };
}

/** Collect every id export rendering may resolve: mentions, chips, bound verbs, class ids, node-typed property values. */
function collectReferenceIds(node: ExportNode, into: Set<string>): void {
  for (const classId of node.classIds) into.add(classId);
  for (const property of node.properties) {
    const value = property.value;
    if (isRecord(value) && typeof value.nodeId === "string") into.add(value.nodeId);
  }
  const walk = (tokens: readonly ExportNode["contentAst"][number][]): void => {
    for (const token of tokens) {
      if (token.type === "mention") into.add(token.targetNodeId);
      else if (token.type === "class_chip") into.add(token.classId);
      else if (token.type === "typed_link") {
        if (typeof token.verb === "object") into.add(token.verb.propertySchemaId);
      } else if (token.type === "quote") {
        walk(token.children);
      }
    }
  };
  walk(node.contentAst);
}

async function exportMarkdown(ctx: CommandContext, options: {
  ids?: string[];
  linkedTo?: string;
  depth?: string;
  fixpoint?: boolean;
  outputDir?: string;
  stdout?: boolean;
}): Promise<void> {
  const ids = options.ids ?? [];
  if (ids.length === 0 && options.linkedTo === undefined) {
    failUsage("export markdown requires --ids <uuid...> or --linked-to <uuid>");
  }
  if (ids.length > 0 && options.linkedTo !== undefined) {
    failUsage("--ids and --linked-to are mutually exclusive");
  }
  if (options.outputDir !== undefined && options.stdout === true) {
    failUsage("--output-dir and --stdout are mutually exclusive");
  }
  if (options.outputDir === undefined && options.stdout !== true) {
    failUsage("export markdown requires --output-dir <dir> or --stdout");
  }
  // Closure depth: depth N follows N+1 backlink hops (depth 0 = the seed's
  // direct referrers only), per §34.16.3; default 3.
  let depth = Number.POSITIVE_INFINITY;
  if (options.fixpoint !== true) {
    const parsed = Number.parseInt(options.depth ?? "3", 10);
    if (!Number.isInteger(parsed) || parsed < 0) failUsage("--depth must be a non-negative integer");
    depth = parsed;
  }

  // Cached full-object fetch; parent ids kept on the side for containing-page
  // walks (ExportNode deliberately carries no placement).
  const objectCache = new Map<string, ExportNode | undefined>();
  const parentOf = new Map<string, string | null>();
  const getObject = async (id: string): Promise<ExportNode | undefined> => {
    if (objectCache.has(id)) return objectCache.get(id);
    let node: ExportNode | undefined;
    try {
      const body = await ctx.client.getJson<{ object: ExportApiObject }>(
        `/api/v1/objects/${encodeURIComponent(id)}`,
      );
      parentOf.set(id, body.object.parentId ?? null);
      node = toExportNode(body.object);
    } catch (error) {
      if (error instanceof CliError && error.exitCode === EXIT.domain) node = undefined;
      else throw error;
    }
    objectCache.set(id, node);
    return node;
  };

  const containingPage = async (id: string): Promise<ExportNode | undefined> => {
    let currentId: string | null = id;
    for (let hops = 0; currentId !== null && hops < 64; hops += 1) {
      const node = await getObject(currentId);
      if (node === undefined) return undefined;
      if (node.nodeType === "page") return node;
      if (node.nodeType === "class") return undefined;
      currentId = parentOf.get(currentId) ?? null;
    }
    return undefined;
  };

  // Node set: --ids exports exactly the given set; --linked-to adds the
  // backlink closure (pages only — a block referrer contributes its
  // containing page, which then renders the block inline).
  const included = new Map<string, ExportNode>();
  const addSeed = async (id: string): Promise<void> => {
    const node = await getObject(id);
    if (node === undefined) throw new CliError(EXIT.domain, `object ${id} does not exist`);
    included.set(id, node);
  };
  if (options.linkedTo !== undefined) await addSeed(options.linkedTo);
  for (const id of ids) await addSeed(id);

  if (options.linkedTo !== undefined) {
    const seedId = options.linkedTo;
    const visitedSources = new Set<string>(); // edge-source guard (cycle guard)
    const visitedPages = new Set<string>([seedId]);
    let frontier: string[] = [seedId];
    let level = 0;
    while (frontier.length > 0 && level <= depth) {
      const next: string[] = [];
      for (const id of frontier) {
        const body = await ctx.client.getJson<{ nodeId: string; backlinks: ApiEdgeRow[] }>(
          `/api/v1/objects/${encodeURIComponent(id)}/backlinks`,
        );
        for (const edge of body.backlinks) {
          const sourceId = edge.source_id;
          if (visitedSources.has(sourceId)) continue;
          visitedSources.add(sourceId);
          const source = await getObject(sourceId);
          if (source === undefined) continue;
          const page = source.nodeType === "page" ? source : await containingPage(sourceId);
          if (page === undefined || visitedPages.has(page.id)) continue;
          visitedPages.add(page.id);
          included.set(page.id, page);
          next.push(page.id);
        }
      }
      frontier = next;
      level += 1;
    }
  }

  // Children map: the object API exposes no children endpoint (M1), so the
  // parent→children map is derived from the paged object list (id-ordered —
  // bullet order is id order, not child-position order; documented deviation),
  // then each child is full-gotten for its contentAst.
  const childrenMap = new Map<string, ExportNode[]>();
  const stubs: ApiObjectStub[] = [];
  let cursor: string | undefined;
  do {
    const query = queryString({ nodeType: "block", limit: 500, cursor });
    const body = await ctx.client.getJson<{ objects: ApiObjectStub[]; nextCursor: string | null }>(
      `/api/v1/objects${query}`,
    );
    stubs.push(...body.objects);
    cursor = body.nextCursor ?? undefined;
  } while (cursor !== undefined);
  for (const stub of stubs) {
    if (stub.parentId === null) continue;
    const child = await getObject(stub.id);
    if (child === undefined) continue;
    const list = childrenMap.get(stub.parentId);
    if (list === undefined) childrenMap.set(stub.parentId, [child]);
    else list.push(child);
  }

  // Pre-resolve every referenced id's current display name (rename-free:
  // mentions render the target's current name, SCHEMA.md Fork 4).
  const referenceIds = new Set<string>();
  for (const node of included.values()) collectReferenceIds(node, referenceIds);
  for (const children of childrenMap.values()) {
    for (const child of children) collectReferenceIds(child, referenceIds);
  }
  const names = new Map<string, string>();
  for (const refId of referenceIds) {
    const node = await getObject(refId);
    if (node === undefined) continue;
    names.set(refId, deriveDisplayName(node) || node.name?.trim() || refId);
  }

  const exportCtx: ExportContext = {
    nameOf: (id) => names.get(id),
    childrenOf: (id) => childrenMap.get(id) ?? [],
  };
  const bundle = bundleMarkdown([...included.values()], exportCtx);
  const machine = { files: bundle.files.length, nodes: bundle.manifest.nodes };
  if (options.stdout === true) {
    const text = concatBundleMarkdown(bundle);
    emit(ctx, text, { ...machine, bundle: text });
    return;
  }
  const dir = options.outputDir;
  if (dir === undefined) throw new CliError(EXIT.usage, "export markdown requires --output-dir <dir> or --stdout");
  mkdirSync(dir, { recursive: true });
  for (const file of bundle.files) writeFileSync(join(dir, file.path), file.content);
  writeFileSync(join(dir, "notees-manifest.json"), `${JSON.stringify(bundle.manifest, null, 2)}\n`);
  emit(ctx, `wrote ${bundle.files.length} files to ${dir}\n`, machine);
}

// --- program assembly --------------------------------------------------------

function rootOf(command: Command): Command {
  let root = command;
  while (root.parent !== null) root = root.parent;
  return root;
}

/** Resolve the shared per-invocation context from the root program options. */
function ctxOf(command: Command): CommandContext {
  const root = rootOf(command);
  const opts = root.opts<GlobalOptions>();
  const { server, apiKey } = requireServerAndKey(opts);
  return {
    io: (root.getOptionValue("__io") as CliIo | undefined) ?? defaultIo,
    opts,
    client: new ApiClient({ server, apiKey }),
    statePath: defaultStatePath(),
  };
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("notees")
    .description("Notees v2 CLI")
    .version("2.0.0-m1")
    .option("--json", "stable machine-readable output")
    .option("--server <url>", "server base URL (env NOTEES_SERVER)")
    .option("--key <nk_…>", "API key (env NOTEES_API_KEY)")
    .option("--profile <name>", "profile name for local state", "default")
    .exitOverride();

  const object = program.command("object").description("object operations");
  object
    .command("get <id>")
    .description("fetch an object")
    .action(async (id: string, _options: object, command: Command) => {
      await objectGet(ctxOf(command), id);
    });
  object
    .command("create")
    .description("create an object (prints the new id)")
    .addOption(new Option("--nodeType <type>", "page | block").choices(["page", "block"]))
    .option("--name <name>", "object name")
    .option("--class <id>", "class id (repeatable)", (value: string, previous: string[]) => previous.concat([value]), [] as string[])
    .option("--parent <id>", "parent object id")
    .option("--stdin", "read the object body as JSON from stdin")
    .action(async (options: object, command: Command) => {
      await objectCreate(ctxOf(command), options);
    });
  object
    .command("update <id>")
    .description("update an object")
    .option("--name <name>", "new name")
    .addOption(new Option("--nodeType <type>", "page | block").choices(["page", "block"]))
    .option("--icon <icon>", "icon")
    .option("--color <color>", "color")
    .action(async (id: string, options: { name?: string; nodeType?: string; icon?: string; color?: string }, command: Command) => {
      await objectUpdate(ctxOf(command), id, options);
    });
  object
    .command("delete <id>")
    .description("delete an object (requires --yes)")
    .option("--permanent", "permanently delete (unrecoverable)", false)
    .option("--yes", "confirm the destructive action", false)
    .action(async (id: string, options: { permanent?: boolean; yes?: boolean }, command: Command) => {
      await objectDelete(ctxOf(command), id, options);
    });
  object
    .command("list")
    .description("list objects")
    .addOption(new Option("--nodeType <type>", "page | block | class").choices(["page", "block", "class"]))
    .option("--class <id>", "class id (repeatable)", (value: string, previous: string[]) => previous.concat([value]), [] as string[])
    .option("--q <text>", "full-text filter")
    .option("--limit <n>", "page size")
    .option("--cursor <id>", "pagination cursor")
    .action(async (options: object, command: Command) => {
      await objectList(ctxOf(command), options);
    });

  program
    .command("search <query>")
    .description("full-text search")
    .addOption(new Option("--nodeType <type>", "page | block | class").choices(["page", "block", "class"]))
    .action(async (queryText: string, options: { nodeType?: string }, command: Command) => {
      await search(ctxOf(command), queryText, options);
    });

  const klass = program.command("class").description("class operations");
  klass
    .command("list")
    .description("list classes")
    .action(async (_options: object, command: Command) => {
      await classList(ctxOf(command));
    });

  program
    .command("backlinks <id>")
    .description("list backlinks to an object")
    .action(async (id: string, _options: object, command: Command) => {
      await backlinks(ctxOf(command), id);
    });

  const asset = program.command("asset").description("asset operations");
  asset
    .command("add <file>")
    .description("upload a file (prints the asset id)")
    .option("--object <id>", "attach to this object")
    .action(async (filePath: string, options: { object?: string }, command: Command) => {
      await assetAdd(ctxOf(command), filePath, options);
    });
  asset
    .command("get <id>")
    .description("download an asset")
    .option("--output <path>", "write to a file instead of stdout")
    .action(async (id: string, options: { output?: string }, command: Command) => {
      await assetGet(ctxOf(command), id, options);
    });

  const sync = program.command("sync").description("sync operations");
  sync
    .command("status")
    .description("server stats + local cursor")
    .action(async (_options: object, command: Command) => {
      await syncStatus(ctxOf(command));
    });

  program
    .command("doctor")
    .description("auth + reachability + version probe")
    .action(async (_options: object, command: Command) => {
      await doctor(ctxOf(command));
    });

  const exportCmd = program.command("export").description("export operations");
  exportCmd
    .command("markdown")
    .description("export objects as Markdown (<uuid>.md files + notees-manifest.json)")
    .addOption(new Option("--ids <uuid...>", "export exactly these object ids (no closure)"))
    .option("--linked-to <uuid>", "export the seed plus the pages that transitively link to it")
    .addOption(
      new Option("--depth <n>", "closure hops beyond the seed's direct referrers (hops = depth + 1; default 3)").default("3"),
    )
    .option("--fixpoint", "expand the closure until no new pages are found", false)
    .option("--output-dir <dir>", "write the bundle into this directory")
    .option("--stdout", "print the concatenated bundle instead of writing files", false)
    .action(
      async (
        options: {
          ids?: string[];
          linkedTo?: string;
          depth?: string;
          fixpoint?: boolean;
          outputDir?: string;
          stdout?: boolean;
        },
        command: Command,
      ) => {
        await exportMarkdown(ctxOf(command), options);
      },
    );

  return program;
}

/** Parse and run argv (user-style, without node/script prefix); resolves to the process exit code. */
export async function run(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const program = buildProgram();
  program.setOptionValue("__io", io);
  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return EXIT.ok; // --help / --version
      const message = error.message.length > 0 ? error.message : "invalid usage";
      io.stderr.write(`notees: ${message}\n`);
      return EXIT.usage;
    }
    if (error instanceof CliError) {
      io.stderr.write(`notees: ${error.message}\n`);
      return error.exitCode;
    }
    io.stderr.write(`notees: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.domain;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`notees: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT.domain;
    });
}
