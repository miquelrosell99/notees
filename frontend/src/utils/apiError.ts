/**
 * API error message extraction.
 *
 * Backend error bodies use FastAPI's `detail`: either a plain string
 * (HTTPException(status, "message")) or a coded object
 * `{ code, message }` (e.g. property attribute enforcement errors such as
 * `required_property` / `readonly_property`).
 */

interface ApiErrorShape {
  response?: { data?: { detail?: unknown } };
}

/**
 * Extract a human-readable message from a failed API call.
 * Falls back to the Error message, then to `fallback`.
 */
export function getApiErrorMessage(error: unknown, fallback: string): string {
  const detail = (error as ApiErrorShape | null)?.response?.data?.detail;
  if (typeof detail === 'string' && detail) return detail;
  if (detail && typeof detail === 'object') {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
