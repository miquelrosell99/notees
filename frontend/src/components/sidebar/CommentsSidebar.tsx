/**
 * Comments Sidebar Component
 * 
 * Polished conversational thread UI for comments, inspired by Tana & Capacities.
 * Features: threaded replies, resolve/unresolve, relative timestamps,
 * auto-growing input, keyboard shortcuts, smooth animations.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import './CommentsSidebar.css';
import { useAppStore } from '@/stores';
import { useComments, useCreateComment, useDeleteComment, useUpdateNode, useNode } from '@/hooks';
import { nodeNameToText } from '@/hooks/useStringifyAST';
import { mdiClose } from '@mdi/js';
import { CommentIcon, ReplyIcon, SendIcon, TrashIcon, ResolveIcon } from '../core/icons';
import { Button } from '../core/Button';
import { Card } from '../core/Card';
import { formatRelativeTime } from '@/utils/dateFormat';
import type { Comment } from '@/types/api';

// ── Helpers ──────────────────────────────────────────────────

function countAllComments(comments: Comment[]): number {
  let count = 0;
  for (const c of comments) {
    count += 1;
    if (c.children?.length) count += countAllComments(c.children);
  }
  return count;
}

// ── Auto-Growing Textarea ────────────────────────────────────

interface CommentInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  submitLabel?: string;
  isPending?: boolean;
  compact?: boolean;
}

function CommentInput({ 
  value, onChange, onSubmit, onCancel, 
  placeholder = 'Write a comment...', 
  autoFocus = false,
  submitLabel = 'Comment',
  isPending = false,
  compact = false,
}: CommentInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  // Auto-focus
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className={`comment-input ${compact ? 'comment-input--compact' : ''}`}>
      <textarea
        ref={textareaRef}
        className="comment-input__textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
      />
      <div className="comment-input__actions">
        {onCancel && (
          <Button variant="ghost" size="xs" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <button
          className="comment-input__send"
          onClick={onSubmit}
          disabled={isPending || !value.trim()}
          title={`${submitLabel} (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter)`}
        >
          <SendIcon size="xs" />
          <span>{isPending ? 'Sending...' : submitLabel}</span>
        </button>
      </div>
    </div>
  );
}

// ── Single Comment Item ──────────────────────────────────────

interface CommentItemProps {
  comment: Comment;
  nodeId: number;
  depth?: number;
  onDelete: (commentId: number) => void;
  onUpdate: (commentId: number, data: Record<string, unknown>) => void;
  onReply: (parentCommentId: number) => void;
  replyingTo: number | null;
  replyText: string;
  onReplyTextChange: (text: string) => void;
  onSubmitReply: () => void;
  onCancelReply: () => void;
  isReplyPending: boolean;
}

function CommentItem({ 
  comment, nodeId, depth = 0,
  onDelete, onUpdate, onReply,
  replyingTo, replyText, onReplyTextChange,
  onSubmitReply, onCancelReply, isReplyPending,
}: CommentItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.name);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const isResolved = comment.collapsed;

  const handleSave = () => {
    if (editContent.trim() !== comment.name) {
      onUpdate(comment.id, { name: editContent.trim() });
    }
    setIsEditing(false);
  };

  const handleToggleResolved = () => {
    onUpdate(comment.id, { collapsed: !isResolved });
  };

  const handleDelete = () => {
    if (showConfirmDelete) {
      onDelete(comment.id);
      setShowConfirmDelete(false);
    } else {
      setShowConfirmDelete(true);
      // Auto-dismiss confirmation after 3s
      setTimeout(() => setShowConfirmDelete(false), 3000);
    }
  };

  return (
    <div 
      className={`comment-thread ${isResolved ? 'comment-thread--resolved' : ''} ${depth > 0 ? 'comment-thread--reply' : ''}`}
    >
      <Card
        className="comment-card"
        variant="filled"
        elevation="none"
        padding={false}
        radius="md"
      >
        <div className="comment-bubble">
          {/* Avatar placeholder */}
          <div className="comment-avatar">
            <CommentIcon size="xs" />
          </div>

          <div className="comment-body">
            {/* Header: timestamp + actions */}
            <div className="comment-header">
              <span className="comment-time" title={new Date(comment.create_date).toLocaleString()}>
                {formatRelativeTime(comment.create_date)}
              </span>
              {comment.write_date !== comment.create_date && (
                <span className="comment-edited" title={`Edited ${new Date(comment.write_date).toLocaleString()}`}>
                  (edited)
                </span>
              )}
              <div className="comment-actions">
                {depth === 0 && (
                  <button
                    className={`comment-action-btn ${isResolved ? 'comment-action-btn--active' : ''}`}
                    onClick={handleToggleResolved}
                    title={isResolved ? 'Unresolve' : 'Resolve'}
                  >
                    <ResolveIcon size="xs" />
                  </button>
                )}
                <button
                  className="comment-action-btn"
                  onClick={() => onReply(comment.id)}
                  title="Reply"
                >
                  <ReplyIcon size="xs" />
                </button>
                <button
                  className={`comment-action-btn ${showConfirmDelete ? 'comment-action-btn--danger' : ''}`}
                  onClick={handleDelete}
                  title={showConfirmDelete ? 'Click again to confirm' : 'Delete'}
                >
                  <TrashIcon size="xs" />
                </button>
              </div>
            </div>

            {/* Content */}
            {isEditing ? (
              <CommentInput
                value={editContent}
                onChange={setEditContent}
                onSubmit={handleSave}
                onCancel={() => { setEditContent(comment.name); setIsEditing(false); }}
                autoFocus
                submitLabel="Save"
                compact
              />
            ) : (
              <div 
                className="comment-content"
                onClick={() => setIsEditing(true)}
                title="Click to edit"
              >
                {isResolved && <span className="comment-resolved-badge">Resolved</span>}
                {nodeNameToText(comment.name) || <span className="comment-placeholder">Empty comment</span>}
              </div>
            )}
          </div>
        </div>

        {/* Child blocks inside the card */}
        {comment.children && comment.children.length > 0 && (
          <div className="comment-child-blocks">
            {comment.children.map((child) => (
              <div key={child.id} className="comment-child-block">
                <span className="comment-child-block__bullet">&bull;</span>
                <span className="comment-child-block__text">
                  {nodeNameToText(child.name) || <span className="comment-placeholder">Empty</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Inline reply form */}
      {replyingTo === comment.id && (
        <div className="comment-reply-form">
          <CommentInput
            value={replyText}
            onChange={onReplyTextChange}
            onSubmit={onSubmitReply}
            onCancel={onCancelReply}
            placeholder="Write a reply..."
            autoFocus
            submitLabel="Reply"
            isPending={isReplyPending}
            compact
          />
        </div>
      )}
    </div>
  );
}

// ── Main Sidebar ─────────────────────────────────────────────

export function CommentsSidebar() {
  const { commentsSidebarOpen, commentsNodeId, closeCommentsSidebar } = useAppStore();

  const [newCommentText, setNewCommentText] = useState('');
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  const [replyText, setReplyText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // Data
  const { data: node } = useNode(commentsNodeId);
  const { data: commentsData, isLoading, error } = useComments(commentsNodeId);
  const createComment = useCreateComment();
  const deleteComment = useDeleteComment();
  const updateNode = useUpdateNode();

  const commentCount = commentsData?.comments
    ? countAllComments(commentsData.comments)
    : 0;

  // Scroll to bottom when new comments arrive
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [commentCount]);

  // ── Handlers ─────────────────────────────────────────────

  const handleAddComment = useCallback(() => {
    if (!commentsNodeId || !newCommentText.trim()) return;
    createComment.mutate(
      { nodeId: commentsNodeId, name: newCommentText.trim() },
      { onSuccess: () => setNewCommentText('') }
    );
  }, [commentsNodeId, newCommentText, createComment]);

  const handleReply = useCallback((parentCommentId: number) => {
    setReplyingTo(parentCommentId);
    setReplyText('');
  }, []);

  const handleSubmitReply = useCallback(() => {
    if (!commentsNodeId || !replyingTo || !replyText.trim()) return;
    createComment.mutate(
      { nodeId: commentsNodeId, name: replyText.trim(), parentCommentId: replyingTo },
      { onSuccess: () => { setReplyingTo(null); setReplyText(''); } }
    );
  }, [commentsNodeId, replyingTo, replyText, createComment]);

  const handleCancelReply = useCallback(() => {
    setReplyingTo(null);
    setReplyText('');
  }, []);

  const handleDelete = useCallback((commentId: number) => {
    if (!commentsNodeId) return;
    deleteComment.mutate({ nodeId: commentsNodeId, commentId });
  }, [commentsNodeId, deleteComment]);

  const handleUpdate = useCallback((commentId: number, data: Record<string, unknown>) => {
    updateNode.mutate({ id: commentId, data });
  }, [updateNode]);

  if (!commentsSidebarOpen) return null;

  return (
    <aside className="comments-sidebar">
      {/* Header */}
      <div className="comments-sidebar-header">
        <div className="comments-sidebar-title">
          <CommentIcon size="sm" />
          <span>Comments</span>
          {commentCount > 0 && (
            <span className="comments-count-badge">{commentCount}</span>
          )}
        </div>
        <Button 
          icon={mdiClose} iconOnly
          onClick={closeCommentsSidebar}
          title="Close comments"
          size="sm" variant="ghost"
        />
      </div>

      {/* Node context bar */}
      {node && (
        <div className="comments-node-info">
          {node.icon && <span className="comments-node-icon">{node.icon}</span>}
          <span className="comments-node-name">
            {nodeNameToText(node.name) || 'Untitled'}
          </span>
        </div>
      )}

      {/* Thread list */}
      <div className="comments-list" ref={listRef}>
        {isLoading ? (
          <div className="comments-state">
            <div className="comments-state__spinner" />
            <span>Loading comments...</span>
          </div>
        ) : error ? (
          <div className="comments-state comments-state--error">
            Failed to load comments
          </div>
        ) : commentsData?.comments.length === 0 ? (
          <div className="comments-empty-state">
            <div className="comments-empty-state__icon">
              <CommentIcon size="lg" />
            </div>
            <p className="comments-empty-state__title">No comments yet</p>
            <p className="comments-empty-state__hint">
              Start a discussion — add a comment below
            </p>
          </div>
        ) : (
          commentsData?.comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              nodeId={commentsNodeId!}
              onDelete={handleDelete}
              onUpdate={handleUpdate}
              onReply={handleReply}
              replyingTo={replyingTo}
              replyText={replyText}
              onReplyTextChange={setReplyText}
              onSubmitReply={handleSubmitReply}
              onCancelReply={handleCancelReply}
              isReplyPending={createComment.isPending}
            />
          ))
        )}
      </div>

      {/* New comment input */}
      <div className="comments-compose">
        <CommentInput
          value={newCommentText}
          onChange={setNewCommentText}
          onSubmit={handleAddComment}
          isPending={createComment.isPending}
          autoFocus={commentsSidebarOpen}
        />
      </div>
    </aside>
  );
}

export default CommentsSidebar;
