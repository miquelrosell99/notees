/**
 * WhiteboardToolbar — Tool selection, settings, and zoom controls.
 *
 * Modeled after the GraphView toolbar pattern with FloatingButtonArray,
 * ButtonWithPanel, and SelectionButton components.
 */
import React, { useState } from 'react';
import {
  mdiCursorDefaultOutline,
  mdiHandBackRight,
  mdiRectangleOutline,
  mdiCircleOutline,
  mdiTriangleOutline,
  mdiDiamondOutline,
  mdiHexagonOutline,
  mdiStarOutline,
  mdiPencilOutline,
  mdiMarker,
  mdiEraserVariant,
  mdiFormatText,
  mdiVectorLine,
  mdiImageOutline,
  mdiCardOutline,
  mdiCardPlusOutline,
  mdiLinkVariant,
  mdiUndo,
  mdiRedo,
  mdiGrid,
  mdiMagnet,
  mdiFitToScreen,
  mdiPlus,
  mdiMinus,
  mdiLockOutline,
  mdiLockOpenOutline,
  mdiContentDuplicate,
  mdiDeleteOutline,
  mdiArrangeBringToFront,
  mdiArrangeSendToBack,
} from '@mdi/js';
import { FloatingButtonArray } from '@/components/core/FloatingButtonArray';
import { Button } from '@/components/core/Button';
import { ButtonWithPanel } from '@/components/core/ButtonWithPanel';
import { ColorButton, type ColorEntry } from '@/components/core/ColorButton';
import { SelectionButton, type SelectionButtonOption } from '@/components/core/SelectionButton';
import { Slider } from '@/components/core/Slider';
import type { WhiteboardTool, PenSettings, EraserSettings, ShapeSettings } from '@/types/whiteboard';
import type { UseWhiteboardReturn } from '@/hooks/useWhiteboard';
import './WhiteboardView.css';

interface WhiteboardToolbarProps {
  wb: UseWhiteboardReturn;
  onAddCard: () => void;
  onAddReferenceCard: () => void;
  onAddImage: () => void;
}

const TOOL_GROUPS = [
  {
    label: 'Selection',
    tools: [
      { tool: 'select' as WhiteboardTool, icon: mdiCursorDefaultOutline, label: 'Select', shortcut: 'V' },
      { tool: 'pan' as WhiteboardTool, icon: mdiHandBackRight, label: 'Pan', shortcut: 'H' },
    ],
  },
  {
    label: 'Shapes',
    tools: [
      { tool: 'rectangle' as WhiteboardTool, icon: mdiRectangleOutline, label: 'Rectangle', shortcut: 'R' },
      { tool: 'ellipse' as WhiteboardTool, icon: mdiCircleOutline, label: 'Ellipse', shortcut: 'O' },
      { tool: 'triangle' as WhiteboardTool, icon: mdiTriangleOutline, label: 'Triangle', shortcut: '' },
      { tool: 'diamond' as WhiteboardTool, icon: mdiDiamondOutline, label: 'Diamond', shortcut: '' },
      { tool: 'hexagon' as WhiteboardTool, icon: mdiHexagonOutline, label: 'Hexagon', shortcut: '' },
      { tool: 'star' as WhiteboardTool, icon: mdiStarOutline, label: 'Star', shortcut: '' },
    ],
  },
  {
    label: 'Drawing',
    tools: [
      { tool: 'pen' as WhiteboardTool, icon: mdiPencilOutline, label: 'Pen', shortcut: 'P' },
      { tool: 'highlighter' as WhiteboardTool, icon: mdiMarker, label: 'Highlighter', shortcut: '' },
      { tool: 'eraser' as WhiteboardTool, icon: mdiEraserVariant, label: 'Eraser', shortcut: 'E' },
    ],
  },
  {
    label: 'Other',
    tools: [
      { tool: 'text' as WhiteboardTool, icon: mdiFormatText, label: 'Text', shortcut: 'T' },
      { tool: 'connector' as WhiteboardTool, icon: mdiVectorLine, label: 'Connector', shortcut: 'L' },
    ],
  },
];

