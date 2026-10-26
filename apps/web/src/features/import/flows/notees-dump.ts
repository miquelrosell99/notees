/**
 * notees-dump flow — the v1 "Notees Dump" source adapted per spec §5: a
 * v2-produced export (a `.json` archive or a zip with `dump.json` +
 * optional `assets/`) is validated, rebuilt into a client-side derived
 * STORE IMAGE (a fresh sql.js @notees/store the archive's envelopes replay
 * into), and installed into a NEW envelope-empty workspace through the
 * invariant's sanctioned checkpoint path: `PUT /snapshot/data?mode=import`
 * (the server rewrites the baked workspace_id and installs the image as
 * the workspace's rebuild source).
 *
 * The zip's asset BYTES are not restorable through the snapshot path (a
 * snapshot image is the derived node projection; CAS bytes travel the
 * asset endpoints, and re-keying them to their original ids is not
 * supported) — bundled assets are counted and reported, never faked.
 *
 * composeDumpEnvelopes is pure (assertable without a store); the sql.js
 * rebuild + REST install need a server, and fail loud otherwise.
 */

import { unzipSync } from "fflate";
import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";

import {
  JSON_ARCHIVE_FORMAT,
  type JsonArchive,
  type JsonArchiveNode,
} from "@notees/export";
import type { Envelope } from "@notees/protocol";
import { newEnvelope } from "@notees/protocol";
import { Store } from "@notees/store";
import { sqljsBackend } from "@notees/store/sqljs";

import { createWorkspace } from "@/core/auth-api.js";

export interface NoteesDumpArchive {
  archive: JsonArchive;
  /** Assets bundled in a zip — counted for the report, bytes not restored. */
  assetCount: number;
}

const MAX_ARCHIVE_VERSION = 2;

function decodeJson(text: string): JsonArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The file is not a valid Notees export: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const archive = parsed as Partial<JsonArchive>;
  if (archive.format !== JSON_ARCHIVE_FORMAT || !Array.isArray(archive.nodes)) {
    throw new Error("The file is not a Notees workspace export (notees-json-archive)");
  }
  if (typeof archive.version !== "number" || archive.version > MAX_ARCHIVE_VERSION) {
    throw new Error(
      `The export's archive version ${String(archive.version)} is newer than this app supports`,
    );
  }
  return archive as JsonArchive;
}

/**
 * Extract + validate the picked dump. A zip must carry `dump.json` at its
 * root plus optional `assets/` entries; path-traversal names are rejected
 * outright (fail loud, never guess).
 */
