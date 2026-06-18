import React from 'react';
import { ColorButton } from '@/components/ui/ColorButton';
import { SelectionButton, type SelectionButtonOption } from '@/components/ui/SelectionButton';
import { Slider } from '@/components/ui/Slider';
import type { PenSettings } from '@/features/whiteboard/types/whiteboard';
import { STROKE_STYLE_OPTIONS, WB_COLOR_VARS } from './constants';

export interface PenSettingsPanelProps {
  settings: PenSettings;
  onChange: (settings: PenSettings) => void;
  widthOptions: SelectionButtonOption[];
}

export const PenSettingsPanel: React.FC<PenSettingsPanelProps> = ({ settings, onChange, widthOptions }) => (
  <div className="whiteboard-properties">
    <div className="whiteboard-properties__section">
      <div className="whiteboard-properties__label">Color</div>
      <ColorButton
        color={settings.color}
        showPicker
        colors={WB_COLOR_VARS}
        onColorChange={(cssVar) => cssVar && onChange({ ...settings, color: cssVar })}
        size="sm"
        title="Pick color"
      />
    </div>
    <div className="whiteboard-properties__section">
      <SelectionButton
        label="Size"
        options={widthOptions}
        value={String(settings.strokeWidth)}
        onChange={(v) => onChange({ ...settings, strokeWidth: Number(v) })}
        size="sm"
      />
    </div>
    <div className="whiteboard-properties__section">
      <SelectionButton
        label="Style"
        options={STROKE_STYLE_OPTIONS}
        value={settings.strokeStyle}
        onChange={(v) => onChange({ ...settings, strokeStyle: v as 'solid' | 'dashed' | 'dotted' })}
        size="sm"
      />
    </div>
    <div className="whiteboard-properties__section">
      <Slider
        label="Opacity"
        showValue
        formatValue={(v) => `${Math.round(v * 100)}%`}
        min={0.1}
        max={1}
        step={0.05}
        value={settings.opacity}
        onChange={(v) => onChange({ ...settings, opacity: v })}
        size="sm"
      />
    </div>
  </div>
);
