/**
 * Feature Flags Store - Runtime Feature Toggle System
 * 
 * Enables gradual rollout of experimental features, A/B testing,
 * and quick disabling of problematic features without code changes.
 * 
 * Features can be toggled:
 * - Via environment variables at build time
 * - Via localStorage for developer testing
 * - Via URL query parameters for quick testing
 * - Programmatically at runtime
 * 
 * Usage:
 * ```tsx
 * function MyComponent() {
 *   const isEnabled = useFeatureFlag('newEditor');
 *   
 *   if (isEnabled) {
 *     return <NewEditor />;
 *   }
 *   return <LegacyEditor />;
 * }
 * ```
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ============================================================================
// FEATURE FLAG DEFINITIONS
// ============================================================================

/**
 * All available feature flags
 * 
 * To add a new flag:
 * 1. Add the flag name to FeatureFlagName union
 * 2. Add the definition to DEFAULT_FLAGS
 * 3. Use with useFeatureFlag('flagName')
 */
export type FeatureFlagName =
  | 'graphView'
  | 'newEditor'
  | 'blockComments'
  | 'aiAssist'
  | 'darkMode'
  | 'offlineMode'
  | 'collaborativeEditing'
  | 'propertyInheritance'
  | 'advancedQueries'
  | 'customThemes'
  | 'importExport'
  | 'keyboardShortcutsPanel'
  | 'blockTemplates'
  | 'typeInheritance'
  | 'debugMode';

/** Feature flag definition */
export interface FeatureFlagDefinition {
  /** Flag identifier */
  name: FeatureFlagName;
  /** Human-readable description */
  description: string;
  /** Default enabled state */
  defaultEnabled: boolean;
  /** Whether flag can be toggled by users */
  userToggleable: boolean;
  /** Minimum user role required (if any) */
  requiredRole?: 'admin' | 'developer';
  /** Dependencies on other flags */
  dependsOn?: FeatureFlagName[];
  /** Whether this is a development-only flag */
  devOnly?: boolean;
}

/** Default feature flag configurations */
export const DEFAULT_FLAGS: Record<FeatureFlagName, FeatureFlagDefinition> = {
  graphView: {
    name: 'graphView',
    description: 'Enable graph visualization of node connections',
    defaultEnabled: true,
    userToggleable: true,
  },
  newEditor: {
    name: 'newEditor',
    description: 'Use the new block editor with improved selection',
    defaultEnabled: true,
    userToggleable: false,
  },
  blockComments: {
    name: 'blockComments',
    description: 'Enable comments on individual blocks',
    defaultEnabled: true,
    userToggleable: true,
  },
  aiAssist: {
    name: 'aiAssist',
    description: 'Enable AI-powered writing assistance',
    defaultEnabled: false,
    userToggleable: true,
  },
  darkMode: {
    name: 'darkMode',
    description: 'Enable dark mode theme',
    defaultEnabled: true,
    userToggleable: true,
  },
  offlineMode: {
    name: 'offlineMode',
    description: 'Enable offline support with local caching',
    defaultEnabled: false,
    userToggleable: false,
  },
  collaborativeEditing: {
    name: 'collaborativeEditing',
    description: 'Enable real-time collaborative editing',
    defaultEnabled: false,
    userToggleable: false,
    dependsOn: ['offlineMode'],
  },
  propertyInheritance: {
    name: 'propertyInheritance',
    description: 'Allow blocks to inherit properties from parent pages',
    defaultEnabled: true,
    userToggleable: true,
  },
  advancedQueries: {
    name: 'advancedQueries',
    description: 'Enable advanced query syntax for searches',
    defaultEnabled: false,
    userToggleable: true,
  },
  customThemes: {
    name: 'customThemes',
    description: 'Enable custom theme creation and import',
    defaultEnabled: false,
    userToggleable: true,
    dependsOn: ['darkMode'],
  },
  importExport: {
    name: 'importExport',
    description: 'Enable import/export of notes in various formats',
    defaultEnabled: true,
    userToggleable: true,
  },
  keyboardShortcutsPanel: {
    name: 'keyboardShortcutsPanel',
    description: 'Show keyboard shortcuts help panel',
    defaultEnabled: true,
    userToggleable: true,
  },
  blockTemplates: {
    name: 'blockTemplates',
    description: 'Enable block templates for quick insertion',
    defaultEnabled: false,
    userToggleable: true,
  },
  typeInheritance: {
    name: 'typeInheritance',
    description: 'Enable type inheritance and hierarchy',
    defaultEnabled: false,
    userToggleable: true,
  },
  debugMode: {
    name: 'debugMode',
    description: 'Enable debug overlays and logging',
    defaultEnabled: import.meta.env.DEV,
    userToggleable: true,
    devOnly: true,
  },
};

// ============================================================================
// STORE
// ============================================================================

interface FeatureFlagState {
  /** Current flag states */
  flags: Record<FeatureFlagName, boolean>;
  
  /** Override flags (from URL params or manual override) */
  overrides: Partial<Record<FeatureFlagName, boolean>>;
  
  /** Check if a flag is enabled */
  isEnabled: (name: FeatureFlagName) => boolean;
  
  /** Set a flag's value */
  setFlag: (name: FeatureFlagName, enabled: boolean) => void;
  
  /** Set an override (temporary, not persisted) */
  setOverride: (name: FeatureFlagName, enabled: boolean | undefined) => void;
  
  /** Clear all overrides */
  clearOverrides: () => void;
  
