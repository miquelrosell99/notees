import { useMemo } from 'react';
import { PluginSettingsPanel } from './PluginSettingsPanel';
import { usePluginManifestSettings } from '../hooks/usePluginManifestSettings';
import { usePluginSettings, useSetPluginSetting } from '../hooks/usePluginSettings';
import './PluginSettingsTab.css';

interface PluginSettingsTabProps {
  pluginId: string;
}

export function PluginSettingsTab({ pluginId }: PluginSettingsTabProps) {
  const settings = usePluginManifestSettings(pluginId);
  const { data: valuesWithMeta = [], isLoading } = usePluginSettings(pluginId);
  const setSetting = useSetPluginSetting(pluginId);

  const values = useMemo(() => {
    const map: Record<string, unknown> = {};
    for (const item of valuesWithMeta) {
      map[item.id] = item.value;
    }
    return map;
  }, [valuesWithMeta]);

  if (isLoading) {
    return <div className="plugin-settings-tab__loading">Loading settings…</div>;
  }

  if (settings.length === 0) {
    return <div className="plugin-settings-tab__empty">This plugin has no settings.</div>;
  }

  return (
    <div className="plugin-settings-tab">
      <h3 className="plugin-settings-tab__title">{pluginId}</h3>
      <PluginSettingsPanel
        pluginId={pluginId}
        settings={settings}
        values={values}
        onChange={(key, value) => setSetting.mutate({ key, value })}
      />
    </div>
  );
}
