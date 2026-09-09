/** Base64 helpers for binary op payloads (Yjs deltas, SPEC §6). */

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked: spreading large arrays into String.fromCharCode throws
  // "too many function arguments" above ~100 KB.
  const CHUNK_SIZE = 0x8000; // 32 KB
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    result += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(result);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
