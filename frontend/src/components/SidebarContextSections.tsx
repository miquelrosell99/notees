/**
 * SidebarContextSections Component
 * 
 * Bottom-anchored sections in the right sidebar that show context-specific
 * information for the currently active node:
 * - Comments section: Shows all comments for the active node
 * - Activity section: Shows activity log for the active node
 * 
 * These sections:
 * - Are NOT cards (lighter visual weight)
 * - Are not reorderable, pinnable, or draggable
 * - React to the currently active node (currentNodeId)
 * - Are collapsed by default
 * - Only render if they have content for the active node
 * - Expansion state is stored per session (not per node)
 */
import { useState, useCallback, useMemo } from 'react';
import { useNodesStore } from '@/stores';
import { useComments, useNodeActivity } from '@/hooks';
import { NodeViewSection } from './nodes/NodeViewSection';
import { NodeActivityLogSection } from './nodes/NodeActivityLogSection';
import { Button } from './core/Button';
import { CommentIcon, ClockIcon, AddIcon } from './icons';
import type { Comment } from '@/types/api';
import './SidebarContextSections.css';

/**
 * Flatten comments tree to get total count (node-level + block-level)
 */
function countAllComments(comments: Comment[]): number {
  let count = 0;
  for (const comment of comments) {
    count += 1;
    if (comment.children && comment.children.length > 0) {
      count += countAllComments(comment.children);
    }
  }
  return count;
}

/**
 * Format relative timestamp for display
 */
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  if (diff < 60 * 1000) return 'Just now';
  if (diff < 60 * 60 * 1000) {
    const mins = Math.floor(diff / (60 * 1000));
    return `${mins}m ago`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diff / (60 * 60 * 1000));
    return `${hours}h ago`;
  }
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));
    return `${days}d ago`;
  }
  return date.toLocaleDateString();
}

interface CommentRowProps {
  comment: Comment;
  depth?: number;
  onClickComment: (commentId: number) => void;
}

function CommentRow({ comment, depth = 0, onClickComment }: CommentRowProps) {
  const snippet = comment.name?.slice(0, 80) || 'Empty comment';
  const time = formatRelativeTime(comment.create_date);
  
  return (
    <>
      <div 
        className="sidebar-comment-row"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onClickComment(comment.id)}
      >
        <div className="sidebar-comment-row__content">
          <span className="sidebar-comment-row__snippet">{snippet}</span>
          <span className="sidebar-comment-row__meta">
            <span className="sidebar-comment-row__time">{time}</span>
          </span>
        </div>
      </div>
      {comment.children?.map(child => (
        <CommentRow 
          key={child.id} 
          comment={child} 
          depth={depth + 1}
          onClickComment={onClickComment}
        />
      ))}
    </>
  );
}

interface CommentsListProps {
  comments: Comment[];
  onClickComment: (commentId: number) => void;
}

function CommentsList({ comments, onClickComment }: CommentsListProps) {
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
        <CommentRow 
          key={comment.id} 
          comment={comment}
          onClickComment={onClickComment}
        />
      ))}
    </div>
  );
}

export function SidebarContextSections() {
  // Get the currently active/viewed node ID
  const currentNodeId = useNodesStore(state => state.currentNodeId);
  const mainViewType = useNodesStore(state => state.mainViewType);
  const { openCommentsForNode } = useNodesStore();
  
  // Expansion state - stored per session, not per node
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  
  // Fetch data for the active node
  const { data: commentsData, isLoading: commentsLoading } = useComments(
    mainViewType === 'node' ? currentNodeId : null
  );
  const { data: activityData, isLoading: activityLoading } = useNodeActivity(
    mainViewType === 'node' ? currentNodeId : null
  );
  
  // Calculate counts
  const commentCount = useMemo(() => {
    if (!commentsData?.comments) return 0;
    return countAllComments(commentsData.comments);
  }, [commentsData]);
  
  const activityCount = activityData?.length ?? 0;
  
  // Visibility rules: don't render if no content
  const showComments = commentCount > 0 || commentsLoading;
  const showActivity = activityCount > 0 || activityLoading;
  
  // Handle clicking a comment row - opens the comments sidebar focused on that node
  const handleClickComment = useCallback((_commentId: number) => {
    if (currentNodeId) {
      openCommentsForNode(currentNodeId);
    }
  }, [currentNodeId, openCommentsForNode]);
  
  // Handle adding a new comment - opens the comments sidebar
  const handleAddComment = useCallback(() => {
    if (currentNodeId) {
      openCommentsForNode(currentNodeId);
    }
  }, [currentNodeId, openCommentsForNode]);
  
  // Don't render anything if not viewing a node or no sections to show
  if (mainViewType !== 'node' || !currentNodeId) {
    return null;
  }
  
  if (!showComments && !showActivity) {
    return null;
  }
  
  return (
    <div className="sidebar-context-sections">
      {/* Comments Section */}
      {showComments && (
        <NodeViewSection
          title="Comments"
          icon={<CommentIcon size="xs" />}
          count={commentCount}
          expanded={commentsExpanded}
          onExpandedChange={setCommentsExpanded}
          className="sidebar-context-section sidebar-context-section--comments"
          hideWhenEmpty={false}
          headerActions={
            <Button
              variant="ghost"
              size="xs"
              onClick={handleAddComment}
              title="Add comment"
            >
              <AddIcon size="xs" />
            </Button>
          }
        >
          {commentsLoading ? (
            <div className="sidebar-section-loading">Loading...</div>
          ) : (
            <CommentsList 
              comments={commentsData?.comments ?? []}
              onClickComment={handleClickComment}
            />
          )}
        </NodeViewSection>
      )}
      
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
