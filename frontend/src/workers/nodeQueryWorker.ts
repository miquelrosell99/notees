/**
 * Node Query Worker
 *
 * Executes heavy node API requests (linked references, backlinks, query
 * execution, etc.) off the main thread so the UI doesn't freeze while the
 * browser parses large JSON payloads.
 *
 * JSON.parse() for large responses is the main culprit — moving it here
 * keeps the main thread free for React rendering.
 */

// ─── Message types (shared with nodeQueryWorkerClient) ─────────────────────

export interface WorkerRequest {
  /** Monotonic sequence ID used to match responses to callers. */
  id: string;
  method: 'GET' | 'POST';
  /** Absolute path, e.g. /api/nodes/42/linked-references */
  url: string;
  body?: unknown;
  token: string | null;
}

export interface WorkerResponse {
  id: string;
  /** Parsed JSON body on success. */
  data?: unknown;
  error?: {
    message: string;
    /** HTTP status code when the server returned an error response. */
    status?: number;
  };
}

// ─── Request handler ────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, method, url, body, token } = event.data;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      const errMsg: WorkerResponse = { id, error: { message: text, status: response.status } };
      self.postMessage(errMsg);
      return;
    }

    // JSON.parse happens here, off the main thread
    const data = await response.json();
    const msg: WorkerResponse = { id, data };
    self.postMessage(msg);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Worker fetch failed';
    const errMsg: WorkerResponse = { id, error: { message } };
    self.postMessage(errMsg);
  }
};
