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
 * Plus three probe workspaces: one whose renamed classes carry CUSTOM user
 * titles (every rename must be skipped, never clobbered, while the paper
 * reclass still runs), one whose paper-classed node's content carries an
 * inline class_link to paper (the migration's pre-ingest test-apply must
 * abort with ZERO envelopes written), and one whose web_page class exists
 * WITHOUT its seeded source extends edge — the live-drift case that failed
 * R5 on the personal workspace (the migration must heal the edge first,
 * then the source-scoped bindings converge).
 *
 * NEVER point this at a real data dir: it WIPES the dir first — and it
 * HARD-REFUSES any --data-dir not under /tmp (fail loud, don't wipe).
 *
 * Usage (from the repo root; the tsx binary lives in apps/server):
 *   pnpm --filter @notees/server exec tsx ../../scripts/migrated-verify/seed-source-roster-scratch.mts \
 *     [--data-dir /tmp/notees-roster-scratch]
 */

import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { newEnvelope, type Envelope } from "../../packages/protocol/src/index.ts";
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from "../../packages/domain/src/index.ts";

import { RelayStorage } from "../../apps/server/src/relay-storage.ts";

const DEVICE = "roster-scratch-seed";
const CLIENT = "roster-scratch-seed";
const ACTOR = "01920000-0000-7000-8000-0000000000f7";
/** The happy-path workspace: old titles, four classed nodes, one saved query view. */
const WORKSPACE = "c491595f-9f94-5ade-a620-e30ed063d8d2";
/** The user-rename probe: the renamed classes carry CUSTOM titles — none may be clobbered. */
const WORKSPACE_USER_RENAMED = "2d1c3a70-8f7e-4c1a-9b3d-5e6f7a8b9c02";
/** The poison probe: a paper node's content carries an inline class_link to paper. */
const WORKSPACE_POISON = "2d1c3a70-8f7e-4c1a-9b3d-5e6f7a8b9c03";
/** The edge-drift probe: web_page exists WITHOUT its seeded source edge (the live-drift case). */
const WORKSPACE_EDGE_DRIFT = "2d1c3a70-8f7e-4c1a-9b3d-5e6f7a8b9c04";

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

/**
 * Three throwaway workspaces:
 *
 *  1. WORKSPACE — the happy path: old titles, four classed nodes, one saved
 *     query view, a partially-converged abstract+url corner.
 *  2. WORKSPACE_USER_RENAMED — the renamed classes carry CUSTOM user titles
 *     ("Papers", "Bookmarks", "Cine"): the migration must skip every rename
 *     (reported, never clobbered) while the paper reclass still runs.
 *  3. WORKSPACE_POISON — a paper-classed EMBEDDED node whose content carries
 *     an inline class_link to paper: the plan's raw class.unassign trips the
 *     applier's inline-content lock, so the pre-ingest test-apply must abort
 *     the run with ZERO envelopes written.
 */
function buildSeedEnvelopes(): Envelope[] {
  const physical = Date.now();
  const envelopes: Envelope[] = [];
  const push = (
    workspaceId: string,
    opType: string,
    payload: Record<string, unknown>,
    affected: string[],
  ): void => {
    envelopes.push(
      newEnvelope({
        workspaceId,
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
    workspaceId: string,
    classId: string,
    title: string,
    icon: string,
    parents: string[],
  ): void => {
    push(workspaceId, "class.create", { classId, contentAst: [{ type: "text", text: title }], icon }, [classId]);
    push(workspaceId, "class.setExtends", { classId, parentClassIds: parents }, [classId]);
  };

  // --- Workspace 1: the happy path ------------------------------------------
  const ws = WORKSPACE;
  classCreate(ws, SOURCE_ID, "Source", "mdiBookshelf", []);
  classCreate(ws, PAPER_ID, "Paper", "mdiNewspaperVariantOutline", [SOURCE_ID]);
  classCreate(ws, ARTICLE_ID, "Article", "mdiNewspaper", [SOURCE_ID]);
  classCreate(ws, WEBLINK_ID, "Web link", "mdiLinkVariant", [SOURCE_ID]);
  classCreate(ws, MOVIE_ID, "Movie", "mdiMovieOpenOutline", [SOURCE_ID]);
  push(ws, "object.create",
    { objectId: NODE_PAPER, classIds: [PAPER_ID], contentAst: [{ type: "text", text: "A pre-roster paper node" }] },
    [NODE_PAPER]);
  push(ws, "object.create",
    { objectId: NODE_ARTICLE, classIds: [ARTICLE_ID], contentAst: [{ type: "text", text: "A pre-roster article node" }] },
    [NODE_ARTICLE]);
  push(ws, "object.create",
    { objectId: NODE_WEBLINK, classIds: [WEBLINK_ID], contentAst: [{ type: "text", text: "A pre-roster web link node" }] },
    [NODE_WEBLINK]);
  push(ws, "object.create",
    { objectId: NODE_MOVIE, classIds: [MOVIE_ID], contentAst: [{ type: "text", text: "A pre-roster movie node" }] },
    [NODE_MOVIE]);
  // The saved query view, authored BEFORE the renames: a class condition on
  // the …0026 UUID (titled "Article" today, "Journal article" after).
  push(ws, "object.create",
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
    [QUERIES_PAGE]);
  // The partially-converged corner: abstract (pool) + url land WITH their
  // source binding rows — the migration must skip them, not re-emit.
  push(ws, "propertySchema.create",
    {
      propertySchemaId: ABSTRACT_SCHEMA_ID,
      name: "Abstract",
      type: "text",
      multi: false,
      scopeClassIds: [SOURCE_ID],
    },
    []);
  push(ws, "class.property.set", { classId: SOURCE_ID, propertySchemaId: ABSTRACT_SCHEMA_ID }, [SOURCE_ID]);
  push(ws, "propertySchema.create",
    { propertySchemaId: URL_SCHEMA_ID, name: "URL", type: "url", multi: false },
    []);
  push(ws, "class.property.set", { classId: SOURCE_ID, propertySchemaId: URL_SCHEMA_ID }, [SOURCE_ID]);

  // --- Workspace 2: user-renamed class titles --------------------------------
  const wsUser = WORKSPACE_USER_RENAMED;
  classCreate(wsUser, SOURCE_ID, "Source", "mdiBookshelf", []);
  classCreate(wsUser, PAPER_ID, "Paper", "mdiNewspaperVariantOutline", [SOURCE_ID]);
  classCreate(wsUser, ARTICLE_ID, "Papers", "mdiNewspaper", [SOURCE_ID]); // user rename
  classCreate(wsUser, WEBLINK_ID, "Bookmarks", "mdiLinkVariant", [SOURCE_ID]); // user rename
  classCreate(wsUser, MOVIE_ID, "Cine", "mdiMovieOpenOutline", [SOURCE_ID]); // user rename
  push(wsUser, "object.create",
    { objectId: NODE_PAPER, classIds: [PAPER_ID], contentAst: [{ type: "text", text: "A paper node in the user-renamed workspace" }] },
    [NODE_PAPER]);

  // --- Workspace 3: the poisoned paper node ----------------------------------
  const wsPoison = WORKSPACE_POISON;
  classCreate(wsPoison, SOURCE_ID, "Source", "mdiBookshelf", []);
  classCreate(wsPoison, PAPER_ID, "Paper", "mdiNewspaperVariantOutline", [SOURCE_ID]);
  classCreate(wsPoison, ARTICLE_ID, "Article", "mdiNewspaper", [SOURCE_ID]);
  // The parent page + an EMBEDDED child whose rich content carries an inline
  // class_link to paper — a raw class.unassign {paper} refuses (the content-
  // reference lock), so the pre-ingest test-apply must abort with zero writes.
  push(wsPoison, "object.create",
    { objectId: QUERIES_PAGE, isEmbedded: false, contentAst: [{ type: "text", text: "Poison host" }] },
    [QUERIES_PAGE]);
  push(wsPoison, "object.create",
    {
      objectId: NODE_PAPER,
      parentId: QUERIES_PAGE,
      classIds: [PAPER_ID],
      contentAst: [{ type: "class_link", classId: PAPER_ID, displayText: "paper" }],
    },
    [NODE_PAPER]);

  // --- Workspace 4: web_page exists WITHOUT its source edge (live drift) ---
  const wsEdge = WORKSPACE_EDGE_DRIFT;
  classCreate(wsEdge, SOURCE_ID, "Source", "mdiBookshelf", []);
  // web_page created WITHOUT any extends op — the drifted live state: the
  // class node exists (class_hierarchy holds only the reflexive row) but
  // the seeded web_page→source edge was never authored (a setExtends []
  // payload would be rejected by the system-extends lock, so the drift is
  // an absent edge, not an emptied one). Pre-fix this failed the R5
  // pre-check for every source-scoped pool binding on the class; the
  // migration must heal the edge FIRST (the ensure shape), then the
  // bindings plan and converge.
  push(wsEdge, "class.create",
    { classId: WEBLINK_ID, contentAst: [{ type: "text", text: "Web link" }], icon: "mdiLinkVariant" },
    [WEBLINK_ID]);
  push(wsEdge, "object.create",
    { objectId: NODE_WEBLINK, classIds: [WEBLINK_ID], contentAst: [{ type: "text", text: "A web link node with a drifted class edge" }] },
    [NODE_WEBLINK]);

  return envelopes;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  // HARD REFUSAL: this harness WIPES the dir. Only /tmp targets are allowed —
  // never a real relay data dir.
  const resolved = resolve(options.dataDir);
  if (resolved !== "/tmp" && !resolved.startsWith("/tmp/")) {
    throw new Error(
      `refusing to wipe ${resolved} — the scratch seed harness only accepts --data-dir under /tmp`,
    );
  }
  rmSync(resolved, { recursive: true, force: true });
  const relay = new RelayStorage(
    join(resolved, "relay.db"),
    join(resolved, "snapshots"),
  );
  try {
    const envelopes = buildSeedEnvelopes();
    const { savedIds } = relay.ingest(envelopes);
    if (savedIds.length !== envelopes.length) {
      throw new Error(`seed ingest saved ${savedIds.length}/${envelopes.length} envelopes`);
    }
    console.log(
      `scratch relay seeded at ${resolved}: ${savedIds.length} envelope(s) across 4 workspaces — ` +
        `${WORKSPACE} (happy path: old titles, four classed nodes, the pre-rename saved query view, ` +
        `a partially-converged abstract+url corner), ${WORKSPACE_USER_RENAMED} (custom class titles — ` +
        `renames must skip), ${WORKSPACE_POISON} (a paper node's content links paper inline — the ` +
        `pre-ingest test-apply must abort with zero writes), ${WORKSPACE_EDGE_DRIFT} (web_page without ` +
        "its source edge — the migration must heal the edge, then the bindings converge).",
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
