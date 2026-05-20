/**
 * WhiteboardToolbar — Tool selection, settings, and zoom controls.
 *
 * Modeled after the GraphView toolbar pattern with FloatingButtonArray,
 * ButtonWithPanel, and SelectionButton components.
 */
import React, { useState } from 'react';
import {
  mdiCursorDefaultOutline,
  mdiRectangleOutline,
  mdiCircleOutline,
  mdiTriangleOutline,
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
  mdiMapOutline,
  mdiGroup,
  mdiUngroup,
} from '@mdi/js';
import { FloatingButtonArray, ToolbarDivider } from '@/components/core/FloatingButtonArray';
import { Button } from '@/components/core/Button';
import { ButtonWithPanel } from '@/components/core/ButtonWithPanel';
import { ColorButton, type ColorEntry } from '@/components/core/ColorButton';
import { PRESET_COLOR_ENTRIES } from '@/utils/colorPresets';
import { SelectionButton, type SelectionButtonOption } from '@/components/core/SelectionButton';
import { Slider } from '@/components/core/Slider';
import type { WhiteboardTool, PenSettings, EraserSettings, ShapeSettings, WhiteboardConnectorElement, StrokeStyle } from '@/types/whiteboard';
import type { UseWhiteboardReturn } from '@/hooks/useWhiteboard';
import { useWhiteboardStore } from '@/stores/whiteboardStore';
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
    ],
  },
  {
    label: 'Shapes',
    tools: [
      { tool: 'rectangle' as WhiteboardTool, icon: mdiRectangleOutline, label: 'Rectangle', shortcut: 'R' },
      { tool: 'ellipse' as WhiteboardTool, icon: mdiCircleOutline, label: 'Ellipse', shortcut: 'O' },
      { tool: 'triangle' as WhiteboardTool, icon: mdiTriangleOutline, label: 'Triangle', shortcut: '' },
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
  ...PRESET_COLOR_ENTRIES,
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

/** Shape-tool options for the SelectionButton in the shapes panel */
const SHAPE_TOOL_OPTIONS: SelectionButtonOption[] = [
  { value: 'rectangle', icon: mdiRectangleOutline, label: 'Rectangle (R)' },
  { value: 'ellipse',   icon: mdiCircleOutline,    label: 'Ellipse (O)'  },
  { value: 'triangle',  icon: mdiTriangleOutline,   label: 'Triangle'     },
  { value: 'hexagon',   icon: mdiHexagonOutline,    label: 'Hexagon'      },
  { value: 'star',      icon: mdiStarOutline,       label: 'Star'         },
  { value: 'line',      icon: mdiMinus,             label: 'Line'         },
];

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

  // Panel open state for each tool
  const [panelOpen, setPanelOpen] = useState({
    shape: false,
    pen: false,
    highlighter: false,
    eraser: false,
  });

  const { interaction, data, settings } = wb;
  const { gridVisible, gridSnap, minimapVisible } = useWhiteboardStore();
  const { toggleGrid: _toggleGrid, toggleSnap: _toggleSnap, toggleMinimap } = useWhiteboardStore();
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

          <ToolbarDivider />

          {/* Shape tools — collapsed into a selectable group.
               Left click  → activate the last chosen shape tool.
               Right click → open picker + style settings panel. */}
          <ButtonWithPanel
            icon={getShapeIcon(isShapeTool(activeTool) ? activeTool : lastShapeTool)}
            variant="ghost"
            size="sm"
            tooltip="Shapes"
            panelPosition="top"
            panelAlignment="center"
            usePortal
            panelWidth={220}
            active={isShapeTool(activeTool)}
            open={isShapeTool(activeTool) && panelOpen.shape}
            onOpenChange={open => setPanelOpen(p => ({ ...p, shape: open }))}
            onActivate={() => {
              if (!isShapeTool(activeTool)) {
                wb.setTool(lastShapeTool);
                setPanelOpen(p => ({ ...p, shape: false }));
              } else {
                setPanelOpen(p => ({ ...p, shape: !p.shape }));
              }
            }}
          >
            {(closePanel) => (
              <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <SelectionButton
                  options={SHAPE_TOOL_OPTIONS}
                  value={isShapeTool(activeTool) ? activeTool : lastShapeTool}
                  onChange={(v) => { handleShapeSelect(v as WhiteboardTool); closePanel(); }}
                  size="sm"
                />
                <div style={{ height: 1, background: 'var(--color-outline-variant)', margin: '0 4px' }} />
                <ShapeSettingsPanel
                  settings={settings.shape}
                  onChange={(s) => wb.setSettings(prev => ({ ...prev, shape: s }))}
                />
              </div>
            )}
          </ButtonWithPanel>

          <ToolbarDivider />

          {/* Drawing tools.
               Left click  → activate the tool.
               Right click → open settings panel (color / size / opacity). */}

          {/* Pen */}
          <ButtonWithPanel
            icon={mdiPencilOutline}
            variant="ghost"
            size="sm"
            tooltip="Pen (P)"
            panelPosition="top"
            panelAlignment="center"
            usePortal
            panelWidth={220}
            active={activeTool === 'pen'}
            open={activeTool === 'pen' && panelOpen.pen}
            onOpenChange={open => setPanelOpen(p => ({ ...p, pen: open }))}
            onActivate={() => {
              if (activeTool !== 'pen') {
                wb.setTool('pen');
                setPanelOpen(p => ({ ...p, pen: false }));
              } else {
                setPanelOpen(p => ({ ...p, pen: !p.pen }));
              }
            }}
            buttonProps={activeTool === 'pen' ? {
              style: { borderColor: settings.pen.color },
            } : {}}
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
            variant="ghost"
            size="sm"
            tooltip="Highlighter"
            panelPosition="top"
            panelAlignment="center"
            usePortal
            panelWidth={220}
            active={activeTool === 'highlighter'}
            open={activeTool === 'highlighter' && panelOpen.highlighter}
            onOpenChange={open => setPanelOpen(p => ({ ...p, highlighter: open }))}
            onActivate={() => {
              if (activeTool !== 'highlighter') {
                wb.setTool('highlighter');
                setPanelOpen(p => ({ ...p, highlighter: false }));
              } else {
                setPanelOpen(p => ({ ...p, highlighter: !p.highlighter }));
              }
            }}
            buttonProps={activeTool === 'highlighter' ? {
              style: { borderColor: settings.highlighter.color },
            } : {}}
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
            variant="ghost"
            size="sm"
            tooltip="Eraser (E)"
            panelPosition="top"
            panelAlignment="center"
            usePortal
            panelWidth={220}
            active={activeTool === 'eraser'}
            open={activeTool === 'eraser' && panelOpen.eraser}
            onOpenChange={open => setPanelOpen(p => ({ ...p, eraser: open }))}
            onActivate={() => {
              if (activeTool !== 'eraser') {
                wb.setTool('eraser');
                setPanelOpen(p => ({ ...p, eraser: false }));
              } else {
                setPanelOpen(p => ({ ...p, eraser: !p.eraser }));
              }
            }}
          >
            {() => (

              <EraserSettingsPanel
                settings={settings.eraser}
                onChange={(s) => wb.setSettings(prev => ({ ...prev, eraser: s }))}
              />
            )}
          </ButtonWithPanel>

          <ToolbarDivider />

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

          <ToolbarDivider />

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
          <ToolbarDivider />
          <Button
            icon={mdiGrid}
            variant="ghost"
            size="sm"
            active={gridVisible}
            onClick={wb.toggleGrid}
            title="Toggle Grid (G)"
          />
          <Button
            icon={mdiMagnet}
            variant="ghost"
            size="sm"
            active={gridSnap}
            onClick={wb.toggleSnap}
            title="Snap to Grid"
          />
          <ToolbarDivider />
          <Button
            icon={mdiMapOutline}
            variant="ghost"
            size="sm"
            active={minimapVisible}
            onClick={toggleMinimap}
            title="Toggle Minimap"
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
          <ToolbarDivider />
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

const STROKE_STYLE_OPTIONS: SelectionButtonOption[] = [
  {
    value: 'solid',
    icon: 'M 2 10 H 22 V 14 H 2 Z',
    label: 'Solid',
  },
  {
    value: 'dashed',
    icon: 'M 2 10 H 8 V 14 H 2 Z M 10 10 H 16 V 14 H 10 Z M 18 10 H 22 V 14 H 18 Z',
    label: 'Dashed',
  },
  {
    value: 'dotted',
    icon: 'M 1 10 H 5 V 14 H 1 Z M 7 10 H 11 V 14 H 7 Z M 13 10 H 17 V 14 H 13 Z M 19 10 H 23 V 14 H 19 Z',
    label: 'Dotted',
  },
];

const ShapeSettingsPanel: React.FC<ShapeSettingsPanelProps> = ({ settings, onChange }) => (
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

// ─── Selection actions panel ───────────────────────────────────────

const SelectionActionsPanel: React.FC<{ wb: UseWhiteboardReturn }> = ({ wb }) => {
  const selectedIds = [...wb.interaction.selectedIds];
  const selectedElements = wb.data.elements.filter(el => selectedIds.includes(el.id));
  const anyLocked = selectedElements.some(el => el.locked);

  // Group state
  const existingGroup = wb.data.groups.find(g =>
    selectedIds.length >= 2 && selectedIds.every(id => g.elementIds.includes(id))
  );
  const isGrouped = !!existingGroup;
  const canGroup = selectedIds.length >= 2;

  // Connector-specific: stroke style control
  const selectedConnectors = selectedElements.filter(el => el.type === 'connector') as WhiteboardConnectorElement[];
  const hasConnectors = selectedConnectors.length > 0;
  const connectorStrokeStyle: StrokeStyle =
    selectedConnectors.length === 1 ? selectedConnectors[0].strokeStyle : 'solid';

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
      {/* Connector stroke style — shown when connector(s) are selected */}
      {hasConnectors && (
        <>
          <ToolbarDivider />
          <SelectionButton
            options={STROKE_STYLE_OPTIONS}
            value={connectorStrokeStyle}
            onChange={(v) => {
              for (const conn of selectedConnectors) {
                wb.updateElement(conn.id, { strokeStyle: v as StrokeStyle });
              }
            }}
            size="sm"
          />
        </>
      )}
      {/* Group / Ungroup — shown when 2+ items selected */}
      {canGroup && (
        <>
          <ToolbarDivider />
          <Button
            icon={isGrouped ? mdiUngroup : mdiGroup}
            variant="ghost"
            size="sm"
            onClick={() => {
              if (isGrouped) {
                wb.ungroupElements(selectedIds);
              } else {
                wb.groupElements(selectedIds);
              }
            }}
            title={isGrouped ? 'Ungroup (Ctrl+G)' : 'Group (Ctrl+G)'}
          />
        </>
      )}
      <ToolbarDivider />
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
  return ['rectangle', 'ellipse', 'triangle', 'hexagon', 'star', 'line'].includes(tool);
}

function getShapeIcon(tool: WhiteboardTool): string {
  switch (tool) {
    case 'ellipse': return mdiCircleOutline;
    case 'triangle': return mdiTriangleOutline;
    case 'hexagon': return mdiHexagonOutline;
    case 'star': return mdiStarOutline;
    case 'line': return mdiMinus;
    default: return mdiRectangleOutline;
  }
}
