/**
 * logseqParserClient – thin wrapper around the Logseq parser Web Worker.
 *
 * A single worker instance is created lazily and reused across calls.
 * Each call returns a Promise that resolves/rejects when the worker responds.
 * Stale requests (superseded by a newer call) are ignored via a monotonic ID.
 */
import type { LogseqExport } from './ednParser';
import type { WorkerRequest, WorkerResponse } from '@/workers/logseqParserWorker';

type PendingEntry = {
  resolve: (value: LogseqExport) => void;
  reject: (reason: unknown) => void;
};

let worker: Worker | null = null;
const pending = new Map<string, PendingEntry>();
let seq = 0;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(
      new URL('../workers/logseqParserWorker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      const entry = pending.get(msg.id);
      if (!entry) return; // stale or cancelled
      pending.delete(msg.id);
      if (msg.type === 'success') {
        entry.resolve(msg.result as LogseqExport);
      } else {
        entry.reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      // Reject all pending on fatal worker error, then reset worker
      for (const entry of pending.values()) {
        entry.reject(new Error(e.message ?? 'Worker error'));
      }
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function nextId(): string {
  return String(++seq);
}

/**
 * Parse Logseq EDN content in a worker. Returns the parsed LogseqExport.
 * Returns a cancel function that ignores the result if called before completion.
 */
export function parseEdnInWorker(
  content: string,
): { promise: Promise<LogseqExport>; cancel: () => void } {
  const id = nextId();
  let cancelled = false;

  const promise = new Promise<LogseqExport>((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => { if (!cancelled) resolve(v); },
      reject: (r) => { if (!cancelled) reject(r); },
    });
    const req: WorkerRequest = { type: 'parse-edn', id, content };
    getWorker().postMessage(req);
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      pending.delete(id);
    },
  };
}

/**
 * Parse a Logseq SQLite ArrayBuffer in a worker. The buffer is transferred
 * (zero-copy) to the worker. Returns the parsed LogseqExport.
 * Returns a cancel function that ignores the result if called before completion.
 */
export function parseSqliteInWorker(
  buffer: ArrayBuffer,
): { promise: Promise<LogseqExport>; cancel: () => void } {
  const id = nextId();
  let cancelled = false;

  // Clone buffer so we can still transfer it even if the caller holds a ref
  const transferable = buffer.slice(0);

  const promise = new Promise<LogseqExport>((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => { if (!cancelled) resolve(v); },
      reject: (r) => { if (!cancelled) reject(r); },
    });
    const req: WorkerRequest = { type: 'parse-sqlite', id, buffer: transferable };
    getWorker().postMessage(req, [transferable]);
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      pending.delete(id);
    },
  };
}
