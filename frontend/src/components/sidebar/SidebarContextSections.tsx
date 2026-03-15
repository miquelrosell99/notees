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
import { useComments, useCreateComment, useNodeActivity, useNode } from '@/hooks';
import { NodeViewSection } from '../nodes/NodeViewSection';
import { NodeActivityLogSection } from '../nodes/NodeActivityLogSection';
import { NodeCollection } from '../nodes/NodeCollection';
import { Button } from '../core/Button';
import { Card } from '../core/Card';
import { CommentIcon, ClockIcon, AddIcon, SendIcon } from '../core/icons';
import { TextField } from '../core/TextField';
import { formatRelativeTime } from '@/utils/dateFormat';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import type { Comment } from '@/types/api';
import './SidebarContextSections.css';

function countTopLevelComments(comments: Comment[]): number {
  return comments.length;
}

function CommentChildren({ commentId }: { commentId: number }) {
  const { data: commentNode } = useNode(commentId, { include_children: true });
  const children = commentNode?.children;
  if (!children || children.length === 0) return null;
  return (
    <div className="sidebar-comment-card__children">
      <NodeCollection
        nodes={children}
        viewMode="list"
        editable={false}
        sortable={false}
        hideToolbar
        showEmpty={false}
      />
    </div>
  );
}

function CommentThread({ comment }: { comment: Comment }) {
  const openNode = useAppStore(s => s.openNode);
  const time = formatRelativeTime(comment.create_date);
  const isResolved = comment.collapsed;

  return (
    <Card
      className={`sidebar-comment-card ${isResolved ? 'sidebar-comment-card--resolved' : ''}`}
      elevation="none"
      variant="outlined"
      paddingSize="sm"
    >
      <div
        className="sidebar-comment-card__header"
        onClick={() => openNode(comment.id)}
      >
        <span className="sidebar-comment-card__snippet">
          {isResolved && <span className="sidebar-comment-card__resolved">&check;</span>}
          {nodeNameToText(comment.name, 80) || 'Empty comment'}
        </span>
        <span className="sidebar-comment-card__time">{time}</span>
      </div>
      <CommentChildren commentId={comment.id} />
    </Card>
  );
}

function CommentsList({ comments }: { comments: Comment[] }) {
  if (comments.length === 0) {
    return (
      <div className="sidebar-section-empty">
        No comments yet
      </div>
    );
  }

  return (
    <div className="sidebar-comments-list">
      {comments.map(comment => (
        <CommentThread key={comment.id} comment={comment} />
      ))}
    </div>
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
    if (!commentsData?.comments) return 0;
    return countTopLevelComments(commentsData.comments);
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
