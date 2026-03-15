/**
 * SidebarContextSections Component
 * 
 * Bottom-anchored sections in the right sidebar that show context-specific
 * information for the currently active node:
 * - Comments section: Shows all comments for the active node (always visible)
 * - Activity section: Shows activity log for the active node
 */
import { useState, useMemo } from 'react';
import { useAppStore } from '@/stores';
import { useComments, useCreateComment, useNodeActivity } from '@/hooks';
import { NodeViewSection } from '../nodes/NodeViewSection';
import { NodeActivityLogSection } from '../nodes/NodeActivityLogSection';
import { NodeCollection } from '../nodes/NodeCollection';
import { Button } from '../core/Button';
import { CommentIcon, ClockIcon, AddIcon, SendIcon } from '../core/icons';
import { TextField } from '../core/TextField';
import type { Comment, Node } from '@/types/api';
import './SidebarContextSections.css';

/** Convert Comment tree to Node tree so NodeCollection can render it */
function commentToNode(c: Comment): Node {
  return {
    id: c.id,
    uuid: c.uuid,
    name: c.name,
    icon: c.icon,
    color: null,
    parent_id: c.parent_id,
    page_id: null,
    sequence: c.sequence,
    collapsed: c.collapsed,
    active: true,
    is_page: false,
    create_date: c.create_date,
    write_date: c.write_date,
    children: c.children?.map(commentToNode),
  };
}

function CommentsList({ comments }: { comments: Comment[] }) {
  const openNode = useAppStore(s => s.openNode);
  const commentNodes = useMemo(() => comments.map(commentToNode), [comments]);

  if (comments.length === 0) {
    return (
      <div className="sidebar-section-empty">
        No comments yet
      </div>
    );
  }

  return (
    <NodeCollection
      nodes={commentNodes}
      viewMode="list"
      editable={false}
      sortable={false}
      hideToolbar
      showEmpty={false}
      size="sm"
      onNodeClick={(node) => openNode(node.id)}
    />
  );
}

/**
 * Inline quick-add for comments from the right sidebar
 */
function QuickAddComment({ nodeId, onClose }: { nodeId: number; onClose: () => void }) {
  const [text, setText] = useState('');
  const createComment = useCreateComment();

  const handleSubmit = () => {
    if (!text.trim()) return;
    createComment.mutate(
      { nodeId, name: text.trim() },
      { onSuccess: () => { setText(''); onClose(); } }
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      setText('');
      onClose();
    }
  };

  return (
    <div className="sidebar-quick-add-comment">
      <TextField
        size="sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a comment..."
        autoFocus
        onBlur={() => { if (!text.trim()) onClose(); }}
        icon={
          <button
            className="sidebar-quick-add-comment__send"
            onClick={handleSubmit}
            disabled={!text.trim()}
            title="Send comment"
          >
            <SendIcon size="xs" />
          </button>
        }
      />
    </div>
  );
}

export function SidebarContextSections() {
  const currentNodeId = useAppStore(state => state.currentNodeId);
  const mainViewType = useAppStore(state => state.mainViewType);
  
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  
  const { data: commentsData, isLoading: commentsLoading } = useComments(
    mainViewType === 'node' ? currentNodeId : null
  );
  const { data: activityData, isLoading: activityLoading } = useNodeActivity(
    mainViewType === 'node' ? currentNodeId : null
  );
  
  const commentCount = useMemo(() => {
    return commentsData?.comments?.length ?? 0;
  }, [commentsData]);
  
  const activityCount = activityData?.length ?? 0;
  const showActivity = activityCount > 0 || activityLoading;
  
  if (mainViewType !== 'node' || !currentNodeId) return null;
  
  // Always show comments section; only show activity if it has content
  if (!showActivity && commentCount === 0 && !commentsLoading) {
    // Show just the comments section with empty state
  }
  
  return (
    <div className="sidebar-context-sections">
      {/* Comments Section — always visible */}
      <NodeViewSection
        title="Comments"
        icon={<CommentIcon size="xs" />}
        count={commentCount}
        expanded={commentsExpanded}
        onExpandedChange={setCommentsExpanded}
        className="sidebar-context-section sidebar-context-section--comments"
        hideWhenEmpty={false}
        headerActions={
          <div className="sidebar-comments-header-actions">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setQuickAddOpen(v => !v)}
              title="Add comment"
            >
              <AddIcon size="xs" />
            </Button>
          </div>
        }
      >
        {quickAddOpen && <QuickAddComment nodeId={currentNodeId} onClose={() => setQuickAddOpen(false)} />}
        {commentsLoading ? (
          <div className="sidebar-section-loading">Loading...</div>
        ) : (
          <CommentsList 
            comments={commentsData?.comments ?? []}
          />
        )}
      </NodeViewSection>
      
      {/* Activity Section */}
      {showActivity && (
        <NodeViewSection
          title="Activity"
          icon={<ClockIcon size="xs" />}
          count={activityCount}
          expanded={activityExpanded}
          onExpandedChange={setActivityExpanded}
          className="sidebar-context-section sidebar-context-section--activity"
          hideWhenEmpty={false}
        >
          {activityLoading ? (
            <div className="sidebar-section-loading">Loading...</div>
          ) : (
            <NodeActivityLogSection nodeId={currentNodeId} />
          )}
        </NodeViewSection>
      )}
    </div>
  );
}

export default SidebarContextSections;
