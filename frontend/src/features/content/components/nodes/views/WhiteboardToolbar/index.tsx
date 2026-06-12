/**
 * WhiteboardToolbar — Tool selection, settings, and zoom controls.
 *
 * Modeled after the GraphView toolbar pattern with FloatingButtonArray,
 * ButtonWithPanel, and SelectionButton components.
 */
import React, { useState } from 'react';
import { FloatingButtonArray, ToolbarDivider } from '@/components/ui/FloatingButtonArray';
import { Button } from '@/components/ui/Button';
import { ButtonWithPanel } from '@/components/ui/ButtonWithPanel';
import { SelectionButton } from '@/components/ui/SelectionButton';
import type { WhiteboardTool } from '@/types/whiteboard';
import type { UseWhiteboardReturn } from '@/hooks/useWhiteboard';
import { useWhiteboardStore } from '@/stores/whiteboardStore';
import {
  getShapeIcon,
  isShapeTool,
  PEN_WIDTH_OPTIONS,
  SHAPE_TOOL_OPTIONS,
  TOOL_GROUPS,
} from './constants';
import { EraserSettingsPanel } from './EraserSettingsPanel';
import { PenSettingsPanel } from './PenSettingsPanel';
import { SelectionActionsPanel } from './SelectionActionsPanel';
import { ShapeSettingsPanel } from './ShapeSettingsPanel';
import { ToolButton } from './ToolButton';
import '../WhiteboardView.css';

export interface WhiteboardToolbarProps {
  wb: UseWhiteboardReturn;
  onAddCard: () => void;
  onAddReferenceCard: () => void;
  onAddImage: () => void;
}

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
  const { toggleMinimap } = useWhiteboardStore();
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
            icon={"mdi mdi-pencil-outline"}
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
            icon={"mdi mdi-marker"}
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
            icon={"mdi mdi-eraser-variant"}
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
            icon={"mdi mdi-card-outline"}
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
                  icon={"mdi mdi-card-plus-outline"}
                  label="New Block"
                  shortcut=""
                  active={false}
                  onClick={() => { closePanel(); onAddCard(); }}
                />
                <ToolButton
                  icon={"mdi mdi-link-variant"}
                  label="Reference Card"
                  shortcut=""
                  active={false}
                  onClick={() => { closePanel(); onAddReferenceCard(); }}
                />
              </div>
            )}
          </ButtonWithPanel>
          <ToolButton
            icon={"mdi mdi-image-outline"}
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
          <Button aria-label="Undo (Ctrl+Z)"
            icon={"mdi mdi-undo"}
            variant="ghost"
            size="sm"
            onClick={wb.undo}
            title="Undo (Ctrl+Z)"
          />
          <Button aria-label="Redo (Ctrl+Shift+Z)"
            icon={"mdi mdi-redo"}
            variant="ghost"
            size="sm"
            onClick={wb.redo}
            title="Redo (Ctrl+Shift+Z)"
          />
          <ToolbarDivider />
          <Button aria-label="Toggle Grid (G)"
            icon={"mdi mdi-grid"}
            variant="ghost"
            size="sm"
            active={gridVisible}
            activeGlow="static"
            onClick={wb.toggleGrid}
            title="Toggle Grid (G)"
          />
          <Button aria-label="Snap to Grid"
            icon={"mdi mdi-magnet"}
            variant="ghost"
            size="sm"
            active={gridSnap}
            activeGlow="static"
            onClick={wb.toggleSnap}
            title="Snap to Grid"
          />
          <ToolbarDivider />
          <Button aria-label="Toggle Minimap"
            icon={"mdi mdi-map-outline"}
            variant="ghost"
            size="sm"
            active={minimapVisible}
            activeGlow="static"
            onClick={toggleMinimap}
            title="Toggle Minimap"
          />
        </FloatingButtonArray>
      </div>

      {/* Bottom right — zoom controls */}
      <div className="whiteboard-toolbar whiteboard-toolbar--bottom-right">
        <FloatingButtonArray direction="horizontal" size="sm">
          <Button aria-label="Zoom Out"
            icon={"mdi mdi-minus"}
            variant="ghost"
            size="sm"
            onClick={() => wb.setViewport({ ...data.viewport, zoom: Math.max(0.1, data.viewport.zoom - 0.1) })}
            title="Zoom Out"
          />
          <div role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
            className="whiteboard-zoom__level"
            onClick={() => wb.setViewport({ ...data.viewport, zoom: 1 })}
            title="Reset zoom (Ctrl+0)"
          >
            {Math.round(data.viewport.zoom * 100)}%
          </div>
          <Button aria-label="Zoom In"
            icon={"mdi mdi-plus"}
            variant="ghost"
            size="sm"
            onClick={() => wb.setViewport({ ...data.viewport, zoom: Math.min(5, data.viewport.zoom + 0.1) })}
            title="Zoom In"
          />
          <ToolbarDivider />
          <Button aria-label="Zoom to Fit (Ctrl+1)"
            icon={"mdi mdi-fit-to-screen"}
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
