import { Database } from "bun:sqlite";

export function extractPlaintext(content: unknown[]): string {
  return content
    .map((child: any) => {
      if (child.type === "text" && typeof child.text === "string") {
        return child.text;
      }
      return "";
    })
    .join(" ");
}

export function reindexNode(db: Database, nodeId: string): void {
  const row = db.query("SELECT content FROM node WHERE id = ?").get(nodeId) as
    | { content: string }
    | undefined;
  if (!row) return;

  const content = JSON.parse(row.content) as unknown[];
  const plaintext = extractPlaintext(content);

  db.run("DELETE FROM search_index WHERE node_id = ?", [nodeId]);
  if (plaintext.length > 0) {
    db.run("INSERT INTO search_index (node_id, content) VALUES (?, ?)", [nodeId, plaintext]);
  }
}
