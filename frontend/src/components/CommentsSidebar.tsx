/**
 * Comments Sidebar Component
 * 
 * Displays comments for a selected node in a sidebar panel.
 * Comments are bullet-point blocks with their children.
 * Positioned between main content and right sidebar.
 */
import { useState, useCallback } from 'react';
import './CommentsSidebar.css';
import { useNodesStore } from '@/stores';
import { useComments, useCreateComment, useDeleteComment, useUpdateNode, useNode } from '@/hooks';
import { AddIcon, CommentIcon, TrashIcon } from './icons';
import { ButtonClose } from './core/ButtonClose';
import { Card } from './core/Card';
import { Button } from './core/Button';
import type { Comment } from '@/types/api';

interface CommentItemProps {
  comment: Comment;
  nodeId: number;
  onDelete: (commentId: number) => void;
  onUpdate: (commentId: number, name: string) => void;
}

function CommentItem({ comment, nodeId, onDelete, onUpdate }: CommentItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.name);
  
  const handleSave = () => {
    if (editContent !== comment.name) {
      onUpdate(comment.id, editContent);
    }
    setIsEditing(false);
  };
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      setEditContent(comment.name);
      setIsEditing(false);
    }
  };
  
  return (
    <Card 
      className="comment-item"
      variant="filled"
      elevation="none"
      padding={true}
      paddingSize="md"
      radius="md"
    >
      <div className="comment-item-header">
        <span className="comment-bullet"></span>
        <span className="comment-date">
          {new Date(comment.create_date).toLocaleDateString()}
        </span>
        <button 
          className="comment-delete-btn"
          onClick={() => onDelete(comment.id)}
          title="Delete comment"
        >
          <TrashIcon size="xs" />
        </button>
      </div>
      
      <div className="comment-item-content">
        {isEditing ? (
          <textarea
            className="comment-edit-input"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        ) : (
          <div 
            className="comment-text"
            onClick={() => setIsEditing(true)}
          >
            {comment.name || <span className="comment-placeholder">Click to edit...</span>}
          </div>
        )}
      </div>
      
      {/* Render children if any */}
      {comment.children && comment.children.length > 0 && (
        <div className="comment-children">
          {comment.children.map((child) => (
            <CommentItem
              key={child.id}
              comment={child}
              nodeId={nodeId}
              onDelete={onDelete}
              onUpdate={onUpdate}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

export function CommentsSidebar() {
  const { 
    commentsSidebarOpen, 
    commentsNodeId, 
    closeCommentsSidebar 
  } = useNodesStore();
  
  const [newCommentText, setNewCommentText] = useState('');
  
  // Fetch node info for display
  const { data: node } = useNode(commentsNodeId);
  
  // Fetch comments for the node
  const { data: commentsData, isLoading, error } = useComments(commentsNodeId);
  
  // Mutations
  const createComment = useCreateComment();
  const deleteComment = useDeleteComment();
  const updateNode = useUpdateNode();
  
  const handleAddComment = useCallback(() => {
    if (!commentsNodeId) return;
    
    createComment.mutate(
      { nodeId: commentsNodeId, name: newCommentText },
      {
        onSuccess: () => {
          setNewCommentText('');
        },
      }
    );
  }, [commentsNodeId, newCommentText, createComment]);
  
  const handleDeleteComment = useCallback((commentId: number) => {
    if (!commentsNodeId) return;
    deleteComment.mutate({ nodeId: commentsNodeId, commentId });
  }, [commentsNodeId, deleteComment]);
  
  const handleUpdateComment = useCallback((commentId: number, name: string) => {
    updateNode.mutate({ id: commentId, data: { name } });
  }, [updateNode]);
  
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAddComment();
    }
  };
  
  if (!commentsSidebarOpen) {
    return null;
  }
  
  return (
    <aside className="comments-sidebar">
      <div className="comments-sidebar-header">
        <div className="comments-sidebar-title">
          <CommentIcon size="sm" />
          <span>Comments</span>
        </div>
        <ButtonClose 
          onClick={closeCommentsSidebar}
          title="Close comments"
          size="sm"
        />
      </div>
      
      {/* Show node info */}
      {node && (
        <div className="comments-node-info">
          <span className="comments-node-name">
            {node.icon && <span className="comments-node-icon">{node.icon}</span>}
            {node.name || 'Untitled'}
          </span>
        </div>
      )}
      
      {/* Comments list */}
      <div className="comments-list">
        {isLoading ? (
          <div className="comments-loading">Loading comments...</div>
        ) : error ? (
          <div className="comments-error">Failed to load comments</div>
        ) : commentsData?.comments.length === 0 ? (
          <div className="comments-empty">
            <CommentIcon size="lg" />
            <p>No comments yet</p>
            <p className="comments-empty-hint">Add a comment below</p>
          </div>
        ) : (
          commentsData?.comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              nodeId={commentsNodeId!}
              onDelete={handleDeleteComment}
              onUpdate={handleUpdateComment}
            />
          ))
        )}
      </div>
      
      {/* Add comment form */}
      <div className="comments-add-form">
        <textarea
          className="comments-add-input"
          placeholder="Add a comment..."
          value={newCommentText}
          onChange={(e) => setNewCommentText(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <Button 
          variant="primary"
          size="md"
          fullWidth
          onClick={handleAddComment}
          disabled={createComment.isPending}
          title="Add comment"
        >
          <AddIcon size="sm" />
          <span>{createComment.isPending ? 'Adding...' : 'Add'}</span>
        </Button>
      </div>
    </aside>
  );
}

export default CommentsSidebar;
