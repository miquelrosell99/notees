const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check if a string is a valid UUID.
 */
export function isUuid(str: string): boolean {
  return UUID_REGEX.test(str);
}

/**
 * Generate a UUIDv7.
 *
 * UUIDv7 encodes a millisecond timestamp in the first 48 bits, followed by
 * random data. Compared to v4, it gives much better index locality in
 * PostgreSQL and matches the backend's `uuid_extensions.uuid7()`.
 */
export function generateUUID(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Place the 48-bit Unix timestamp (ms) in bytes 0-5.
  const view = new DataView(bytes.buffer);
  const timestamp = BigInt(Date.now());
  const high = (timestamp << 16n) | (view.getBigUint64(0, false) & 0xffffn);
  view.setBigUint64(0, high, false);

  // Version 7: 0111 in the high nibble of byte 6.
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Variant RFC 4122: 10 in the high bits of byte 8.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
