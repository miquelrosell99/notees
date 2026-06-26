import { useCallback, useMemo } from 'react';
import { useSettingsQuery } from './useSettings';
import { setSetting } from '@/features/workspace/api/workspaces';

export type SettingScope = 'server' | 'local' | 'session';

interface SettingMeta {
  scope: SettingScope;
}

const SETTINGS_REGISTRY: Record<string, SettingMeta> = {
  ganttTimeScale: { scope: 'server' },
  ganttStartDatePropertyUuid: { scope: 'server' },
  ganttEndDatePropertyUuid: { scope: 'server' },
  graphSettings: { scope: 'server' },
  graphColorGroups: { scope: 'server' },
  timelineDateProperties: { scope: 'server' },
  cardLayout: { scope: 'local' },
  graphVisibilityFilters: { scope: 'local' },
  graphDataMode: { scope: 'local' },
};

function getLocalStorageKey(nodeUuid: string, viewMode: string, key: string): string {
  return `viewsettings_${nodeUuid}_${viewMode}_${key}`;
}

function getSessionKey(nodeUuid: string, viewMode: string, key: string): string {
  return `session_viewsettings_${nodeUuid}_${viewMode}_${key}`;
}

/**
 * Unified view settings hook with clear persistence tiers.
 *
 * Tiers:
 * - server: Persisted to workspace settings JSONB
 * - local:  Persisted to localStorage
 * - session: Ephemeral, resets on page reload
 */
export function useViewSettings(
  nodeUuid: string,
  viewMode: string,
) {
  const { data: serverSettings } = useSettingsQuery();

  const getSetting = useCallback(
    <T,>(key: string, defaultValue: T): T => {
      const meta = SETTINGS_REGISTRY[key] ?? { scope: 'session' };

      if (meta.scope === 'server') {
        const val = serverSettings?.[key];
        if (val !== undefined) {
          return val as T;
        }
        return defaultValue;
      }

      if (meta.scope === 'local') {
        const stored = localStorage.getItem(getLocalStorageKey(nodeUuid, viewMode, key));
        if (stored !== null) {
          try {
            return JSON.parse(stored) as T;
          } catch {
            return stored as T;
          }
        }
        return defaultValue;
      }

      const stored = sessionStorage.getItem(getSessionKey(nodeUuid, viewMode, key));
      if (stored !== null) {
        try {
          return JSON.parse(stored) as T;
        } catch {
          return stored as T;
        }
      }
      return defaultValue;
    },
    [nodeUuid, viewMode, serverSettings]
  );

  const setSettingValue = useCallback(
    <T,>(key: string, value: T) => {
      const meta = SETTINGS_REGISTRY[key] ?? { scope: 'session' };

      if (meta.scope === 'server') {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        setSetting(key, serialized).catch(console.error);
        return;
      }

      if (meta.scope === 'local') {
        const serialized = JSON.stringify(value);
        localStorage.setItem(getLocalStorageKey(nodeUuid, viewMode, key), serialized);
        return;
      }

      const serialized = JSON.stringify(value);
      sessionStorage.setItem(getSessionKey(nodeUuid, viewMode, key), serialized);
    },
    [nodeUuid, viewMode]
  );

  return useMemo(
    () => ({
      getSetting,
      setSetting: setSettingValue,
    }),
    [getSetting, setSettingValue]
  );
}
