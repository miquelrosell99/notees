import type { Node } from '@/types/api';
import { TaskPopupRow } from './TaskPopupRow';

interface TasksPopupSectionProps {
  title: string;
  tone?: 'default' | 'danger' | 'muted';
  nodes: Node[];
  totalCount: number;
  completed?: boolean;
  showDates?: boolean;
  onHeaderClick?: () => void;
  onToggle: (node: Node, completed: boolean) => void;
  onOpen: (node: Node) => void;
}

export function TasksPopupSection({
  title,
  tone = 'default',
  nodes,
  totalCount,
  completed = false,
  showDates = false,
  onHeaderClick,
  onToggle,
  onOpen,
}: TasksPopupSectionProps) {
  if (nodes.length === 0) return null;
  return (
    <section className="tasks-popup__section" aria-label={title}>
      <header className={`tasks-popup__section-title tasks-popup__section-title--${tone}`}>
        {onHeaderClick ? (
          <button type="button" className="tasks-popup__section-link" onClick={onHeaderClick}>
            {title}
          </button>
        ) : (
          <span>{title}</span>
        )}
        <span className="tasks-popup__count">
          {totalCount > nodes.length ? `${nodes.length} of ${totalCount}` : totalCount}
        </span>
      </header>
      <ul className="tasks-popup__list">
        {nodes.map((node) => (
          <TaskPopupRow
            key={node.uuid}
            node={node}
            completed={completed}
            showDate={showDates}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}
