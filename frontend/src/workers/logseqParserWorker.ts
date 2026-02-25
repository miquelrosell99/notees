/**
 * Web Worker for Logseq content parsing.
 *
 * Runs EDN parsing and SQLite parsing off the main thread so the UI remains
 * responsive (workspace name input, etc.) while potentially large files are
 * being processed.
 */
import { parseLogseqEdn } from '../utils/ednParser';
import { parseLogseqSqlite } from '../utils/logseqSqliteParser';

export type WorkerRequest =
  | { type: 'parse-edn'; id: string; content: string }
  | { type: 'parse-sqlite'; id: string; buffer: ArrayBuffer };

export type WorkerResponse =
  | { type: 'success'; id: string; result: unknown }
  | { type: 'error'; id: string; message: string };

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'parse-edn') {
      const result = parseLogseqEdn(msg.content);
      const response: WorkerResponse = { type: 'success', id: msg.id, result };
      self.postMessage(response);
    } else if (msg.type === 'parse-sqlite') {
      const result = await parseLogseqSqlite(msg.buffer);
      const response: WorkerResponse = { type: 'success', id: msg.id, result };
      self.postMessage(response);
    }
  } catch (err) {
    const response: WorkerResponse = {
      type: 'error',
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
