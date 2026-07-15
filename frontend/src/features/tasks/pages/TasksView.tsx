/**
 * Tasks View - dedicated view for managing tasks across three tabs:
 *   All, Today/Overdue, Future
 *
 * Uses QueryAST with backend DATE support to filter tasks by scheduled
 * and deadline properties. All tabs exclude completed tasks (Done/Cancelled).
 */
import { useState, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NodeCollection, PageViewHeader } from '@/features/content';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { DataStateView } from '@/components/ui/DataStateView';
import { useNavigationStore } from '@/stores';
import { useSystemClasses } from '@/features/content';
import { useCreateNode } from '@/features/content';
import { useTasks } from '@/features/tasks';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import type { Node } from '@/types';
import { taskKeys } from '@/hooks/queryKeys';

import './TasksView.css';

type TaskTab = 'all' | 'today' | 'future';

interface TabDef {
  key: TaskTab;
  label: string;
  icon: string;
}

const TABS: TabDef[] = [
  { key: 'all', label: 'All', icon: 'mdi mdi-format-list-checkbox' },
  { key: 'today', label: 'Today / Overdue', icon: 'mdi mdi-calendar-clock' },
  { key: 'future', label: 'Future', icon: 'mdi mdi-calendar-arrow-right' },
];

export function TasksView() {
  const [activeTab, setActiveTab] = useState<TaskTab>('all');
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  const openNode = useNavigationStore((state) => state.openNode);
  const queryClient = useQueryClient();
  const { systemClassUuids, isLoading: classesLoading } = useSystemClasses();
  const pageClassUuid = systemClassUuids?.page ?? null;
  const taskClassUuid = systemClassUuids?.task ?? null;
  const createNode = useCreateNode();

  const {
    data: tasks = [],
    isLoading: tasksLoading,
    error,
  } = useTasks(activeTab, { enabled: !classesLoading });

  const handleCreateTask = useCallback(async () => {
    if (!pageClassUuid || !taskClassUuid) return;

    const classUuids = [pageClassUuid];
    if (!classUuids.includes(taskClassUuid)) {
      classUuids.push(taskClassUuid);
    }

    const newNode = await createNode.mutateAsync({
      name: 'New Task',
      class_uuids: classUuids,
    });

    // Invalidate all task-view caches so the new task appears
    queryClient.invalidateQueries({ queryKey: taskKeys.view() });

    openNode(newNode.uuid);
  }, [pageClassUuid, taskClassUuid, createNode, queryClient, openNode]);

  const handleNodeClick = useCallback(
    (node: Node) => {
      openNode(node.uuid);
    },
    [openNode],
  );

  const handleNodeShiftClick = useCallback(
    (node: Node) => {
      useNavigationStore.getState().addSidebarCard(node.uuid, 'page');
    },
    [],
  );

  const isLoading = classesLoading || tasksLoading;

  const emptyMessage = useMemo(() => {
    switch (activeTab) {
      case 'all':
        return 'No active tasks yet';
      case 'today':
        return 'No tasks for today or overdue';
      case 'future':
        return 'No upcoming scheduled tasks';
    }
  }, [activeTab]);

  return (
    <article className="tasks-view">
      <PageViewHeader
        className="tasks-view__header"
        title={<h1>Tasks</h1>}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon="mdi mdi-plus"
            onClick={handleCreateTask}
            disabled={!taskClassUuid || createNode.isPending}
            title="New task"
          >
            New task
          </Button>
        }
      />

      {/* Tabs */}
      <div className="tasks-view__tabs">
        <Tabs value={activeTab} onChange={setActiveTab}>
          <Tabs.List>
            {TABS.map((tab) => (
              <Tabs.Tab key={tab.key} value={tab.key} icon={tab.icon}>
                {tab.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
      </div>

      {/* Content */}
      <div className="tasks-view__content">
        <DataStateView
          isLoading={isLoading}
          error={error}
          isEmpty={tasks.length === 0}
          errorTitle="Failed to load tasks."
          emptyTitle={emptyMessage}
          skeletonRows={4}
        >
          <NodeCollection
            nodes={tasks}
            viewMode={viewMode}
            availableViewModes={['list', 'kanban', 'table']}
            onViewModeChange={setViewMode}
            onNodeClick={handleNodeClick}
            onNodeShiftClick={handleNodeShiftClick}
            editable={false}
            showClasses={true}
            showGroupBy
            showAddButton
            onAdd={handleCreateTask}
            can_create={!!taskClassUuid}
            emptyMessage={emptyMessage}
          />
        </DataStateView>
      </div>
    </article>
  );
}

export default TasksView;
