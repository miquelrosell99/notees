/**
 * LibraryInspector — right pane of the Library three-pane layout (Task 11).
 *
 * Shows the selected source's class-bound property panel (the
 * `PropertiesSection` view primitive); edits persist through the normal
 * property ops. The pane never navigates — opening the full node view is an
 * explicit action.
 */
import { useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { useNode } from '@/features/content/hooks/useNodes';
import { viewPrimitives } from '@/plugins/core';
import { libraryNodeName } from '../libraryUtils';

const { PropertiesSection } = viewPrimitives;

interface LibraryInspectorProps {
  nodeUuid: string;
  onOpenNode: (nodeUuid: string) => void;
  onClose: () => void;
}

export function LibraryInspector({ nodeUuid, onOpenNode, onClose }: LibraryInspectorProps) {
  const { data: node } = useNode(nodeUuid);

  const handleOpen = useCallback(() => onOpenNode(nodeUuid), [onOpenNode, nodeUuid]);

  return (
    <aside className="library-inspector" aria-label="Source metadata">
      <div className="library-inspector__header">
        <span className="library-inspector__title">
          {node ? libraryNodeName(node) : 'Source'}
        </span>
        <div className="library-inspector__actions">
          <Button
            variant="ghost"
            size="sm"
            icon="mdi mdi-open-in-new"
            onClick={handleOpen}
            aria-label="Open source"
            title="Open source"
          />
          <Button
            variant="ghost"
            size="sm"
            icon="mdi mdi-close"
            onClick={onClose}
            aria-label="Close inspector"
            title="Close inspector"
          />
        </div>
      </div>
      {/* key: remount the panel when the selection changes to another source */}
      <PropertiesSection key={nodeUuid} nodeUuid={nodeUuid} className="library-inspector__properties" />
    </aside>
  );
}

export default LibraryInspector;