/** Theme-aware color palette stored as CSS variable references */
const WB_COLOR_VARS: ColorEntry[] = [
  { cssVar: 'var(--color-on-surface)',        label: 'Default' },
  { cssVar: 'var(--color-background)',         label: 'Background' },
  { cssVar: 'var(--color-preset-red)',         label: 'Red' },
  { cssVar: 'var(--color-preset-orange)',      label: 'Orange' },
  { cssVar: 'var(--color-preset-yellow)',      label: 'Yellow' },
  { cssVar: 'var(--color-preset-green)',       label: 'Green' },
  { cssVar: 'var(--color-preset-teal)',        label: 'Teal' },
  { cssVar: 'var(--color-preset-blue)',        label: 'Blue' },
  { cssVar: 'var(--color-preset-purple)',      label: 'Purple' },
  { cssVar: 'var(--color-preset-pink)',        label: 'Pink' },
];

const STROKE_WIDTHS = [1, 2, 3, 5, 8, 12];
const ERASER_WIDTHS = [5, 10, 15, 25, 40];

/**
 * Generate a filled-rectangle SVG path in a 24×24 viewport to visually
 * represent a stroke of the given pixel width.
 */
function makeWidthIconPath(w: number, maxH = 14): string {
  const h = Math.max(1.5, Math.min(maxH, w * 1.2));
  const y = (24 - h) / 2;
  return `M2,${y.toFixed(1)} L22,${y.toFixed(1)} L22,${(y + h).toFixed(1)} L2,${(y + h).toFixed(1)} Z`;
}

const PEN_WIDTH_OPTIONS: SelectionButtonOption[] = STROKE_WIDTHS.map((w) => ({
  value: String(w),
  icon: makeWidthIconPath(w),
  label: `${w}px`,
}));

const ERASER_WIDTH_OPTIONS: SelectionButtonOption[] = ERASER_WIDTHS.map((w) => ({
  value: String(w),
  icon: makeWidthIconPath(w, 16),
  label: `${w}px`,
}));

