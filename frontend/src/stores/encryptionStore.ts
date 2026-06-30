/**
 * Per-workspace encryption-at-rest state store.
 *
 * Each workspace can be opted into encryption independently. Only the
 * *configuration* (enabled flag + salt) is persisted per-workspace to
 * localStorage. The actual AES key is kept only in memory (Zustand state)
 * and is derived from the user's password + workspace salt.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { deriveKey } from '@/utils/encryption';

export interface WorkspaceEncryptionConfig {
  enabled: boolean;
  salt: string | null;
}

interface EncryptionState {
  /** workspaceUuid -> config (persisted) */
  configs: Record<string, WorkspaceEncryptionConfig>;
  /** workspaceUuid -> in-memory CryptoKey */
  keys: Record<string, CryptoKey>;

  setPassword: (password: string, workspaceUuid: string) => Promise<void>;
  unlock: (password: string, workspaceUuid: string) => Promise<boolean>;
  lock: (workspaceUuid: string) => void;
  disable: (workspaceUuid: string) => void;
  getConfig: (workspaceUuid: string) => WorkspaceEncryptionConfig;
  getKey: (workspaceUuid: string) => CryptoKey | null;
}

const PERSIST_KEY = 'notees-encryption-config-v3';
const LEGACY_PERSIST_KEYS = ['notees-encryption-config', 'notees-encryption-config-v2'];
const LEGACY_SESSION_KEY = 'notees-encryption-key-session';

function generateSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function saltToBytes(salt: string): Uint8Array {
  return new Uint8Array([...atob(salt)].map((c) => c.charCodeAt(0)));
}

/**
 * One-time cleanup of legacy global encryption stores. The old formats stored
 * a single global config and kept the derived key in sessionStorage.
 * Per-workspace encryption cannot safely map that global config to a specific
 * workspace, so we clear all legacy entries to force re-enabling per workspace.
 */
function clearLegacyEncryptionStorage(): void {
  try {
    for (const key of LEGACY_PERSIST_KEYS) {
      localStorage.removeItem(key);
    }
    sessionStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    // Storage access may be restricted in some contexts; ignore.
  }
}

export const useEncryptionStore = create<EncryptionState>()(
  persist(
    (set, get) => ({
      configs: {},
      keys: {},

      setPassword: async (password: string, workspaceUuid: string) => {
        const salt = generateSalt();
        const key = await deriveKey(password, saltToBytes(salt));
        set((state) => ({
          configs: {
            ...state.configs,
            [workspaceUuid]: { enabled: true, salt },
          },
          keys: {
            ...state.keys,
            [workspaceUuid]: key,
          },
        }));
      },

      unlock: async (password: string, workspaceUuid: string) => {
        const config = get().configs[workspaceUuid];
        if (!config?.enabled || !config.salt) return false;
        try {
          const key = await deriveKey(password, saltToBytes(config.salt));
          set((state) => ({
            keys: {
              ...state.keys,
              [workspaceUuid]: key,
            },
          }));
          return true;
        } catch {
          return false;
        }
      },

      lock: (workspaceUuid: string) => {
        set((state) => {
          if (!(workspaceUuid in state.keys)) return state;
          const next = { ...state.keys };
          delete next[workspaceUuid];
          return { keys: next };
        });
      },

      disable: (workspaceUuid: string) => {
        set((state) => {
          if (!(workspaceUuid in state.configs) && !(workspaceUuid in state.keys)) {
            return state;
          }
          const nextConfigs = { ...state.configs };
          delete nextConfigs[workspaceUuid];
          const nextKeys = { ...state.keys };
          delete nextKeys[workspaceUuid];
          return { configs: nextConfigs, keys: nextKeys };
        });
      },

      getConfig: (workspaceUuid: string) => {
        return get().configs[workspaceUuid] ?? { enabled: false, salt: null };
      },

      getKey: (workspaceUuid: string) => {
        return get().keys[workspaceUuid] ?? null;
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ configs: state.configs }),
      onRehydrateStorage: () => (state) => {
        clearLegacyEncryptionStorage();
        // Ensure no in-memory keys leaked into persisted state.
        if (state && 'keys' in state) {
          useEncryptionStore.setState({ keys: {} });
        }
      },
    }
  )
);
