import React from 'react';
import { ColorButton } from '@/components/ui/ColorButton';
import { SelectionButton } from '@/components/ui/SelectionButton';
import type { ShapeSettings } from '@/types/whiteboard';
import { SHAPE_WIDTH_OPTIONS, STROKE_STYLE_OPTIONS, WB_COLOR_VARS } from './constants';

export interface ShapeSettingsPanelProps {
  settings: ShapeSettings;
  onChange: (settings: ShapeSettings) => void;
}

export const ShapeSettingsPanel: React.FC<ShapeSettingsPanelProps> = ({ settings, onChange }) => (
  <div className="whiteboard-properties" style={{ padding: '4px 8px 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div className="whiteboard-properties__section">
      <div className="whiteboard-properties__label">Fill</div>
      <ColorButton
        color={settings.fill}
        showPicker
        colors={WB_COLOR_VARS}
        onColorChange={(cssVar) => cssVar && onChange({ ...settings, fill: cssVar })}
        size="sm"
        title="Fill color"
      />
    </div>
    <div className="whiteboard-properties__section">
      <div className="whiteboard-properties__label">Stroke</div>
      <ColorButton
        color={settings.stroke}
        showPicker
        colors={WB_COLOR_VARS}
        onColorChange={(cssVar) => cssVar && onChange({ ...settings, stroke: cssVar })}
        size="sm"
        title="Stroke color"
      />
    </div>
    <div className="whiteboard-properties__section">
      <SelectionButton
        label="Width"
        options={SHAPE_WIDTH_OPTIONS}
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
  </div>
);
