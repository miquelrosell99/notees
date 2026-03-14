/**
 * SidebarContextSections Component
 * 
 * Bottom-anchored sections in the right sidebar that show context-specific
 * information for the currently active node:
 * - Comments section: Shows all comments for the active node (always visible)
 * - Activity section: Shows activity log for the active node
 */
import { useState, useCallback, useMemo } from 'react';
import { useAppStore } from '@/stores';
import { useComments, useCreateComment, useNodeActivity } from '@/hooks';
import { NodeViewSection } from '../nodes/NodeViewSection';
import { NodeActivityLogSection } from '../nodes/NodeActivityLogSection';
import { Button } from '../core/Button';
import { CommentIcon, ClockIcon, AddIcon, SendIcon } from '../core/icons';
import { TextField } from '../core/TextField';
import { formatRelativeTime } from '@/utils/dateFormat';
import type { Comment } from '@/types/api';
import './SidebarContextSections.css';

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

interface CommentRowProps {
  comment: Comment;
  depth?: number;
  onClickComment: () => void;
}

function CommentRow({ comment, depth = 0, onClickComment }: CommentRowProps) {
  const snippet = comment.name?.slice(0, 80) || 'Empty comment';
  const time = formatRelativeTime(comment.create_date);
  const isResolved = comment.collapsed;
  
  return (
    <>
      <div 
        className={`sidebar-comment-row ${isResolved ? 'sidebar-comment-row--resolved' : ''}`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={onClickComment}
      >
        <div className="sidebar-comment-row__content">
          <span className="sidebar-comment-row__snippet">
            {isResolved && <span className="sidebar-comment-row__resolved">&check;</span>}
            {snippet}
          </span>
          <span className="sidebar-comment-row__meta">
            <span className="sidebar-comment-row__time">{time}</span>
            {comment.children && comment.children.length > 0 && (
              <span className="sidebar-comment-row__replies">
                {comment.children.length} {comment.children.length === 1 ? 'reply' : 'replies'}
              </span>
            )}
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
  onClickComment: () => void;
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
  const { openCommentsForNode } = useAppStore();
  
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
    return countAllComments(commentsData.comments);
  }, [commentsData]);
  
  const activityCount = activityData?.length ?? 0;
  const showActivity = activityCount > 0 || activityLoading;
  
  const handleOpenComments = useCallback(() => {
    if (currentNodeId) openCommentsForNode(currentNodeId);
  }, [currentNodeId, openCommentsForNode]);
  
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
            {commentCount > 0 && (
              <Button
                variant="ghost"
                size="xs"
                onClick={handleOpenComments}
                title="Open full comments panel"
              >
                <CommentIcon size="xs" />
              </Button>
            )}
          </div>
        }
      >
        {quickAddOpen && <QuickAddComment nodeId={currentNodeId} onClose={() => setQuickAddOpen(false)} />}
        {commentsLoading ? (
          <div className="sidebar-section-loading">Loading...</div>
        ) : (
          <CommentsList 
            comments={commentsData?.comments ?? []}
            onClickComment={handleOpenComments}
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
