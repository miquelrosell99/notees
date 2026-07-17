import { Database } from "bun:sqlite";
import { uuidv7 } from "../uuid";

export function rebuildEdgesForNode(db: Database, nodeId: string): void {
  const node = db.query("SELECT workspace_id, content FROM node WHERE id = ?").get(nodeId) as
    | { workspace_id: string; content: string }
    | undefined;
  if (!node) return;

  db.run("DELETE FROM edge WHERE source_id = ?", [nodeId]);

  const content = JSON.parse(node.content) as any[];
  const stmt = db.prepare(
    "INSERT INTO edge (id, workspace_id, source_id, target_id, type, property_schema_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  for (const child of content) {
    if (child.type === "ref" && child.targetId) {
      stmt.run(
        uuidv7(),
        node.workspace_id,
        nodeId,
        child.targetId,
        "reference",
        null,
        JSON.stringify({ label: child.label ?? null }),
        new Date().toISOString()
      );
    }
  }
  stmt.finalize();
}
