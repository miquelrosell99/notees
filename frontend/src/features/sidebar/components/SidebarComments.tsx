import { useState, useRef, useEffect } from 'react';
import { NodeViewSection } from '@/features/content';
import { useNavigationStore } from '@/stores';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { TextField } from '@/components/ui/TextField';
import { CommentIcon, AddIcon, ReplyIcon } from '@/components/ui/icons';
import { useCreateComment } from '@/features/content';
import type { Node } from '@/types/api';

interface CommentItemProps {
  comment: Node;
  nodeUuid: string;
  isReplying: boolean;
  onReplyToggle: (commentUuid: string | null) => void;
  depth?: number;
}

function CommentItem({ comment, nodeUuid, isReplying, onReplyToggle, depth = 0 }: CommentItemProps) {
  const openNode = useNavigationStore((s) => s.openNode);
  const hasReplies = comment.children && comment.children.length > 0;

  return (
    <div
      className={`sidebar-comment-item ${depth > 0 ? 'sidebar-comment-item--nested' : ''}`}
      style={{ '--comment-depth': depth } as React.CSSProperties}
    >
      <div className="sidebar-comment-item__row">
        <button
          type="button"
          className="sidebar-comment-item__name"
          onClick={() => openNode(comment.uuid)}
        >
          {comment.name}
        </button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onReplyToggle(isReplying ? null : comment.uuid)}
          title={isReplying ? 'Cancel reply' : 'Reply'}
        >
          <ReplyIcon size="xs" />
        </Button>
      </div>
      {isReplying && (
        <div className="sidebar-comment-item__reply">
          <QuickAddComment
            nodeUuid={nodeUuid}
            parentCommentUuid={comment.uuid}
            placeholder="Reply..."
            onClose={() => onReplyToggle(null)}
          />
        </div>
      )}
      {hasReplies && (
        <div className="sidebar-comment-item__replies">
          <CommentsList
            nodeUuid={nodeUuid}
            comments={comment.children!}
            depth={depth + 1}
          />
        </div>
      )}
    </div>
  );
}

interface CommentsListProps {
  nodeUuid: string;
  comments: Node[];
  depth?: number;
}

function CommentsList({ nodeUuid, comments, depth = 0 }: CommentsListProps) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  if (comments.length === 0) {
    return (
      <div className="sidebar-section-empty">
        No comments yet
      </div>
    );
  }

  return (
    <div className="sidebar-comments-list">
      {comments.map((comment) => (
        <CommentItem
          key={comment.uuid}
          comment={comment}
          nodeUuid={nodeUuid}
          isReplying={replyingTo === comment.uuid}
          onReplyToggle={setReplyingTo}
          depth={depth}
        />
      ))}
    </div>
  );
}

interface QuickAddCommentProps {
  nodeUuid: string;
  parentCommentUuid?: string;
  placeholder?: string;
  onClose: () => void;
}

function QuickAddComment({ nodeUuid, parentCommentUuid, placeholder, onClose }: QuickAddCommentProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const createComment = useCreateComment();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (!text.trim()) return;
    createComment.mutate(
      { nodeUuid: nodeUuid, name: text.trim(), parentCommentUuid },
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
        containerClassName="sidebar-quick-add-comment__field"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? 'Add a comment...'}
        ref={inputRef}
        onBlur={() => { if (!text.trim()) onClose(); }}
        icon={
          <Button aria-label="Send comment"
            variant="primary"
            size="xs"
            icon="mdi mdi-send"
            className="sidebar-quick-add-comment__send"
            onClick={handleSubmit}
            disabled={!text.trim()}
            title="Send comment"
          />
        }
      />
    </div>
  );
}

interface SidebarCommentsProps {
  nodeUuid: string;
  comments: Node[];
  count: number;
  loading: boolean;
}

export function SidebarComments({ nodeUuid, comments, count, loading }: SidebarCommentsProps) {
  const [expanded, setExpanded] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  return (
    <NodeViewSection
      title="Comments"
      icon={<CommentIcon size="xs" />}
      count={count}
      expanded={expanded}
      onExpandedChange={setExpanded}
      className="sidebar-context-section sidebar-context-section--comments"
      variant="sidebar"
      hideWhenEmpty={false}
      headerActions={
        <div className="sidebar-comments-header-actions">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setQuickAddOpen((v) => !v)}
            title="Add comment"
          >
            <AddIcon size="xs" />
          </Button>
        </div>
      }
    >
      {quickAddOpen && <QuickAddComment nodeUuid={nodeUuid} onClose={() => setQuickAddOpen(false)} />}
      {loading ? (
        <div className="sidebar-section-loading"><Spinner size="sm" centered /></div>
      ) : (
        <CommentsList nodeUuid={nodeUuid} comments={comments} />
      )}
    </NodeViewSection>
  );
}
