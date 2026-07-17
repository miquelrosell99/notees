import { Database } from "bun:sqlite";
import { uuidv7 } from "../uuid";

const REF_MARK_RE = /\[\[([^\]]+)\]\]/g;

function extractRefTargets(content: unknown[]): { targetId: string; label: string | null }[] {
  const targets = new Map<string, string | null>();

  for (const child of content) {
    const c = child as any;
    if (c.type === "ref" && c.targetId) {
      // Explicit ref children preserve their label.
      targets.set(c.targetId, c.label ?? null);
    } else if (c.type === "text" && typeof c.text === "string") {
      let match: RegExpExecArray | null;
      REF_MARK_RE.lastIndex = 0;
      while ((match = REF_MARK_RE.exec(c.text)) !== null) {
        // Inline [[targetId]] refs have no label.
        if (!targets.has(match[1])) {
          targets.set(match[1], null);
        }
      }
    }
  }

  return Array.from(targets.entries()).map(([targetId, label]) => ({ targetId, label }));
}

export function rebuildEdgesForNode(db: Database, nodeId: string): void {
  const node = db.query("SELECT workspace_id, content FROM node WHERE id = ?").get(nodeId) as
    | { workspace_id: string; content: string }
    | undefined;
  if (!node) return;

  const content = JSON.parse(node.content) as any[];
  const desired = new Map<string, { label: string | null; metadata: string }>();
  for (const { targetId, label } of extractRefTargets(content)) {
    desired.set(targetId, { label, metadata: JSON.stringify({ label }) });
  }

  const existingRows = db
    .query("SELECT id, target_id, metadata FROM edge WHERE source_id = ? AND type = ?")
    .all(nodeId, "reference") as { id: string; target_id: string; metadata: string }[];

  for (const row of existingRows) {
    const wanted = desired.get(row.target_id);
    if (!wanted) {
      db.run("DELETE FROM edge WHERE id = ?", [row.id]);
    } else if (row.metadata !== wanted.metadata) {
      db.run("UPDATE edge SET metadata = ? WHERE id = ?", [wanted.metadata, row.id]);
    }
    desired.delete(row.target_id);
  }

  const insert = db.prepare(
    "INSERT INTO edge (id, workspace_id, source_id, target_id, type, property_schema_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const [targetId, { metadata }] of desired) {
    insert.run(uuidv7(), node.workspace_id, nodeId, targetId, "reference", null, metadata, new Date().toISOString());
  }
  insert.finalize();
}

export function getBacklinks(db: Database, nodeId: string): string[] {
  const rows = db
    .query("SELECT DISTINCT source_id FROM edge WHERE target_id = ? ORDER BY source_id")
    .all(nodeId) as { source_id: string }[];
  return rows.map((r) => r.source_id);
}
