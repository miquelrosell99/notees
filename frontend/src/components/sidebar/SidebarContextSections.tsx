/**
 * SidebarContextSections Component
 * 
 * Bottom-anchored sections in the right sidebar that show context-specific
 * information for the currently active node:
 * - Comments section: Shows all comments for the active node (always visible)
 * - Activity section: Shows activity log for the active node
 */
import { useState, useMemo, useEffect, useCallback } from 'react';
import { useAppStore, useSettingsStore, formatDate } from '@/stores';
import { useComments, useCreateComment, useNodeActivity, useNode, nodeNameToText } from '@/hooks';
import { getNodeVersions, restoreNodeVersion } from '@/api/nodes';
import type { NodeVersion } from '@/api/nodes';
import { NodeViewSection } from '../nodes/NodeViewSection';
import { NodeActivityLogSection } from '../nodes/NodeActivityLogSection';
import { NodeCollection } from '../nodes/NodeCollection';
import { Button } from '../core/Button';
import { CommentIcon, ClockIcon, AddIcon, SendIcon } from '../core/icons';
import Icon from '@mdi/react';
import { mdiHistory, mdiTableOfContents } from '@mdi/js';
import { TextField } from '../core/TextField';
import type { Node } from '@/types/api';
import { parseAST } from '@/lib/astBuilder';
import { isHeadingBlock } from '@/types/ast';
import { useQueryClient } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { useNotifications } from '@/stores/notificationStore';
import { Bullet } from '../blocks/Bullet';
import './SidebarContextSections.css';

interface TocEntry {
  id: number;
  text: string;
  level: number;
}

function extractHeadings(nodes: Node[], depth: number = 0): TocEntry[] {
  const result: TocEntry[] = [];
  for (const node of nodes) {
    const ast = parseAST(node.name);
    if (ast.length > 0 && isHeadingBlock(ast[0])) {
      result.push({
        id: node.id,
        text: nodeNameToText(node.name, 100) || 'Untitled',
        level: Math.min(depth + 1, 6),
      });
    }
    if (node.children?.length) {
      result.push(...extractHeadings(node.children, depth + 1));
    }
  }
  return result;
}

function CommentsList({ comments }: { comments: Node[] }) {
  const openNode = useAppStore(s => s.openNode);

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
  const openNode = useAppStore(state => state.openNode);
  
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [versionsExpanded, setVersionsExpanded] = useState(false);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [versions, setVersions] = useState<NodeVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const queryClient = useQueryClient();
  const { success: notifySuccess, error: notifyError } = useNotifications();
  
  const { data: commentsData, isLoading: commentsLoading } = useComments(
    mainViewType === 'node' ? currentNodeId : null
  );
  const { data: activityData, isLoading: activityLoading } = useNodeActivity(
    mainViewType === 'node' ? currentNodeId : null
  );
  
  // TOC: extract headings from node tree (reuses cached query from NodeView)
  const { data: nodeData } = useNode(
    mainViewType === 'node' ? currentNodeId : null,
    { include_children: true }
  );
  const tocEntries = useMemo(() => {
    if (!nodeData?.children) return [];
    return extractHeadings(nodeData.children);
  }, [nodeData]);
  
  const handleTocClick = useCallback((blockId: number) => {
    const el = document.querySelector(`[data-block-id="${blockId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight
      el.classList.add('node-block--toc-highlight');
      setTimeout(() => el.classList.remove('node-block--toc-highlight'), 1500);
    }
  }, []);
  
  const commentCount = useMemo(() => {
    return commentsData?.comments?.length ?? 0;
  }, [commentsData]);
  
  const activityCount = activityData?.length ?? 0;
  const showActivity = activityCount > 0 || activityLoading;
  
  // Fetch versions when section is expanded
  useEffect(() => {
    if (versionsExpanded && currentNodeId) {
      setVersionsLoading(true);
      getNodeVersions(currentNodeId, 30)
        .then(setVersions)
        .catch(() => setVersions([]))
        .finally(() => setVersionsLoading(false));
    }
  }, [versionsExpanded, currentNodeId]);
  
  const handleRestore = useCallback(async (versionId: number) => {
    if (!currentNodeId) return;
    try {
      await restoreNodeVersion(currentNodeId, versionId);
      queryClient.invalidateQueries({ queryKey: nodeKeys.detailBase(currentNodeId) });
      notifySuccess('Version restored', 'The node content has been restored.');
      // Refresh versions list
      getNodeVersions(currentNodeId, 30).then(setVersions).catch(() => {});
    } catch {
      notifyError('Failed to restore', 'Could not restore this version.');
    }
  }, [currentNodeId, queryClient, notifySuccess, notifyError]);
  
  if (mainViewType !== 'node' || !currentNodeId) return null;
  
  // Always show comments section; only show activity if it has content
  if (!showActivity && commentCount === 0 && !commentsLoading) {
    // Show just the comments section with empty state
  }
  
  return (
    <div className="sidebar-context-sections">
      {/* Table of Contents — only shown when headings exist */}
      {tocEntries.length > 0 && (
        <NodeViewSection
          title="Table of Contents"
          icon={<Icon path={mdiTableOfContents} size={0.6} />}
          count={tocEntries.length}
          className="sidebar-context-section sidebar-context-section--toc"
          defaultExpanded={false}
        >
          <nav className="sidebar-toc-list">
            {tocEntries.map((entry) => (
              <div
                key={entry.id}
                className="sidebar-toc-item"
                style={{ paddingLeft: `${(entry.level - 1) * 12}px` }}
              >
                <Bullet
                  nodeId={entry.id}
                  interactive
                  size="sm"
                  onClick={() => openNode(entry.id)}
                />
                <span
                  className="sidebar-toc-item__text"
                  onClick={() => handleTocClick(entry.id)}
                  title={entry.text}
                >
                  {entry.text}
                </span>
              </div>
            ))}
          </nav>
        </NodeViewSection>
      )}
      
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
      
      {/* Version History Section */}
      <NodeViewSection
        title="Version History"
        icon={<Icon path={mdiHistory} size={0.6} />}
        count={versionsExpanded ? versions.length : undefined}
        expanded={versionsExpanded}
        onExpandedChange={setVersionsExpanded}
        className="sidebar-context-section sidebar-context-section--versions"
        hideWhenEmpty={false}
      >
        {versionsLoading ? (
          <div className="sidebar-section-loading">Loading...</div>
        ) : versions.length === 0 ? (
          <div className="sidebar-section-empty">No version history yet</div>
        ) : (
          <div className="sidebar-versions-list">
            {versions.map((v) => (
              <div key={v.id} className="sidebar-version-item">
                <div className="sidebar-version-item__info">
                  <span className="sidebar-version-item__date">
                    {v.created_at ? formatDate(new Date(v.created_at), useSettingsStore.getState().dateFormat) : ''}
                  </span>
                </div>
                <div className="sidebar-version-item__preview">
                  {nodeNameToText(v.name, 80) || 'Empty'}
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => handleRestore(v.id)}
                  title="Restore this version"
                  className="sidebar-version-item__restore"
                >
                  Restore
                </Button>
              </div>
            ))}
          </div>
        )}
      </NodeViewSection>
    </div>
  );
}

export default SidebarContextSections;
