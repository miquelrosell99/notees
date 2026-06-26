import { useState, useMemo, useRef, useEffect } from 'react';
import { NodeViewSection } from '@/features/content';
import { useNavigationStore } from '@/stores';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { TextField } from '@/components/ui/TextField';
import { NodeCollection } from '@/features/content';
import { CommentIcon, AddIcon } from '@/components/ui/icons';
import { useCreateComment } from '@/features/content';
import type { Node } from '@/types/api';

interface CommentsListProps {
  comments: Node[];
}

function CommentsList({ comments }: CommentsListProps) {
  const openNode = useNavigationStore(s => s.openNode);

  const collapsedComments = useMemo(
    () => comments.map(c => ({ ...c, collapsed: !!(c.children && c.children.length > 0) })),
    [comments]
  );

  if (comments.length === 0) {
    return (
      <div className="sidebar-section-empty">
        No comments yet
      </div>
    );
  }

  return (
    <div className="sidebar-comments-list">
      <NodeCollection
        nodes={collapsedComments}
        viewMode="list"
        editable={false}
        sortable={false}
        hideToolbar
        showEmpty={false}
        size="sm"
        onNodeClick={(node) => openNode(node.uuid)}
      />
    </div>
  );
}

interface QuickAddCommentProps {
  nodeUuid: string;
  onClose: () => void;
}

function QuickAddComment({ nodeUuid, onClose }: QuickAddCommentProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const createComment = useCreateComment();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    if (!text.trim()) return;
    createComment.mutate(
      { nodeUuid: nodeUuid, name: text.trim() },
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
        placeholder="Add a comment..."
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
            onClick={() => setQuickAddOpen(v => !v)}
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
        <CommentsList comments={comments} />
      )}
    </NodeViewSection>
  );
}
