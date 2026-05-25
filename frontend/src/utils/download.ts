/**
 * Download utilities
 *
 * Thin helpers for triggering browser file downloads from Blobs/URLs.
 * Keeps DOM manipulation out of the API transport layer.
 */

/**
 * Trigger a browser download for a Blob.
 *
 * @param blob - The file content
 * @param filename - Suggested filename for the download
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
