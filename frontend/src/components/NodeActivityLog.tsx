/**
 * NodeActivityLog Component
 * 
 * Displays a log of activities for a node (edit, link added, archived, etc.)
 * Uses bullet-style display for list items.
 * Uses NodeViewSection for consistent collapsible header.
 * Users can delete entries but not edit them.
 */
import { useState, useCallback } from 'react';
import { useNodeActivity, useDeleteNodeActivity } from '@/hooks';
import { mdiHistory, mdiTrashCanOutline, mdiRefresh } from '@mdi/js';
import Icon from '@mdi/react';
import { Bullet } from './Bullet';
import { NodeViewSection } from './NodeViewSection';
import { ContextMenu, type ContextMenuItem } from './core/ContextMenu';
import './NodeActivityLog.css';

interface NodeActivityLogProps {
  nodeId: number;
  /** Whether to show in expanded or collapsed state */
  defaultExpanded?: boolean;
}

export interface NodeActivity {
  id: number;
  node_id: number;
  action: 'created' | 'edited' | 'link_added' | 'link_removed' | 'link_inserted' | 'archived' | 'unarchived' | 'type_added' | 'type_removed' | 'property_changed' | 'moved';
  details?: string;
  target_node_id?: number;
  target_node_name?: string;
  create_date: string;
}

const ACTION_LABELS: Record<string, string> = {
  created: 'Created',
  edited: 'Edited',
  link_added: 'Added link to',
  link_removed: 'Removed link to',
  link_inserted: 'Linked from',
  archived: 'Archived',
  unarchived: 'Unarchived',
  type_added: 'Added type',
  type_removed: 'Removed type',
  property_changed: 'Property changed',
  moved: 'Moved',
};

const ACTION_ICONS: Record<string, string> = {
  created: '✨',
  edited: '✏️',
  link_added: '🔗',
  link_removed: '🔗',
  link_inserted: '🔗',
  archived: '📦',
  unarchived: '📤',
  type_added: '🏷️',
  type_removed: '🏷️',
  property_changed: '⚙️',
  moved: '📁',
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
  // For link_inserted, we store the full message in details
  if (activity.action === 'link_inserted' && activity.details) {
    return activity.details;
  }
  
  const label = ACTION_LABELS[activity.action] || activity.action;
  
  if (activity.target_node_name) {
    return `${label} "${activity.target_node_name}"`;
  }
  
  if (activity.details) {
    return `${label}: ${activity.details}`;
  }
  
  return label;
}

export function NodeActivityLog({ nodeId, defaultExpanded = false }: NodeActivityLogProps) {
  const { data: activities, isLoading, refetch } = useNodeActivity(nodeId);
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
      icon: mdiTrashCanOutline,
      danger: true,
      onClick: () => handleDeleteActivity(contextMenu.activityId),
    },
  ] : [];

  if (isLoading) {
    return (
      <NodeViewSection
        title="Activity"
        icon={<Icon path={mdiHistory} size={0.7} />}
        defaultExpanded={defaultExpanded}
      >
        <div className="node-activity-loading">Loading...</div>
      </NodeViewSection>
    );
  }

  return (
    <NodeViewSection
      title="Activity"
      icon={<Icon path={mdiHistory} size={0.7} />}
      count={activities?.length ?? 0}
      defaultExpanded={defaultExpanded}
      headerActions={
        <button
          className="node-activity-btn"
          onClick={(e) => { e.stopPropagation(); refetch(); }}
          title="Refresh"
        >
          <Icon path={mdiRefresh} size={0.6} />
        </button>
      }
    >
      <div className="node-activity-list">
        {!activities || activities.length === 0 ? (
          <div className="node-activity-empty">No activity recorded</div>
        ) : (
          activities.map(activity => (
            <div
              key={activity.id}
              className="node-activity-item"
              onContextMenu={(e) => handleContextMenu(activity.id, e)}
            >
              <Bullet
                interactive={false}
                size="xs"
              />
              <div className="node-activity-content">
                <span className="node-activity-icon">{ACTION_ICONS[activity.action] || '📝'}</span>
                <span className="node-activity-message">
                  {formatActivityMessage(activity)}
                </span>
                <span className="node-activity-time">
                  {formatDate(activity.create_date)}
                </span>
              </div>
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
    </NodeViewSection>
  );
}

export default NodeActivityLog;
