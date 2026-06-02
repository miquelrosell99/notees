/**
 * NodeActivityLogSection Component
 * 
 * Displays a log of activities for a node (edit, link added, archived, etc.)
 * Uses BlockPreview component for consistent visual style.
 * NodeViewSection wrapping is handled by NodeView.
 * Users can delete entries but not edit them.
 */
import { useState, useCallback } from 'react';
import { Spinner } from '@/components/core/Spinner';
import { useNodeActivity, useDeleteNodeActivity } from '@/hooks';
import { ContextMenu, type ContextMenuItem } from '@/components/core/ContextMenu';
import { splitTextWithLinks } from '@/lib/noteesUri';
import { getNodeByUuid } from '@/api/nodes';
import { useNavigationStore } from '@/stores';
import { Bullet } from '@/components/blocks/Bullet';
import { NodeViewSection } from './NodeViewSection';
import { ClockIcon } from '@/components/core/icons';
import './NodeActivityLogSection.css';

interface NodeActivityLogSectionProps {
  nodeId: number;
  defaultExpanded?: boolean;
}

interface NodeActivity {
  id: number;
  node_id: number;
  action: 'created' | 'edited' | 'link_inserted' | 'archived' | 'unarchived' | 'type_added' | 'type_removed' | 'property_changed' | 'moved' | 'deleted';
  details?: string;
  target_node_id?: number;
  target_node_name?: string;
  target_node_uuid?: string;
  create_date: string;
}

const ACTION_LABELS: Record<string, string> = {
  created: 'Created',
  edited: 'Edited',
  link_inserted: 'Linked from',
  archived: 'Archived',
  unarchived: 'Unarchived',
  type_added: 'Added type',
  type_removed: 'Removed type',
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

  const handleLinkClick = useCallback(async (uuid: string) => {
    try {
      const node = await getNodeByUuid(uuid);
      if (node?.id) {
        openNode(node.id);
      }
    } catch {
      // Node may have been deleted
    }
  }, [openNode]);

  return (
    <span className="node-inline">
      <Bullet nodeId={activity.id} interactive={false} size="sm" />
      <span className="node-inline__text">
        {segments.map((seg, i) =>
          seg.type === 'link' ? (
            <span
              key={i}
              className="activity-node-link"
              role="button"
              tabIndex={0}
              onClick={() => handleLinkClick(seg.uuid)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleLinkClick(seg.uuid); }}
            >
              {seg.label}
            </span>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
        <span className="activity-time"> — {time}</span>
      </span>
    </span>
  );
}


export function NodeActivityLogSection({ nodeId, defaultExpanded = false }: NodeActivityLogSectionProps) {
  const { data: activities, isLoading } = useNodeActivity(nodeId);
  const deleteActivity = useDeleteNodeActivity();
  
  const [contextMenu, setContextMenu] = useState<{
    activityId: number;
    position: { x: number; y: number };
  } | null>(null);

  const handleContextMenu = useCallback((activityId: number, e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      activityId,
      position: { x: e.clientX, y: e.clientY },
    });
  }, []);

  const handleDeleteActivity = useCallback((activityId: number) => {
    deleteActivity.mutate({ nodeId, activityId });
    setContextMenu(null);
  }, [nodeId, deleteActivity]);

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
    >
      <div className="node-activity-log">
        <div className="node-activity-list">
          {isLoading ? (
            <div className="node-activity-loading"><Spinner size="sm" /></div>
          ) : count === 0 || !activities ? (
            <div className="node-activity-empty">No activity recorded</div>
          ) : (
            activities.map(activity => (
              <div
                key={activity.id}
                className="node-activity-item"
                onContextMenu={(e) => handleContextMenu(activity.id, e)}
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