export const WhiteboardToolbar: React.FC<WhiteboardToolbarProps> = ({
  wb,
  onAddCard,
  onAddReferenceCard,
  onAddImage,
}) => {
  const { interaction, data, settings } = wb;
  const activeTool = interaction.tool;

  // Track the last selected shape so left-clicking the shapes button re-activates it.
  const [lastShapeTool, setLastShapeTool] = useState<WhiteboardTool>(
    isShapeTool(activeTool) ? activeTool : 'rectangle'
  );

  const handleShapeSelect = (tool: WhiteboardTool) => {
    setLastShapeTool(tool);
    wb.setTool(tool);
  };

  return (
    <>
      {/* Main tool bar — bottom center */}
      <div className="whiteboard-toolbar whiteboard-toolbar--bottom-center">
        <FloatingButtonArray direction="horizontal" size="md">
          {/* Selection tools */}
          {TOOL_GROUPS[0].tools.map(t => (
            <ToolButton
              key={t.tool}
              icon={t.icon}
              label={t.label}
              shortcut={t.shortcut}
              active={activeTool === t.tool}
              onClick={() => wb.setTool(t.tool)}
            />
          ))}

          <div className="whiteboard-toolbar__separator" />

          {/* Shape tools — collapsed into a selectable group.
               Left click  → activate the last chosen shape tool.
               Right click → open picker + style settings panel. */}
          <ButtonWithPanel
            icon={getShapeIcon(isShapeTool(activeTool) ? activeTool : lastShapeTool)}
            size="sm"
            tooltip="Shapes"
            panelPosition="top"
            panelAlignment="center"
            usePortal
            panelWidth={220}
            openPanelOnRightClick
            active={isShapeTool(activeTool)}
            onActivate={() => wb.setTool(lastShapeTool)}
          >
            {(closePanel) => (
              <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Shape picker */}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 192 }}>
                  {TOOL_GROUPS[1].tools.map(t => (
                    <ToolButton
                      key={t.tool}
                      icon={t.icon}
                      label={t.label}
                      shortcut={t.shortcut}
                      active={activeTool === t.tool}
                      onClick={() => { handleShapeSelect(t.tool); closePanel(); }}
                    />
                  ))}
                </div>
                <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '0 4px' }} />
                {/* Shape style settings */}
                <ShapeSettingsPanel
                  settings={settings.shape}
                  onChange={(s) => wb.setSettings(prev => ({ ...prev, shape: s }))}
                />
              </div>
            )}
          </ButtonWithPanel>

          <div className="whiteboard-toolbar__separator" />

          {/* Drawing tools.
               Left click  → activate the tool.
               Right click → open settings panel (color / size / opacity). */}

          {/* Pen */}
          <ButtonWithPanel
            icon={mdiPencilOutline}
            size="sm"
            tooltip="Pen (P)"
            panelPosition="top"
            panelAlignment="center"
            usePortal
            panelWidth={220}
            openPanelOnRightClick
            active={activeTool === 'pen'}
            onActivate={() => wb.setTool('pen')}
          >
            {() => (
              <PenSettingsPanel
                settings={settings.pen}
                onChange={(s) => wb.setSettings(prev => ({ ...prev, pen: s }))}
                widthOptions={PEN_WIDTH_OPTIONS}
              />
            )}
          </ButtonWithPanel>

          {/* Highlighter */}
          <ButtonWithPanel
            icon={mdiMarker}
            size="sm"
            tooltip="Highlighter"
            panelPosition="top"
            panelAlignment="center"
            usePortal
            panelWidth={220}
            openPanelOnRightClick
            active={activeTool === 'highlighter'}
            onActivate={() => wb.setTool('highlighter')}
          >
            {() => (
              <PenSettingsPanel
                settings={settings.highlighter}
                onChange={(s) => wb.setSettings(prev => ({ ...prev, highlighter: s }))}
                widthOptions={PEN_WIDTH_OPTIONS}
              />
            )}
          </ButtonWithPanel>

          {/* Eraser */}
          <ButtonWithPanel
            icon={mdiEraserVariant}
            size="sm"
            tooltip="Eraser (E)"
            panelPosition="top"
            panelAlignment="center"
            usePortal
            panelWidth={220}
            openPanelOnRightClick
            active={activeTool === 'eraser'}
            onActivate={() => wb.setTool('eraser')}
          >
            {() => (
              <EraserSettingsPanel
                settings={settings.eraser}
                onChange={(s) => wb.setSettings(prev => ({ ...prev, eraser: s }))}
              />
            )}
          </ButtonWithPanel>

          <div className="whiteboard-toolbar__separator" />

          {/* Other tools */}
          {TOOL_GROUPS[3].tools.map(t => (
            <ToolButton
              key={t.tool}
              icon={t.icon}
              label={t.label}
              shortcut={t.shortcut}
              active={activeTool === t.tool}
              onClick={() => wb.setTool(t.tool)}
            />
          ))}

          {/* Card (block vs reference) and Image */}
          <ButtonWithPanel
            icon={mdiCardOutline}
            variant="ghost"
            size="sm"
            tooltip="Add Card"
            panelPosition="top"
            panelAlignment="center"
            usePortal
          >
            {(closePanel) => (
              <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 }}>
                <ToolButton
                  icon={mdiCardPlusOutline}
                  label="New Block"
                  shortcut=""
                  active={false}
                  onClick={() => { closePanel(); onAddCard(); }}
                />
                <ToolButton
                  icon={mdiLinkVariant}
                  label="Reference Card"
                  shortcut=""
                  active={false}
                  onClick={() => { closePanel(); onAddReferenceCard(); }}
                />
              </div>
            )}
          </ButtonWithPanel>
          <ToolButton
            icon={mdiImageOutline}
            label="Add Image"
            shortcut=""
            active={false}
            onClick={onAddImage}
          />
        </FloatingButtonArray>
      </div>

      {/* Top left — undo/redo + grid */}
      <div className="whiteboard-toolbar whiteboard-toolbar--top-left">
        <FloatingButtonArray direction="horizontal" size="sm">
          <Button
            icon={mdiUndo}
            variant="ghost"
            size="sm"
            onClick={wb.undo}
            title="Undo (Ctrl+Z)"
          />
          <Button
            icon={mdiRedo}
            variant="ghost"
            size="sm"
            onClick={wb.redo}
            title="Redo (Ctrl+Shift+Z)"
          />
          <div className="whiteboard-toolbar__separator" />
          <Button
            icon={mdiGrid}
            variant="ghost"
            size="sm"
            active={data.grid.visible}
            onClick={wb.toggleGrid}
            title="Toggle Grid (G)"
          />
          <Button
            icon={mdiMagnet}
            variant="ghost"
            size="sm"
            active={data.grid.snap}
            onClick={wb.toggleSnap}
            title="Snap to Grid"
          />
        </FloatingButtonArray>
      </div>

      {/* Bottom right — zoom controls */}
      <div className="whiteboard-toolbar whiteboard-toolbar--bottom-right">
        <FloatingButtonArray direction="horizontal" size="sm">
          <Button
            icon={mdiMinus}
            variant="ghost"
            size="sm"
            onClick={() => wb.setViewport({ ...data.viewport, zoom: Math.max(0.1, data.viewport.zoom - 0.1) })}
            title="Zoom Out"
          />
          <div
            className="whiteboard-zoom__level"
            onClick={() => wb.setViewport({ ...data.viewport, zoom: 1 })}
            title="Reset zoom (Ctrl+0)"
          >
            {Math.round(data.viewport.zoom * 100)}%
          </div>
          <Button
            icon={mdiPlus}
            variant="ghost"
            size="sm"
            onClick={() => wb.setViewport({ ...data.viewport, zoom: Math.min(5, data.viewport.zoom + 0.1) })}
            title="Zoom In"
          />
          <div className="whiteboard-toolbar__separator" />
          <Button
            icon={mdiFitToScreen}
            variant="ghost"
            size="sm"
            onClick={wb.zoomToFit}
            title="Zoom to Fit (Ctrl+1)"
          />
        </FloatingButtonArray>
      </div>

      {/* Selection actions */}
      {interaction.selectedIds.size > 0 && activeTool === 'select' && (
        <div className="whiteboard-toolbar whiteboard-toolbar--top-right">
          <SelectionActionsPanel wb={wb} />
        </div>
      )}
    </>
  );
};

