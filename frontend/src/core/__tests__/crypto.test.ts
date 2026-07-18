import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  deriveKey,
  deriveUserWrappingKey,
  deriveWorkspaceKey,
  unwrapWorkspaceKey,
} from '../crypto';

// WebCrypto is not provided by jsdom; polyfill with Node's implementation.
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('crypto helpers', () => {
  it('deriveWorkspaceKey matches deriveKey with the workspace password', async () => {
    const workspaceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const secret = 'notees-dev-prototype-secret';

    const fromWorkspace = await deriveWorkspaceKey(workspaceId, secret);
    const fromPassword = await deriveKey(`${workspaceId}:${secret}`);

    // Both should produce usable AES-GCM keys with the same underlying material.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode('hello workspace');
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fromWorkspace, plaintext);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, fromPassword, encrypted);

    expect(new TextDecoder().decode(decrypted)).toBe('hello workspace');
  });

  it('deriveUserWrappingKey matches deriveKey with the user password', async () => {
    const userId = 'ffffffff-1111-2222-3333-444444444444';
    const secret = 'notees-dev-prototype-secret';

    const fromUser = await deriveUserWrappingKey(userId, secret);
    const fromPassword = await deriveKey(`${userId}:${secret}`);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode('hello user');
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fromUser, plaintext);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, fromPassword, encrypted);

    expect(new TextDecoder().decode(decrypted)).toBe('hello user');
  });

  it('unwrapWorkspaceKey round-trips a backend-compatible wrapped key', async () => {
    // Simulate what the backend produces: a workspace master key wrapped with
    // a user-derived wrapping key using AES-GCM.
    const userId = 'a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e5';
    const secret = 'notees-dev-prototype-secret';
    const wrappingKey = await deriveUserWrappingKey(userId, secret);

    // The backend would generate a random 32-byte master key; here we use a
    // deterministic one for the fixture.
    const masterKeyBytes = new Uint8Array(32).map((_, i) => i);
    const masterKey = await crypto.subtle.importKey(
      'raw',
      masterKeyBytes,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedBytes = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      masterKeyBytes
    );

    const wrappedFixture = {
      ciphertext: bytesToBase64(new Uint8Array(wrappedBytes)),
      iv: bytesToBase64(iv),
    };

    const unwrapped = await unwrapWorkspaceKey(wrappedFixture, wrappingKey);

    // The unwrapped key should be able to decrypt data encrypted with the
    // original master key.
    const messageIv = crypto.getRandomValues(new Uint8Array(12));
    const message = new TextEncoder().encode('workspace payload');
    const encryptedMessage = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: messageIv },
      masterKey,
      message
    );
    const decryptedMessage = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: messageIv },
      unwrapped,
      encryptedMessage
    );

    expect(new TextDecoder().decode(decryptedMessage)).toBe('workspace payload');
  });

  it('unwrapWorkspaceKey rejects tampered ciphertext', async () => {
    const userId = 'b2b2b2b2-c3c3-d4d4-e5e5-f6f6f6f6f6f6';
    const secret = 'notees-dev-prototype-secret';
    const wrappingKey = await deriveUserWrappingKey(userId, secret);

    const tampered = {
      ciphertext: 'aGVsbG8gd29ybGQ=', // base64 "hello world"
      iv: bytesToBase64(crypto.getRandomValues(new Uint8Array(12))),
    };

    await expect(unwrapWorkspaceKey(tampered, wrappingKey)).rejects.toThrow();
  });
});