  /** Get flag definition */
  getDefinition: (name: FeatureFlagName) => FeatureFlagDefinition;
  
  /** Get all flags with their current states */
  getAllFlags: () => Array<FeatureFlagDefinition & { enabled: boolean }>;
  
  /** Reset all flags to defaults */
  resetToDefaults: () => void;
  
  /** Initialize from URL params */
  initFromUrl: () => void;
}

/**
 * Get initial flag states from defaults and environment
 */
function getInitialFlags(): Record<FeatureFlagName, boolean> {
  const flags = {} as Record<FeatureFlagName, boolean>;
  
  for (const [name, definition] of Object.entries(DEFAULT_FLAGS)) {
    // Check environment variable first
    const envKey = `VITE_FEATURE_${name.toUpperCase()}`;
    const envValue = import.meta.env[envKey];
    
    if (envValue !== undefined) {
      flags[name as FeatureFlagName] = envValue === 'true';
    } else {
      flags[name as FeatureFlagName] = definition.defaultEnabled;
    }
    
    // Disable dev-only flags in production
    if (definition.devOnly && !import.meta.env.DEV) {
      flags[name as FeatureFlagName] = false;
    }
  }
  
  return flags;
}

export const useFeatureFlagStore = create<FeatureFlagState>()(
  persist(
    (set, get) => ({
      flags: getInitialFlags(),
      overrides: {},
      
      isEnabled: (name) => {
        const { flags, overrides } = get();
        const definition = DEFAULT_FLAGS[name];
        
        // Check override first
        if (overrides[name] !== undefined) {
          return overrides[name]!;
        }
        
        // Check if dependencies are met
        if (definition.dependsOn) {
          for (const dep of definition.dependsOn) {
            if (!get().isEnabled(dep)) {
              return false;
            }
          }
        }
        
        return flags[name] ?? definition.defaultEnabled;
      },
      
      setFlag: (name, enabled) => {
        const definition = DEFAULT_FLAGS[name];
        
        // Check if flag is user-toggleable
        if (!definition.userToggleable && !import.meta.env.DEV) {
          console.warn(`[FeatureFlags] Flag ${name} is not user-toggleable`);
          return;
        }
        
        set((state) => ({
          flags: {
            ...state.flags,
            [name]: enabled,
          },
        }));
      },
      
      setOverride: (name, enabled) => {
        set((state) => {
          const newOverrides = { ...state.overrides };
          if (enabled === undefined) {
            delete newOverrides[name];
          } else {
            newOverrides[name] = enabled;
          }
          return { overrides: newOverrides };
        });
      },
      
      clearOverrides: () => set({ overrides: {} }),
      
      getDefinition: (name) => DEFAULT_FLAGS[name],
      
      getAllFlags: () => {
        const { isEnabled } = get();
        return Object.values(DEFAULT_FLAGS)
          .filter(def => !def.devOnly || import.meta.env.DEV)
          .map(def => ({
            ...def,
            enabled: isEnabled(def.name),
          }));
      },
      
      resetToDefaults: () => {
        set({
          flags: getInitialFlags(),
          overrides: {},
        });
      },
      
      initFromUrl: () => {
        // Parse URL query params for feature flag overrides
        // Format: ?ff_flagName=true or ?ff_flagName=false
        const params = new URLSearchParams(window.location.search);
        const overrides: Partial<Record<FeatureFlagName, boolean>> = {};
        
        params.forEach((value, key) => {
          if (key.startsWith('ff_')) {
            const flagName = key.slice(3) as FeatureFlagName;
            if (flagName in DEFAULT_FLAGS) {
              overrides[flagName] = value === 'true';
            }
          }
        });
        
        if (Object.keys(overrides).length > 0) {
          set({ overrides });
        }
      },
    }),
    {
      name: 'notees-feature-flags',
      partialize: (state) => ({
        // Only persist user-toggleable flags
        flags: Object.fromEntries(
          Object.entries(state.flags).filter(
            ([name]) => DEFAULT_FLAGS[name as FeatureFlagName]?.userToggleable
          )
        ),
      }),
    }
  )
);

// ============================================================================
// HOOKS
// ============================================================================

/**
 * Check if a feature flag is enabled
 */
export function useFeatureFlag(name: FeatureFlagName): boolean {
  return useFeatureFlagStore((state) => state.isEnabled(name));
}

/**
 * Get a feature flag with its definition
 */
export function useFeatureFlagWithDefinition(name: FeatureFlagName) {
  const isEnabled = useFeatureFlagStore((state) => state.isEnabled(name));
  const setFlag = useFeatureFlagStore((state) => state.setFlag);
  const definition = DEFAULT_FLAGS[name];
  
  return {
    isEnabled,
    definition,
    toggle: () => setFlag(name, !isEnabled),
    setEnabled: (enabled: boolean) => setFlag(name, enabled),
  };
}

/**
 * Get all feature flags for settings UI
 */
export function useAllFeatureFlags() {
  const getAllFlags = useFeatureFlagStore((state) => state.getAllFlags);
  const setFlag = useFeatureFlagStore((state) => state.setFlag);
  const resetToDefaults = useFeatureFlagStore((state) => state.resetToDefaults);
  
  return {
    flags: getAllFlags(),
    setFlag,
    resetToDefaults,
  };
}

// ============================================================================
// COMPONENT UTILITIES
// ============================================================================

// Initialize from URL on load
if (typeof window !== 'undefined') {
  useFeatureFlagStore.getState().initFromUrl();
}

export default useFeatureFlagStore;