// ─── Tool button ───────────────────────────────────────────────────

interface ToolButtonProps {
  icon: string;
  label: string;
  shortcut: string;
  active: boolean;
  onClick: () => void;
}

const ToolButton: React.FC<ToolButtonProps> = ({ icon, label, shortcut, active, onClick }) => (
  <Button
    icon={icon}
    variant="ghost"
    size="sm"
    active={active}
    onClick={onClick}
    title={`${label}${shortcut ? ` (${shortcut})` : ''}`}
  />
);

// ─── Pen settings panel ────────────────────────────────────────────

interface PenSettingsPanelProps {
  settings: PenSettings;
  onChange: (settings: PenSettings) => void;
  widthOptions: SelectionButtonOption[];
}

const PenSettingsPanel: React.FC<PenSettingsPanelProps> = ({ settings, onChange, widthOptions }) => (
  <div className="whiteboard-properties" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div className="whiteboard-properties__section">
      <div className="whiteboard-properties__label">Color</div>
      <ColorButton
        color={settings.color}
        showPicker
        colors={WB_COLOR_VARS}
        onColorChange={(cssVar) => onChange({ ...settings, color: cssVar })}
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

// ─── Eraser settings panel ─────────────────────────────────────────

interface EraserSettingsPanelProps {
  settings: EraserSettings;
  onChange: (settings: EraserSettings) => void;
}

const EraserSettingsPanel: React.FC<EraserSettingsPanelProps> = ({ settings, onChange }) => (
  <div className="whiteboard-properties" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
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

// ─── Shape settings panel ──────────────────────────────────────────

interface ShapeSettingsPanelProps {
  settings: ShapeSettings;
  onChange: (settings: ShapeSettings) => void;
}

const SHAPE_STROKE_WIDTHS = [1, 2, 3, 5, 8];
const SHAPE_WIDTH_OPTIONS: SelectionButtonOption[] = SHAPE_STROKE_WIDTHS.map((w) => ({
  value: String(w),
  icon: makeWidthIconPath(w),
  label: `${w}px`,
}));

const ShapeSettingsPanel: React.FC<ShapeSettingsPanelProps> = ({ settings, onChange }) => (
  <div className="whiteboard-properties" style={{ padding: '4px 8px 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div className="whiteboard-properties__section">
      <div className="whiteboard-properties__label">Fill</div>
      <ColorButton
        color={settings.fill}
        showPicker
        colors={WB_COLOR_VARS}
        onColorChange={(cssVar) => onChange({ ...settings, fill: cssVar })}
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
        onColorChange={(cssVar) => onChange({ ...settings, stroke: cssVar })}
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
  </div>
);

// ─── Selection actions panel ───────────────────────────────────────

const SelectionActionsPanel: React.FC<{ wb: UseWhiteboardReturn }> = ({ wb }) => {
  const selectedIds = [...wb.interaction.selectedIds];
  const selectedElements = wb.data.elements.filter(el => selectedIds.includes(el.id));
  const anyLocked = selectedElements.some(el => el.locked);

  return (
    <FloatingButtonArray direction="horizontal" size="sm">
      <Button
        icon={mdiContentDuplicate}
        variant="ghost"
        size="sm"
        onClick={() => wb.duplicateElements(selectedIds)}
        title="Duplicate (Ctrl+D)"
      />
      <Button
        icon={anyLocked ? mdiLockOpenOutline : mdiLockOutline}
        variant="ghost"
        size="sm"
        onClick={() => {
          for (const id of selectedIds) {
            wb.updateElement(id, { locked: !anyLocked });
          }
        }}
        title={anyLocked ? 'Unlock' : 'Lock'}
      />
      <Button
        icon={mdiArrangeBringToFront}
        variant="ghost"
        size="sm"
        onClick={() => wb.bringToFront(selectedIds)}
        title="Bring to Front (])"
      />
      <Button
        icon={mdiArrangeSendToBack}
        variant="ghost"
        size="sm"
        onClick={() => wb.sendToBack(selectedIds)}
        title="Send to Back ([)"
      />
      <div className="whiteboard-toolbar__separator" />
      <Button
        icon={mdiDeleteOutline}
        variant="danger"
        size="sm"
        onClick={() => wb.removeElements(selectedIds)}
        title="Delete (Delete)"
      />
    </FloatingButtonArray>
  );
};

// ─── Helpers ───────────────────────────────────────────────────────

function isShapeTool(tool: WhiteboardTool): boolean {
  return ['rectangle', 'ellipse', 'triangle', 'diamond', 'hexagon', 'star'].includes(tool);
}

function getShapeIcon(tool: WhiteboardTool): string {
  switch (tool) {
    case 'ellipse': return mdiCircleOutline;
    case 'triangle': return mdiTriangleOutline;
    case 'diamond': return mdiDiamondOutline;
    case 'hexagon': return mdiHexagonOutline;
    case 'star': return mdiStarOutline;
    default: return mdiRectangleOutline;
  }
}
