/**
 * markdown-workspace flow — the v1 ImportMarkdownModal semantics (spec §2):
 * a NEW empty workspace is created server-side, then every picked .md file
 * is parsed with the Logseq-md grammar and written into it: one page per
 * file (fresh uuidv7), nested blocks as plain-text content (no classes, no
 * links — the v1 sharp edge), per-page failures caught, reported, and
 * skipped without aborting the run.
 *
 * Writes go through a side WorkspaceClient bound to the NEW workspace (the
 * app switches to it on success), so the current workspace's client is
 * never touched. Requires the sync server — fails loud otherwise.
 */

import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { parseLogseqMd, type LogseqMdBlock } from "@notees/export";

import { createWorkspace } from "@/core/auth-api.js";
import { WorkspaceClient } from "@/core/workspace-client/index.js";
import { createNodeWithId } from "../import-writes.js";

export interface MarkdownWorkspaceReport {
  workspaceId: string;
  name: string;
  pagesCreated: number;
  blocksCreated: number;
  /** Per-page failures (v1 caught + console.warn'd; the report lists them). */
  failures: string[];
}

export interface ImportMarkdownWorkspaceOptions {
  serverUrl: string;
  credential: string;
  name: string;
  /**
   * A workspace the caller already created (the modal creates first, then
   * picks files — v1's "workspace created, then panel"). When absent the
   * flow creates one.
   */
  workspaceId?: string;
  files: Array<{ name: string; content: string }>;
  onStatus?: (message: string) => void;
}

export async function importMarkdownWorkspace(
  options: ImportMarkdownWorkspaceOptions,
): Promise<MarkdownWorkspaceReport> {
  const { serverUrl, credential, name } = options;
  const workspaceId =
    options.workspaceId ?? (await createWorkspace(serverUrl, credential, name)).id;

  // The side client rides the ordinary HTTP sync path, exactly like the
  // app's own in-process connect branch (store-connection.ts).
  const side = await WorkspaceClient.createHttp({
    serverUrl,
    apiKey: credential,
    workspaceId,
    sqlJsConfig: { locateFile: () => sqlWasmUrl },
  });
  try {
    await side.bootstrapWorkspace(workspaceId);

    const report: MarkdownWorkspaceReport = {
      workspaceId,
      name,
      pagesCreated: 0,
      blocksCreated: 0,
      failures: [],
    };

    for (const file of options.files) {
      const page = parseLogseqMd(file.name, file.content);
      options.onStatus?.(`Creating page: ${page.title}`);
      try {
        const pageId = await createNodeWithId(side, { name: page.title, isEmbedded: false });
        report.pagesCreated += 1;
        // Sibling order rides strictly sequential appends (the v1 loop) —
        // no afterId gymnastics needed at this write pattern.
        const writeTree = async (blocks: LogseqMdBlock[], parentId: string): Promise<void> => {
          for (const block of blocks) {
            // v1 semantics: the raw block text becomes the block's plain
            // text content — no classes, no link conversion.
            const blockId = await createNodeWithId(side, {
              parentId,
              contentAst: [{ type: "text", text: block.content }],
            });
            report.blocksCreated += 1;
            await writeTree(block.children, blockId);
          }
        };
        await writeTree(page.blocks, pageId);
      } catch (error) {
        // v1: per-page failure caught, warned, and skipped.
        console.warn(`Failed to create page: ${page.title}`, error);
        report.failures.push(
          `${page.title}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    options.onStatus?.("Import complete!");
    return report;
  } finally {
    side.close();
  }
}
