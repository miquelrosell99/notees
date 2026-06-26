/**
 * NodeActivityLogSection Component
 * 
 * Displays a log of activities for a node (edit, link added, archived, etc.)
 * Uses BlockPreview component for consistent visual style.
 * NodeViewSection wrapping is handled by NodeView.
 * Users can delete entries but not edit them.
 */
import { useState, useCallback } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { useNodeActivity, useDeleteNodeActivity } from '@/features/content';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { splitTextWithLinks } from '@/lib/noteesUri';
import { getNodeByUuid } from '@/api/nodes';
import { useNavigationStore } from '@/stores';
import { Bullet } from '@/features/content/components/blocks/Bullet';
import { NodeViewSection } from './NodeViewSection';
import { ClockIcon } from '@/components/ui/icons';
import type { NodeActivity } from '../../api/activity';
import './NodeActivityLogSection.css';

interface NodeActivityLogSectionProps {
  nodeUuid: string;
  defaultExpanded?: boolean;
  /** Visual variant passed to the underlying section chrome. */
  variant?: 'default' | 'sidebar-node' | 'sidebar';
  /** When true, hides the entire section (used by focus mode). */
  focusMode?: boolean;
}

// Note: link_inserted is intentionally omitted because the backend provides
// a full sentence in details (e.g. "Link to [Node](notees:uuid) inserted").
const ACTION_LABELS: Record<string, string> = {
  created: 'Created',
  edited: 'Edited',
  archived: 'Archived',
  unarchived: 'Unarchived',
  type_added: 'Added class',
  type_removed: 'Removed class',
  property_changed: 'Property changed',
  moved: 'Moved',
  deleted: 'Deleted',
};

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  // Within last hour
  if (diff < 60 * 60 * 1000) {
    const mins = Math.floor(diff / (60 * 1000));
    return mins <= 1 ? 'Just now' : `${mins}m ago`;
  }
  
  // Within last day
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diff / (60 * 60 * 1000));
    return `${hours}h ago`;
  }
  
  // Within last week
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    return `${days}d ago`;
  }
  
  // Otherwise show date
  return date.toLocaleDateString();
}

function formatActivityMessage(activity: NodeActivity): string {
  // For link_inserted, details now contain markdown links with notees: URIs
  // e.g. "Link to [Node Name](notees:uuid) inserted"
  if (activity.action === 'link_inserted' && activity.details) {
    return activity.details;
  }
  
  const label = ACTION_LABELS[activity.action] || activity.action;
  
  // Build a notees: markdown link if we have target node info
  if (activity.target_node_name && activity.target_node_uuid) {
    return `${label} [${activity.target_node_name}](notees:${activity.target_node_uuid})`;
  }
  
  if (activity.target_node_name) {
    return `${label} "${activity.target_node_name}"`;
  }
  
  if (activity.details) {
    return `${label}: ${activity.details}`;
  }
  
  return label;
}

/**
 * Render an activity message with clickable notees: links.
 * Splits the text into segments and renders links as clickable spans
 * that navigate to the target node by UUID.
 */
function ActivityMessage({ activity }: { activity: NodeActivity }) {
  const openNode = useNavigationStore(state => state.openNode);
  const message = formatActivityMessage(activity);
  const time = formatDate(activity.create_date);
  const segments = splitTextWithLinks(message);

  const handleLinkClick = useCallback(async (nodeUuid: string) => {
    try {
      const node = await getNodeByUuid(nodeUuid);
      if (node?.uuid) {
        openNode(node.uuid);
      }
    } catch {
      // Node may have been deleted
    }
  }, [openNode]);

  return (
    <span className="activity-message">
      <Bullet nodeUuid={activity.nodeUuid} interactive={false} size="sm" dimmed />
      <span className="activity-message__text">
        {segments.map((seg, i) =>
          seg.type === 'link' ? (
            <button
              key={i}
              type="button"
              className="activity-node-link"
              onClick={() => handleLinkClick(seg.uuid)}
            >
              {seg.label}
            </button>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
        <span className="activity-time"> — {time}</span>
      </span>
    </span>
  );
}


export function NodeActivityLogSection({ nodeUuid, defaultExpanded = false, variant = 'default', focusMode = false }: NodeActivityLogSectionProps) {
  const internalVariant = variant;
  const { data: activities, isLoading } = useNodeActivity(nodeUuid);
  const deleteActivity = useDeleteNodeActivity();
  
  const [contextMenu, setContextMenu] = useState<{
    activityId: string;
    position: { x: number; y: number };
  } | null>(null);

  const handleContextMenu = useCallback((activityId: string, e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      activityId,
      position: { x: e.clientX, y: e.clientY },
    });
  }, []);

  const handleDeleteActivity = useCallback((activityId: string) => {
    deleteActivity.mutate({ nodeUuid, activityId });
    setContextMenu(null);
  }, [nodeUuid, deleteActivity]);

  const contextMenuItems: ContextMenuItem[] = contextMenu ? [
    {
      id: 'delete',
      label: 'Delete entry',
      icon: "mdi mdi-trash-can-outline",
      danger: true,
      onClick: () => handleDeleteActivity(contextMenu.activityId),
    },
  ] : [];

  const count = activities?.length ?? 0;

  return (
    <NodeViewSection
      title="Activity Log"
      icon={<ClockIcon size="sm" />}
      count={count}
      defaultExpanded={defaultExpanded}
      hideWhenEmpty={false}
      variant={variant}
      focusMode={focusMode}
    >
      <div className="node-activity-log" data-variant={internalVariant}>
        <div className="node-activity-list" data-variant={internalVariant}>
          {isLoading ? (
            <div className="node-activity-loading"><Spinner size="sm" /></div>
          ) : count === 0 || !activities ? (
            <div className="node-activity-empty" data-variant={internalVariant}>No activity recorded yet</div>
          ) : (
            activities.map(activity => (
              <div
                key={activity.nodeUuid}
                className="node-activity-item"
                data-variant={internalVariant}
                onContextMenu={(e) => handleContextMenu(activity.nodeUuid, e)}
              >
                <ActivityMessage activity={activity} />
              </div>
            ))
          )}
        </div>
        
        {contextMenu && (
          <ContextMenu
            items={contextMenuItems}
            position={contextMenu.position}
            onClose={() => setContextMenu(null)}
          />
        )}
      </div>
    </NodeViewSection>
  );
}

