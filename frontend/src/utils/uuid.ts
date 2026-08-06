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

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── Deterministic UUIDv5 for legacy bare-target links ───────────────────────

/** Namespace shared with the backend's ``_LEGACY_LINK_UUID_NAMESPACE``. */
const LEGACY_LINK_NAMESPACE = '0194a1b2-3c4d-5e6f-7a8b-9c0d1e2f3a4b';

function uuidToBytes(uuid: string): Uint8Array {
  const normalized = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(normalized.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Minimal synchronous SHA-1 implementation for UUIDv5.
 *
 * This is only used to generate deterministic link UUIDs for legacy bare-target
 * links until the one-time operation-log migration assigns stable UUIDs.
 */
function sha1(message: Uint8Array): Uint8Array {
  const padding = (len: number) => {
    const padLen = (64 - ((len + 9) % 64)) % 64;
    const result = new Uint8Array(1 + padLen + 8);
    result[0] = 0x80;
    const bitLen = BigInt(len) * 8n;
    const view = new DataView(result.buffer, result.byteOffset);
    view.setBigUint64(1 + padLen, bitLen, false);
    return result;
  };

  const data = new Uint8Array(message.length + 9 + ((64 - ((message.length + 9) % 64)) % 64));
  data.set(message);
  const pad = padding(message.length);
  data.set(pad, message.length);

  const h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const w = new Uint32Array(80);
  const view = new DataView(data.buffer, data.byteOffset);

  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotateLeft(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let [a, b, c, d, e] = [h[0], h[1], h[2], h[3], h[4]];

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotateLeft(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }

  const result = new Uint8Array(20);
  const resultView = new DataView(result.buffer);
  for (let i = 0; i < 5; i++) {
    resultView.setUint32(i * 4, h[i], false);
  }
  return result;
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/**
 * Generate a deterministic UUIDv5 from a namespace UUID and a name.
 *
 * Mirrors Python's ``uuid.uuid5`` so the frontend and backend produce the same
 * legacy link UUID for the same ``(source_id, target_id)`` pair.
 */
export function generateUUIDv5(namespace: string, name: string): string {
  const namespaceBytes = uuidToBytes(namespace);
  const nameBytes = stringToBytes(name);
  const combined = new Uint8Array(namespaceBytes.length + nameBytes.length);
  combined.set(namespaceBytes);
  combined.set(nameBytes, namespaceBytes.length);

  const hash = sha1(combined);
  const bytes = hash.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // Version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant RFC 4122

  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Generate a deterministic link UUID for a legacy bare-target link.
 *
 * The one-time migration rewrites operation-log payloads to include stable link
 * UUIDs. Until it runs, derived-state rebuilds must still produce deterministic
 * node_link rows so counts and backlinks remain stable across rebuilds.
 */
export function generateLegacyLinkUuid(sourceId: string, targetId: string): string {
  return generateUUIDv5(LEGACY_LINK_NAMESPACE, `${sourceId}:${targetId}`);
}
