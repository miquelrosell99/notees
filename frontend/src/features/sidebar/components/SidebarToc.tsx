import type { CSSProperties } from 'react';
import { Bullet, NodeViewSection } from '@/features/content';
import { Icon } from '@/components/ui/icons';
import { useNavigationStore } from '@/stores';
import './SidebarToc.css';

interface TocEntry {
  nodeUuid: string;
  uuid: string;
  text: string;
  level: number;
}

interface SidebarTocProps {
  entries: TocEntry[];
  onTocClick: (blockId: string) => void;
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
      variant="sidebar"
      defaultExpanded={false}
    >
      <nav className="sidebar-toc-list">
        {entries.map((entry) => (
          <div
            key={entry.nodeUuid}
            className="sidebar-toc-item"
            style={{ '--toc-level': entry.level - 1 } as CSSProperties}
          >
            <Bullet
              nodeUuid={entry.nodeUuid}
              interactive
              size="sm"
              onClick={() => openNode(entry.uuid)}
            />
            <button
              type="button"
              className="sidebar-toc-item__text"
              onClick={() => onTocClick(entry.nodeUuid)}
              title={entry.text}
            >
              {entry.text}
            </button>
          </div>
        ))}
      </nav>
    </NodeViewSection>
  );
}
