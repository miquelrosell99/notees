import { Bullet } from '@/components/blocks/Bullet';
import { NodeViewSection } from '@/components/nodes/NodeViewSection';
import { Icon } from '@/components/core/icons';
import { useNavigationStore } from '@/stores';

interface TocEntry {
  id: number;
  text: string;
  level: number;
}

interface SidebarTocProps {
  entries: TocEntry[];
  onTocClick: (blockId: number) => void;
}

export function SidebarToc({ entries, onTocClick }: SidebarTocProps) {
  const openNode = useNavigationStore(s => s.openNode);

  if (entries.length === 0) return null;

  return (
    <NodeViewSection
      title="Table of Contents"
      icon={<Icon path={"mdi mdi-table-of-contents"} size={0.6} />}
      count={entries.length}
      className="sidebar-context-section sidebar-context-section--toc"
      defaultExpanded={false}
    >
      <nav className="sidebar-toc-list">
        {entries.map((entry) => (
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
            <span role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }}
              className="sidebar-toc-item__text"
              onClick={() => onTocClick(entry.id)}
              title={entry.text}
            >
              {entry.text}
            </span>
          </div>
        ))}
      </nav>
    </NodeViewSection>
  );
}
