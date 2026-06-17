import React from 'react';
import { SelectionButton } from '@/components/ui/SelectionButton';
import type { EraserSettings } from '@/types/whiteboard';
import { ERASER_WIDTH_OPTIONS } from './constants';

export interface EraserSettingsPanelProps {
  settings: EraserSettings;
  onChange: (settings: EraserSettings) => void;
}

export const EraserSettingsPanel: React.FC<EraserSettingsPanelProps> = ({ settings, onChange }) => (
  <div className="whiteboard-properties">
    <div className="whiteboard-properties__section">
      <SelectionButton
        label="Size"
        options={ERASER_WIDTH_OPTIONS}
        value={String(settings.strokeWidth)}
        onChange={(v) => onChange({ ...settings, strokeWidth: Number(v) })}
        size="sm"
      />
    </div>
  </div>
);
