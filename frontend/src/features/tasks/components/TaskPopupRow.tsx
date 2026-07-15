import { Icon } from '@/components/ui';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { dayUuidToDate } from '@/utils/dateUuid';
import { getTaskDateUuid } from '@/features/tasks/hooks/useTasksPopupData';
import { parseAST } from '@/lib/astBuilder';
import { stringifyAST, StringifyMode } from '@/lib/stringifyAST';
import type { Node } from '@/types/api';

interface TaskPopupRowProps {
  node: Node;
  completed?: boolean;
  showDate?: boolean;
  onToggle: (node: Node, completed: boolean) => void;
  onOpen: (node: Node) => void;
}

function plainName(node: Node): string {
  try {
    return stringifyAST(parseAST(node.name ?? ''), { mode: StringifyMode.TEXT_ONLY });
  } catch {
    return node.name ?? '';
  }
}

function shortDateLabel(dayUuid: string): string | null {
  const date = dayUuidToDate(dayUuid);
  if (!date) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TaskPopupRow({ node, completed = false, showDate = false, onToggle, onOpen }: TaskPopupRowProps) {
  const name = plainName(node);
  const dateUuid = showDate ? getTaskDateUuid(node) : null;
  const dateLabel = dateUuid ? shortDateLabel(dateUuid) : null;
  const prefersReducedMotion = useReducedMotion();

  const handleToggle = () => {
    // Light haptic on toggle — skip when the user prefers reduced motion
    // (same gating as the shared Button component).
    if (!prefersReducedMotion && typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(10);
    }
    onToggle(node, completed);
  };

  return (
    <li className={`tasks-popup__row${completed ? ' tasks-popup__row--completed' : ''}`}>
      <button
        type="button"
        className="tasks-popup__circle"
        aria-label={completed ? `Mark "${name}" as not done` : `Mark "${name}" as done`}
        aria-pressed={completed}
        onClick={handleToggle}
      >
        <Icon
          path={completed ? 'mdi mdi-checkbox-marked-circle' : 'mdi mdi-checkbox-blank-circle-outline'}
          size={0.9}
        />
      </button>
      <button type="button" className="tasks-popup__title" onClick={() => onOpen(node)}>
        <span className="tasks-popup__name">{name}</span>
        <span className="tasks-popup__meta">
          {dateLabel && <span className="tasks-popup__date">{dateLabel}</span>}
          {node.page_name && <span className="tasks-popup__page">{node.page_name}</span>}
        </span>
      </button>
    </li>
  );
}
