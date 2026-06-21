/**
 * Generic settings panel for plugins.
 *
 * Renders contributed settings (string, number, boolean, select, multiselect)
 * using the shared UI component library.
 */

import { TextField } from '@/components/ui/TextField';
import { BooleanToggle } from '@/components/ui/BooleanToggle';
import { SelectionButton } from '@/components/ui/SelectionButton';
import { Checkbox } from '@/components/ui/Checkbox';
import { Card } from '@/components/ui/Card';
import type { ContributedSetting } from '../manifest';
import './PluginSettingsPanel.css';

export interface PluginSettingsPanelProps {
  pluginId: string;
  settings: ContributedSetting[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

export function PluginSettingsPanel({
  settings,
  values,
  onChange,
}: PluginSettingsPanelProps) {
  return (
    <div className="plugin-settings-panel">
      {settings.map((setting) => (
        <Card key={setting.id}>
          <div className="settings-item">
            <div className="settings-item__info">
              <label htmlFor={`plugin-setting-${setting.id}`} className="settings-item__label">
                {setting.label}
              </label>
              {setting.description && (
                <p className="settings-item__description">{setting.description}</p>
              )}
            </div>
            <SettingInput
              id={`plugin-setting-${setting.id}`}
              setting={setting}
              value={values[setting.id] ?? setting.default}
              onChange={(value) => onChange(setting.id, value)}
            />
          </div>
        </Card>
      ))}
    </div>
  );
}

interface SettingInputProps {
  id: string;
  setting: ContributedSetting;
  value: unknown;
  onChange: (value: unknown) => void;
}

function SettingInput({ id, setting, value, onChange }: SettingInputProps) {
  switch (setting.type) {
    case 'boolean':
      return (
        <BooleanToggle
          id={id}
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case 'select':
      return (
        <SelectionButton
          id={id}
          value={String(value ?? '')}
          options={
            setting.options?.map((o) => ({
              value: o.value,
              label: o.label,
              icon: 'mdi-circle-medium',
            })) ?? []
          }
          onChange={(v) => onChange(v)}
        />
      );
    case 'multiselect':
      return (
        <div className="plugin-settings-multiselect">
          {setting.options?.map((o) => (
            <Checkbox
              key={o.value}
              id={`${id}-${o.value}`}
              label={o.label}
              checked={Array.isArray(value) && value.includes(o.value)}
              onChange={(e) => {
                const arr = Array.isArray(value) ? [...value] : [];
                if (e.target.checked) {
                  arr.push(o.value);
                } else {
                  const idx = arr.indexOf(o.value);
                  if (idx >= 0) arr.splice(idx, 1);
                }
                onChange(arr);
              }}
            />
          ))}
        </div>
      );
    case 'number':
      return (
        <TextField
          id={id}
          type="number"
          value={String(value ?? '')}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      );
    case 'string':
    default:
      return (
        <TextField
          id={id}
          type="text"
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
