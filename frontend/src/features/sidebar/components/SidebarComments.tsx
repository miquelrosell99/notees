import { useState, useMemo } from 'react';
import { NodeViewSection } from '@/features/content/components/nodes/NodeViewSection';
import { useNavigationStore } from '@/stores';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { TextField } from '@/components/ui/TextField';
import { NodeCollection } from '@/features/content/components/nodes/NodeCollection';
import { CommentIcon, AddIcon } from '@/components/ui/icons';
import { useCreateComment } from '@/hooks';
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
    <NodeCollection
      nodes={collapsedComments}
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

interface QuickAddCommentProps {
  nodeId: number;
  onClose: () => void;
}

function QuickAddComment({ nodeId, onClose }: QuickAddCommentProps) {
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
          <Button
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
  nodeId: number;
  comments: Node[];
  count: number;
  loading: boolean;
}

export function SidebarComments({ nodeId, comments, count, loading }: SidebarCommentsProps) {
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
      {quickAddOpen && <QuickAddComment nodeId={nodeId} onClose={() => setQuickAddOpen(false)} />}
      {loading ? (
        <div className="sidebar-section-loading"><Spinner size="sm" centered /></div>
      ) : (
        <CommentsList comments={comments} />
      )}
    </NodeViewSection>
  );
}
