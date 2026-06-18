import React from 'react';
import { FloatingButtonArray, ToolbarDivider } from '@/components/ui/FloatingButtonArray';
import { Button } from '@/components/ui/Button';
import { SelectionButton } from '@/components/ui/SelectionButton';
import type { StrokeStyle, WhiteboardConnectorElement } from '@/features/whiteboard/types/whiteboard';
import type { UseWhiteboardReturn } from '@/features/whiteboard/hooks/useWhiteboard';
import { STROKE_STYLE_OPTIONS } from './constants';

export interface SelectionActionsPanelProps {
  wb: UseWhiteboardReturn;
}

export const SelectionActionsPanel: React.FC<SelectionActionsPanelProps> = ({ wb }) => {
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
      <Button aria-label="Duplicate (Ctrl+D)"
        icon={"mdi mdi-content-duplicate"}
        variant="ghost"
        size="sm"
        onClick={() => wb.duplicateElements(selectedIds)}
        title="Duplicate (Ctrl+D)"
      />
      <Button aria-label={anyLocked ? 'Unlock' : 'Lock'}
        icon={anyLocked ? "mdi mdi-lock-open-outline" : "mdi mdi-lock-outline"}
        variant="ghost"
        size="sm"
        onClick={() => {
          for (const id of selectedIds) {
            wb.updateElement(id, { locked: !anyLocked });
          }
        }}
        title={anyLocked ? 'Unlock' : 'Lock'}
      />
      <Button aria-label="Bring to Front (])"
        icon={"mdi mdi-arrange-bring-to-front"}
        variant="ghost"
        size="sm"
        onClick={() => wb.bringToFront(selectedIds)}
        title="Bring to Front (])"
      />
      <Button aria-label="Send to Back ([)"
        icon={"mdi mdi-arrange-send-to-back"}
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
          <Button aria-label={isGrouped ? 'Ungroup (Ctrl+G)' : 'Group (Ctrl+G)'}
            icon={isGrouped ? "mdi mdi-ungroup" : "mdi mdi-group"}
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
      <Button aria-label="Delete (Delete)"
        icon={"mdi mdi-delete-outline"}
        variant="danger"
        size="sm"
        onClick={() => wb.removeElements(selectedIds)}
        title="Delete (Delete)"
      />
    </FloatingButtonArray>
  );
};
