/**
 * External references — the GENERAL external-identifier ↔ node mapping every
 * connection-style integration needs, one shared table instead of a
 * per-integration copy: a calendar feed's VEVENT UID, a read-it-later
 * provider's item id, a highlights importer's source key, a contacts
 * importer's CardDAV UID — all answer the same three questions:
 *
 *  1. IDEMPOTENT RE-IMPORT — "which node did I create for this external
 *     thing?" — `resolve(integration, externalId)` before writing, so a
 *     re-sync updates instead of duplicating.
 *  2. PROVENANCE — "which integration owns this node?" — `provenanceOf(nodeId)`,
 *     the base for source badges, "open in source", and refuse-local-edit
 *     policies.
 *  3. BOOKKEEPING — first/last-seen timestamps per ref, the honest base for
 *     vanished-from-source handling (never automatic deletion).
 *
 * The `integration` key is opaque, namespaced text the consumer chooses
 * (`calendar:<feed-url>`, `readlater:<provider>`, `contacts:<account>` …) —
 * stable across the consumer's own row lifecycles where reconvergence
 * matters (the calendar derives it from the feed URL, NOT the subscription
 * row id, so delete-and-re-add reconverges).
 *
 * This is server COORDINATION state (the prefs/shares ruling — never
 * op-log), stored in relay.db. It is also the designed shared infrastructure
 * for the parked plugin runtime (docs/features/plugins.md): connection
 * plugins get this mapping as a service instead of reinventing it —
 * calendar subscriptions (calendar-subscriptions.ts) are the first consumer.
 *
 * Consumers that derive node ids deterministically (the calendar's
 * UUIDv5-shaped ids) keep working even if this table is lost — the map is
 * the reverse/provenance direction, never the only copy of the mapping.
 */

import Database from "better-sqlite3";

const DDL = `
CREATE TABLE IF NOT EXISTS external_ref (
    workspace_id TEXT NOT NULL,
    integration TEXT NOT NULL,
    external_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, integration, external_id)
);
CREATE INDEX IF NOT EXISTS idx_external_ref_node ON external_ref (node_id);
CREATE INDEX IF NOT EXISTS idx_external_ref_integration ON external_ref (integration);
`;

export interface ExternalRefRow {
  workspaceId: string;
  integration: string;
  externalId: string;
  nodeId: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface RawRow {
  workspace_id: string;
  integration: string;
  external_id: string;
  node_id: string;
  first_seen_at: number;
  last_seen_at: number;
}

function toRow(raw: RawRow): ExternalRefRow {
  return {
    workspaceId: raw.workspace_id,
    integration: raw.integration,
    externalId: raw.external_id,
    nodeId: raw.node_id,
    firstSeenAt: raw.first_seen_at,
    lastSeenAt: raw.last_seen_at,
  };
}

export class ExternalRefStorage {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(DDL);
  }

  close(): void {
    this.db.close();
  }

  /** The idempotent re-import read: the node this external thing maps to. */
  resolve(workspaceId: string, integration: string, externalId: string): string | undefined {
    const raw = this.db
      .prepare(
        "SELECT node_id FROM external_ref WHERE workspace_id = ? AND integration = ? AND external_id = ?",
      )
      .get(workspaceId, integration, externalId) as { node_id: string } | undefined;
    return raw?.node_id;
  }

  /** Record/refresh a mapping (first_seen preserved, last_seen bumped; a
   *  consumer re-pointing an external id at a NEW node overwrites honestly). */
  record(input: {
    workspaceId: string;
    integration: string;
    externalId: string;
    nodeId: string;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO external_ref
           (workspace_id, integration, external_id, node_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, integration, external_id) DO UPDATE SET
           node_id = excluded.node_id,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(input.workspaceId, input.integration, input.externalId, input.nodeId, now, now);
  }

  /** The provenance read: which integration owns this node (first match —
   *  a node SHOULD have one owner; consumers namespace to keep it so). */
  provenanceOf(nodeId: string): ExternalRefRow | undefined {
    const raw = this.db
      .prepare("SELECT * FROM external_ref WHERE node_id = ? ORDER BY first_seen_at LIMIT 1")
      .get(nodeId) as RawRow | undefined;
    return raw === undefined ? undefined : toRow(raw);
  }

  /** Every ref an integration currently holds (vanish detection's base). */
  listByIntegration(workspaceId: string, integration: string): ExternalRefRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM external_ref WHERE workspace_id = ? AND integration = ? ORDER BY external_id",
        )
        .all(workspaceId, integration) as RawRow[]
    ).map(toRow);
  }

  /** Drop one integration's refs (the consumer decides when — e.g. an
   *  explicit "forget this source" gesture; never automatic). */
  forgetIntegration(workspaceId: string, integration: string): number {
    return this.db
      .prepare("DELETE FROM external_ref WHERE workspace_id = ? AND integration = ?")
      .run(workspaceId, integration).changes;
  }
}
