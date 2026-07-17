import { Database } from "bun:sqlite";
import { uuidv7 } from "../uuid";

const REF_MARK_RE = /\[\[([^\]]+)\]\]/g;

function extractRefTargetIds(content: unknown[]): string[] {
  const targets = new Set<string>();

  for (const child of content) {
    const c = child as any;
    if (c.type === "ref" && c.targetId) {
      targets.add(c.targetId);
    } else if (c.type === "text" && typeof c.text === "string") {
      let match: RegExpExecArray | null;
      REF_MARK_RE.lastIndex = 0;
      while ((match = REF_MARK_RE.exec(c.text)) !== null) {
        targets.add(match[1]);
      }
    }
  }

  return Array.from(targets);
}

export function rebuildEdgesForNode(db: Database, nodeId: string): void {
  const node = db.query("SELECT workspace_id, content FROM node WHERE id = ?").get(nodeId) as
    | { workspace_id: string; content: string }
    | undefined;
  if (!node) return;

  db.run("DELETE FROM edge WHERE source_id = ?", [nodeId]);

  const content = JSON.parse(node.content) as any[];
  const targetIds = extractRefTargetIds(content);
  const stmt = db.prepare(
    "INSERT INTO edge (id, workspace_id, source_id, target_id, type, property_schema_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  for (const targetId of targetIds) {
    stmt.run(
      uuidv7(),
      node.workspace_id,
      nodeId,
      targetId,
      "reference",
      null,
      JSON.stringify({ label: null }),
      new Date().toISOString()
    );
  }
  stmt.finalize();
}

export function getBacklinks(db: Database, nodeId: string): string[] {
  const rows = db
    .query("SELECT DISTINCT source_id FROM edge WHERE target_id = ? ORDER BY source_id")
    .all(nodeId) as { source_id: string }[];
  return rows.map((r) => r.source_id);
}
