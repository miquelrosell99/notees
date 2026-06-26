/**
 * Encryption-at-rest state store.
 *
 * Stores only the *configuration* (enabled flag + salt) persistently. The
 * actual AES key is kept in memory (and sessionStorage for the current tab
 * session) and is derived from the user's password + salt.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { deriveKey } from '@/utils/encryption';

interface EncryptionState {
  enabled: boolean;
  salt: string | null;
  key: CryptoKey | null;
  isUnlocked: boolean;
  setPassword: (password: string) => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
  lock: () => void;
  disable: () => void;
}

const SESSION_KEY = 'notees-encryption-key-session';
const PERSIST_KEY = 'notees-encryption-config';

function generateSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

async function importSessionKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function exportSessionKey(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', key);
}

export const useEncryptionStore = create<EncryptionState>()(
  persist(
    (set, get) => ({
      enabled: false,
      salt: null,
      key: null,
      isUnlocked: false,

      setPassword: async (password: string) => {
        const salt = generateSalt();
        const key = await deriveKey(password, new Uint8Array([...atob(salt)].map((c) => c.charCodeAt(0))));
        const jwk = await exportSessionKey(key);
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(jwk));
        set({ enabled: true, salt, key, isUnlocked: true });
      },

      unlock: async (password: string) => {
        const state = get();
        if (!state.enabled || !state.salt) return false;
        try {
          const key = await deriveKey(
            password,
            new Uint8Array([...atob(state.salt)].map((c) => c.charCodeAt(0)))
          );
          const jwk = await exportSessionKey(key);
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(jwk));
          set({ key, isUnlocked: true });
          return true;
        } catch {
          return false;
        }
      },

      lock: () => {
        sessionStorage.removeItem(SESSION_KEY);
        set({ key: null, isUnlocked: false });
      },

      disable: () => {
        sessionStorage.removeItem(SESSION_KEY);
        set({ enabled: false, salt: null, key: null, isUnlocked: false });
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ enabled: state.enabled, salt: state.salt }),
      onRehydrateStorage: () => async (state) => {
        if (!state?.enabled) return;
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) {
          useEncryptionStore.setState({ isUnlocked: false, key: null });
          return;
        }
        try {
          const jwk = JSON.parse(raw) as JsonWebKey;
          const key = await importSessionKey(jwk);
          useEncryptionStore.setState({ key, isUnlocked: true });
        } catch {
          useEncryptionStore.setState({ isUnlocked: false, key: null });
        }
      },
    }
  )
);
