/**
 * Source-library roster migration — SCRATCH seed harness (dev only, the
 * task-7 verification companion of scripts/migrate-source-library-roster.mts).
 *
 * Builds a throwaway relay data dir that looks like a LIVE PRE-ROSTER
 * workspace — the drifted state the roster migration exists to heal:
 *
 *  - the old source-family class nodes with their OLD titles: paper
 *    (…0025, "Paper"), article (…0026, "Article"), weblink (…0034,
 *    "Web link"), movie (…0035, "Movie"), all extending source (…0023);
 *  - four sample nodes classed paper / article / weblink / movie;
 *  - a saved query view (a `query` content token on an ordinary page) whose
 *    AST is a class condition on …0026 — authored BEFORE the rename steps
 *    (review focus #5: UUID-keyed conditions must survive the display
 *    renames);
 *  - a PARTIALLY-converged corner proving the migration's per-row existence
 *    checks: the pool schema `abstract` (…0006-…0003) + its source binding
 *    row already exist (the migration must NOT re-emit them), and the `url`
 *    schema (…0024) + its url→source binding row exist while the
 *    url→web_page extra row is still missing (the migration MUST emit only
 *    that one).
 *
 * NEVER point this at a real data dir: it WIPES the dir first. The default
 * lives under /tmp; an explicit --data-dir is the operator's own risk.
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrated-verify/seed-source-roster-scratch.mts \
 *     [--data-dir /tmp/notees-roster-scratch]
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { newEnvelope, type Envelope } from "../../packages/protocol/src/index.ts";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "../../packages/domain/src/index.ts";

import { RelayStorage } from "../../apps/server/src/relay-storage.ts";

const DEVICE = "roster-scratch-seed";
const CLIENT = "roster-scratch-seed";
const ACTOR = "01920000-0000-7000-8000-0000000000f7";
const WORKSPACE = "c491595f-9f94-5ade-a620-e30ed063d8d2";

const SOURCE_ID = SYSTEM_CLASS_UUIDS.source;
const PAPER_ID = "00000000-0000-0000-0001-000000000025";
const ARTICLE_ID = SYSTEM_CLASS_UUIDS.journal_article; // the fixed …0026 id, old title
const WEBLINK_ID = SYSTEM_CLASS_UUIDS.web_page; // …0034, old title
const MOVIE_ID = SYSTEM_CLASS_UUIDS.film; // …0035, old title

const ABSTRACT_SCHEMA_ID = SYSTEM_PROPERTY_UUIDS.abstract;
const URL_SCHEMA_ID = SYSTEM_PROPERTY_UUIDS.url;

const NODE_PAPER = "10000000-0000-4000-8000-000000000001";
const NODE_ARTICLE = "10000000-0000-4000-8000-000000000002";
const NODE_WEBLINK = "10000000-0000-4000-8000-000000000003";
const NODE_MOVIE = "10000000-0000-4000-8000-000000000004";
const QUERIES_PAGE = "10000000-0000-4000-8000-0000000000ff";

function parseArgs(argv: string[]): { dataDir: string } {
  const index = argv.indexOf("--data-dir");
  return { dataDir: index >= 0 ? argv[index + 1] : "/tmp/notees-roster-scratch" };
}

/** The pre-roster workspace: old titles, four classed nodes, one saved query view. */
function buildSeedEnvelopes(): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  const push = (
    opType: string,
    payload: Record<string, unknown>,
    affected: string[],
  ): void => {
    envelopes.push(
      newEnvelope({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        deviceId: DEVICE,
        client: CLIENT,
        hlc: { physical, logical: envelopes.length },
        affectedNodeIds: affected,
        opType,
        payload,
      }),
    );
  };

  const classCreate = (
    classId: string,
    title: string,
    icon: string,
    parents: string[],
  ): void => {
    push("class.create", { classId, contentAst: [{ type: "text", text: title }], icon }, [classId]);
    push("class.setExtends", { classId, parentClassIds: parents }, [classId]);
  };

  // The old source family, pre-roster titles.
  classCreate(SOURCE_ID, "Source", "mdiBookshelf", []);
  classCreate(PAPER_ID, "Paper", "mdiNewspaperVariantOutline", [SOURCE_ID]);
  classCreate(ARTICLE_ID, "Article", "mdiNewspaper", [SOURCE_ID]);
  classCreate(WEBLINK_ID, "Web link", "mdiLinkVariant", [SOURCE_ID]);
  classCreate(MOVIE_ID, "Movie", "mdiMovieOpenOutline", [SOURCE_ID]);

  // Four sample nodes, one per drifted class.
  push(
    "object.create",
    { objectId: NODE_PAPER, classIds: [PAPER_ID], contentAst: [{ type: "text", text: "A pre-roster paper node" }] },
    [NODE_PAPER],
  );
  push(
    "object.create",
    { objectId: NODE_ARTICLE, classIds: [ARTICLE_ID], contentAst: [{ type: "text", text: "A pre-roster article node" }] },
    [NODE_ARTICLE],
  );
  push(
    "object.create",
    { objectId: NODE_WEBLINK, classIds: [WEBLINK_ID], contentAst: [{ type: "text", text: "A pre-roster web link node" }] },
    [NODE_WEBLINK],
  );
  push(
    "object.create",
    { objectId: NODE_MOVIE, classIds: [MOVIE_ID], contentAst: [{ type: "text", text: "A pre-roster movie node" }] },
    [NODE_MOVIE],
  );

  // The saved query view, authored BEFORE the renames: a class condition on
  // the …0026 UUID (titled "Article" today, "Journal article" after).
  push(
    "object.create",
    {
      objectId: QUERIES_PAGE,
      isEmbedded: false,
      contentAst: [
        { type: "text", text: "Saved queries" },
        {
          type: "query",
          queryAst: {
            version: 1,
            scope: { type: "entire_workspace" },
            root: {
              type: "group",
              logic: "and",
              children: [{ type: "class", classId: ARTICLE_ID }],
            },
          },
        },
      ],
    },
    [QUERIES_PAGE],
  );

  // The partially-converged corner: abstract (pool) + url land WITH their
  // source binding rows — the migration must skip them, not re-emit.
  push(
    "propertySchema.create",
    {
      propertySchemaId: ABSTRACT_SCHEMA_ID,
      name: "Abstract",
      type: "text",
      multi: false,
      scopeClassIds: [SOURCE_ID],
    },
    [],
  );
  push("class.property.set", { classId: SOURCE_ID, propertySchemaId: ABSTRACT_SCHEMA_ID }, [SOURCE_ID]);
  push(
    "propertySchema.create",
    { propertySchemaId: URL_SCHEMA_ID, name: "URL", type: "url", multi: false },
    [],
  );
  push("class.property.set", { classId: SOURCE_ID, propertySchemaId: URL_SCHEMA_ID }, [SOURCE_ID]);

  return envelopes;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  rmSync(options.dataDir, { recursive: true, force: true });
  const relay = new RelayStorage(
    join(options.dataDir, "relay.db"),
    join(options.dataDir, "snapshots"),
  );
  try {
    const envelopes = buildSeedEnvelopes();
    const { savedIds } = relay.ingest(envelopes);
    if (savedIds.length !== envelopes.length) {
      throw new Error(`seed ingest saved ${savedIds.length}/${envelopes.length} envelopes`);
    }
    console.log(
      `scratch relay seeded at ${options.dataDir}: ${savedIds.length} envelope(s), ` +
        `workspace ${WORKSPACE} — the old paper/article/weblink/movie roster with four classed nodes, ` +
        "a pre-rename saved query view (class condition on …0026), and a partially-converged abstract+url corner.",
    );
  } finally {
    relay.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
