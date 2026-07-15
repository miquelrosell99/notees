import { useEffect, useRef, useState } from 'react';
import { useViewportFlip } from '@/hooks/useViewportFlip';
import { useNavigationStore } from '@/stores';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { useTasksPopupData } from '@/features/tasks/hooks/useTasksPopupData';
import { useSetTaskStatus } from '@/features/tasks/hooks/useSetTaskStatus';
import { useQuickAddTask } from '@/features/tasks/hooks/useQuickAddTask';
import { TasksPopupSection } from './TasksPopupSection';
import type { Node } from '@/types/api';
import './TasksPopup.css';

export interface TasksPopupProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function TasksPopup({ isOpen, onClose, anchorRef }: TasksPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [quickAddValue, setQuickAddValue] = useState('');
  const { sections, isLoading, isError, refetch } = useTasksPopupData();
  const setTaskStatus = useSetTaskStatus();
  const { quickAdd, isAdding } = useQuickAddTask();
  const openNode = useNavigationStore((s) => s.openNode);

  const position = useViewportFlip(
    anchorRef as React.RefObject<HTMLElement>,
    isOpen,
    // 420 is the max height estimate (CSS caps at min(420px, 70dvh)); the hook measures the rendered popup, so the value itself is ignored.
    { popupRef, popupHeight: 420, fixed: true },
  );

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        popupRef.current &&
        !popupRef.current.contains(e.target as globalThis.Node) &&
        anchorRef?.current &&
        !anchorRef.current.contains(e.target as globalThis.Node)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorRef]);

  // Close on Escape (CalendarPopup lacks this; the tasks popup adds it)
  useEffect(() => {
    if (!isOpen) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleToggle = (node: Node, completed: boolean) => {
    setTaskStatus(node.uuid, completed ? 'Pending' : 'Done');
  };

  const handleOpen = (node: Node) => {
    openNode(node.uuid);
    onClose();
  };

  const handleOpenTaskClass = () => {
    openNode(SYSTEM_CLASS_UUIDS.task);
    onClose();
  };

  const handleQuickAddKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isAdding) return;
    const value = quickAddValue;
    if (!value.trim()) return;
    setQuickAddValue('');
    void quickAdd(value).catch(() => {
      setQuickAddValue(value); // restore on failure
    });
  };

  const isEmpty =
    !isLoading &&
    !isError &&
    sections.overdue.nodes.length === 0 &&
    sections.today.nodes.length === 0 &&
    sections.upcoming.nodes.length === 0 &&
    sections.unscheduled.nodes.length === 0 &&
    sections.completed.nodes.length === 0;

  return (
    <div
      className="tasks-popup"
      ref={popupRef}
      role="dialog"
      aria-label="Tasks"
      style={position ? {
        position: 'fixed',
        top: position.top,
        left: position.left,
      } : { position: 'fixed', visibility: 'hidden' }}
    >
      <div className="tasks-popup__quick-add">
        <input
          type="text"
          placeholder="Add a task"
          aria-label="Add a task"
          value={quickAddValue}
          disabled={isAdding}
          onChange={(e) => setQuickAddValue(e.target.value)}
          onKeyDown={handleQuickAddKeyDown}
        />
      </div>

      <div className="tasks-popup__body">
        {isLoading && <div className="tasks-popup__state">Loading tasks…</div>}
        {isError && (
          <div className="tasks-popup__state tasks-popup__state--error">
            Failed to load tasks.{' '}
            <button type="button" onClick={refetch}>Retry</button>
          </div>
        )}
        {isEmpty && <div className="tasks-popup__state">No tasks due. Enjoy the calm.</div>}

        <TasksPopupSection
          title="Overdue"
          tone="danger"
          nodes={sections.overdue.nodes}
          totalCount={sections.overdue.totalCount}
          showDates
          onToggle={handleToggle}
          onOpen={handleOpen}
        />
        <TasksPopupSection
          title="Today"
          nodes={sections.today.nodes}
          totalCount={sections.today.totalCount}
          onToggle={handleToggle}
          onOpen={handleOpen}
        />
        <TasksPopupSection
          title="Upcoming"
          nodes={sections.upcoming.nodes}
          totalCount={sections.upcoming.totalCount}
          showDates
          onToggle={handleToggle}
          onOpen={handleOpen}
        />
        <TasksPopupSection
          title="No date"
          nodes={sections.unscheduled.nodes}
          totalCount={sections.unscheduled.totalCount}
          onHeaderClick={handleOpenTaskClass}
          onToggle={handleToggle}
          onOpen={handleOpen}
        />
        <TasksPopupSection
          title="Completed today"
          tone="muted"
          nodes={sections.completed.nodes}
          totalCount={sections.completed.totalCount}
          completed
          onToggle={handleToggle}
          onOpen={handleOpen}
        />
      </div>
    </div>
  );
}