export function parseNoteesDump(fileName: string, bytes: Uint8Array): NoteesDumpArchive {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip")) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch (error) {
      throw new Error(
        `The zip could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const name of Object.keys(entries)) {
      if (name.startsWith("/") || name.split("/").some((part) => part === "..")) {
        throw new Error(`The zip contains an unsafe path ("${name}") — refusing to import it`);
      }
    }
    const dumpEntry =
      entries["dump.json"] ??
      Object.entries(entries).find(([name]) => name.endsWith("/dump.json"))?.[1];
    if (dumpEntry === undefined) {
      throw new Error('The zip has no "dump.json" at its root — not a Notees dump');
    }
    const assetCount = Object.keys(entries).filter((name) =>
      name.startsWith("assets/") || name.includes("/assets/"),
    ).length;
    return {
      archive: decodeJson(new TextDecoder().decode(dumpEntry)),
      assetCount,
    };
  }
  if (lower.endsWith(".json")) {
    return { archive: decodeJson(new TextDecoder().decode(bytes)), assetCount: 0 };
  }
  throw new Error(`Unsupported file type — pick a .json or .zip export ("${fileName}")`);
}

// --- the envelope replay -----------------------------------------------------

export interface DumpEnvelopeContext {
  workspaceId: string;
  actorId: string;
  deviceId: string;
  /** Envelope clocks derive from this base, +1 ms per envelope (deterministic order). */
  basePhysical: number;
}

/**
 * The archive replayed as envelope-v3 ops over a fresh store: schemas
 * first, classes, then nodes ordered parent-before-child with sibling
 * afterId chaining from the archive's `children` lists, then the wire node
 * fields (cover/banner/alias) and the authored property values.
 */
export function composeDumpEnvelopes(
  archive: JsonArchive,
  ctx: DumpEnvelopeContext,
): Envelope[] {
  const envelopes: Envelope[] = [];
  let clock = ctx.basePhysical;
  const stamp = (): { physical: number; logical: number } => {
    clock += 1;
    return { physical: clock, logical: 0 };
  };
  const emit = (opType: string, payload: Record<string, unknown>, affected: string[]): void => {
    envelopes.push(
      newEnvelope({
        workspaceId: ctx.workspaceId,
        actorId: ctx.actorId,
        deviceId: ctx.deviceId,
        hlc: stamp(),
        timestamp: new Date(clock).toISOString(),
        affectedNodeIds: affected,
        opType,
        payload,
      }),
    );
  };

  const byId = new Map(archive.nodes.map((node) => [node.id, node]));

  // 1. Property schemas (distinct ids across the archive's authored values).
  const seenSchema = new Set<string>();
  for (const node of archive.nodes) {
    for (const prop of node.properties) {
      if (seenSchema.has(prop.schemaId)) continue;
      seenSchema.add(prop.schemaId);
      emit(
        "propertySchema.create",
        {
          propertySchemaId: prop.schemaId,
          name: prop.schemaName,
          ...(prop.schemaType !== undefined ? { type: prop.schemaType } : { type: "text" }),
          ...(prop.schemaOptions !== undefined
            ? { options: prop.schemaOptions.map((option) => ({ id: option.id, label: option.label })) }
            : {}),
        },
        [],
      );
    }
  }

  // 2. Classes, then content nodes parent-before-child.
  const classes = archive.nodes.filter((node) => node.isClass);
  const content = archive.nodes.filter((node) => !node.isClass);
  for (const cls of classes) {
    emit(
      "class.create",
      { classId: cls.id, contentAst: cls.contentAst },
      [cls.id],
    );
  }

  const depthOf = (node: JsonArchiveNode, guard: Set<string>): number => {
    if (node.parentId === null || !byId.has(node.parentId) || guard.has(node.id)) return 0;
    guard.add(node.id);
    return 1 + depthOf(byId.get(node.parentId)!, guard);
  };
  const ordered = [...content].sort((a, b) => depthOf(a, new Set()) - depthOf(b, new Set()));

  // Sibling order: the archive's children lists anchor afterId chains; a
  // node missing from its parent's list appends after the known ones.
  const afterIdOf = new Map<string, string | undefined>();
  for (const node of archive.nodes) {
    const kids = node.children.filter((id) => byId.has(id));
    for (let i = 1; i < kids.length; i++) afterIdOf.set(kids[i]!, kids[i - 1]!);
  }

  for (const node of ordered) {
    const classIds = node.classIds.filter((id) => classes.some((cls) => cls.id === id));
    emit(
      "object.create",
      {
        objectId: node.id,
        isEmbedded: node.isEmbedded,
        ...(node.parentId !== null && byId.has(node.parentId) ? { parentId: node.parentId } : {}),
        contentAst: node.contentAst,
        classIds,
        ...(afterIdOf.has(node.id) ? { afterId: afterIdOf.get(node.id) } : {}),
      },
      [node.id],
    );
    if (node.coverAssetId !== null || node.bannerAssetId !== null || node.aliasedNodeId !== null) {
      emit(
        "object.update",
        {
          objectId: node.id,
          ...(node.coverAssetId !== null ? { coverAssetId: node.coverAssetId } : {}),
          ...(node.bannerAssetId !== null ? { bannerAssetId: node.bannerAssetId } : {}),
          ...(node.aliasedNodeId !== null ? { aliasedNodeId: node.aliasedNodeId } : {}),
        },
        [node.id],
      );
    }
    for (const prop of node.properties) {
      emit(
        "property.set",
        {
          objectId: node.id,
          propertySchemaId: prop.schemaId,
          value: prop.value,
          idx: 0,
          ...(prop.metadata !== undefined ? { metadata: prop.metadata } : {}),
        },
        [node.id],
      );
    }
  }
  return envelopes;
}

// --- the server install --------------------------------------------------------

export interface NoteesDumpResult {
  workspaceId: string;
  name: string;
  nodeCount: number;
  assetCount: number;
  /** Property values that failed validation during the rebuild — skipped, listed. */
  skippedValues: string[];
}

export interface ImportNoteesDumpOptions {
  serverUrl: string;
  credential: string;
  name: string;
  fileName: string;
  bytes: Uint8Array;
}

// The image is built under placeholder identities — installImage rewrites
// every baked workspace_id row to the target, so these only need to be
// valid uuids for the envelope schema.
const DUMP_IMPORT_WORKSPACE_ID = "00000000-0000-7000-8000-0000000000d1";
const DUMP_IMPORT_ACTOR = "00000000-0000-7000-8000-0000000000d2";
const DUMP_IMPORT_DEVICE = "00000000-0000-7000-8000-0000000000d3";

/**
 * Validate → create the workspace → replay the archive into a fresh sql.js
 * store → install the image through `PUT /snapshot/data?mode=import`.
 * Requires the sync server; every failure is loud.
 */
export async function importNoteesDump(
  options: ImportNoteesDumpOptions,
): Promise<NoteesDumpResult> {
  const { archive, assetCount } = parseNoteesDump(options.fileName, options.bytes);

  const { id: workspaceId } = await createWorkspace(options.serverUrl, options.credential, options.name);

  const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
  const store = new Store(sqljsBackend(SQL));
  const envelopes = composeDumpEnvelopes(archive, {
    workspaceId: DUMP_IMPORT_WORKSPACE_ID,
    actorId: DUMP_IMPORT_ACTOR,
    deviceId: DUMP_IMPORT_DEVICE,
    basePhysical: Date.now() - envelopesCount(archive),
  });

  const skippedValues: string[] = [];
  for (const envelope of envelopes) {
    try {
      store.apply(envelope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (envelope.opType === "property.set") {
        // A value that no longer validates against the re-authored schema
        // skips loudly; the node content itself is already in the image.
        skippedValues.push(
          `${String((envelope.payload as { objectId?: string }).objectId ?? "?")}: ${message}`,
        );
        continue;
      }
      store.close();
      throw new Error(`Failed to rebuild the export: ${message}`);
    }
  }
  const image = store.snapshot();
  store.close();

  const url =
    `${options.serverUrl.replace(/\/$/, "")}/api/relay/v2/snapshot/data` +
    `?workspaceId=${encodeURIComponent(workspaceId)}` +
    `&physical=${Date.now()}&logical=0&mode=import`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-api-key": options.credential,
      },
      // TS's DOM lib types BodyInit narrowly (Uint8Array<ArrayBuffer>); the
      // runtime accepts any BufferSource — the snapshot bytes ride as-is.
      body: image as unknown as BodyInit,
    });
  } catch (error) {
    throw new Error(
      `The sync server did not answer the snapshot install: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Keep the HTTP status message.
    }
    throw new Error(`Installing the imported workspace failed: ${message}`);
  }
  const result = (await response.json()) as { nodeCount?: number };

  return {
    workspaceId,
    name: options.name,
    nodeCount: result.nodeCount ?? archive.nodes.length,
    assetCount,
    skippedValues,
  };
}

/** Rough envelope-count estimate so the clock base stays positive and ordered. */
function envelopesCount(archive: JsonArchive): number {
  return (
    64 +
    archive.nodes.length * 4 +
    archive.nodes.reduce((sum, node) => sum + node.properties.length, 2)
  );
}
