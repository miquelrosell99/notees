const PROBE_TIMEOUT_MS = 10000;

export type ProbeResult =
  | { ok: true }
  | { ok: false; error: "unauthorized" | "unreachable" | "not-notees" };

/** Validates settings: GET {serverUrl}/api/features with X-API-Key. 401/403 → bad key;
 * a 200 whose body has no features array is not a Notees sync server. */
export async function probeServer(serverUrl: string, apiKey: string): Promise<ProbeResult> {
  if (!serverUrl || !apiKey) return { ok: false, error: "unreachable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${serverUrl}/api/features`, {
      headers: { "X-API-Key": apiKey },
      signal: controller.signal,
    });
    if (res.status === 200) {
      const body = (await res.json().catch(() => null)) as unknown;
      if (body !== null && typeof body === "object" && Array.isArray((body as { features?: unknown }).features)) {
        return { ok: true };
      }
      return { ok: false, error: "not-notees" };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: "unauthorized" };
    return { ok: false, error: "unreachable" };
  } catch {
    return { ok: false, error: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
