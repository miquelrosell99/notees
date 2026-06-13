/**
 * Tasks View - dedicated view for managing tasks across three tabs:
 *   All, Today/Overdue, Future
 *
 * Uses QueryAST with backend DATE support to filter tasks by scheduled
 * and deadline properties. All tabs exclude completed tasks (Done/Cancelled).
 */
import { useState, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/ui/Icon';
import { NodeCollection } from '@/features/content';
import { Button } from '@/components/ui/Button';
import { DataStateView } from '@/components/ui/DataStateView';
import { useNavigationStore } from '@/stores';
import { useSystemClasses } from '@/hooks/usePageClass';
import { useCreateNode } from '@/hooks/useNodes';
import { useQuery_ } from '@/hooks/useNodeViews';

import {
  buildTasksQueryAST,
  buildTodayOverdueQueryAST,
  buildFutureQueryAST,
} from '@/utils/taskQueries';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import type { Node } from '@/types';
import type { QueryExecuteRequest } from '@/types/nodeView';
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

function getQueryForTab(tab: TaskTab): QueryExecuteRequest {
  switch (tab) {
    case 'all':
      return { query_ast: buildTasksQueryAST() };
    case 'today':
      return { query_ast: buildTodayOverdueQueryAST() };
    case 'future':
      return { query_ast: buildFutureQueryAST() };
  }
}

export function TasksView() {
  const [activeTab, setActiveTab] = useState<TaskTab>('all');
  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  const { openNode } = useNavigationStore();
  const queryClient = useQueryClient();
  const { systemClassIds, isLoading: classesLoading } = useSystemClasses();
  const pageClassId = systemClassIds?.page ?? null;
  const taskClassId = systemClassIds?.task ?? null;
  const createNode = useCreateNode();

  const queryRequest = useMemo(() => getQueryForTab(activeTab), [activeTab]);

  const {
    data: tasks = [],
    isLoading: tasksLoading,
    error,
  } = useQuery_(queryRequest, {
    enabled: !classesLoading,
    queryKey: ['tasks-view', activeTab],
  });

  const handleCreateTask = useCallback(async () => {
    if (!pageClassId || !taskClassId) return;

    const classes = [pageClassId];
    if (!classes.includes(taskClassId)) {
      classes.push(taskClassId);
    }

    const newNode = await createNode.mutateAsync({
      name: 'New Task',
      classes,
    });

    // Invalidate all task-view caches so the new task appears
    queryClient.invalidateQueries({ queryKey: ['tasks-view'] });

    openNode(newNode.id);
  }, [pageClassId, taskClassId, createNode, queryClient, openNode]);

  const handleNodeClick = useCallback(
    (node: Node) => {
      openNode(node.id);
    },
    [openNode],
  );

  const handleNodeShiftClick = useCallback(
    (node: Node) => {
      useNavigationStore.getState().addSidebarCard(node.id, 'page');
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
      {/* Header */}
      <div className="page-header-section">
        <div className="page-header-section__header">
          <div className="page-header tasks-view__header">
            <h1 className="page-header__title">Tasks</h1>
            <Button
              variant="primary"
              size="sm"
              icon="mdi mdi-plus"
              onClick={handleCreateTask}
              disabled={!taskClassId || createNode.isPending}
              title="New task"
            >
              New task
            </Button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tasks-view__tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`tasks-view__tab ${activeTab === tab.key ? 'tasks-view__tab--active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
            type="button"
          >
            <Icon path={tab.icon} />
            <span>{tab.label}</span>
          </button>
        ))}
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
            showAddButton
            onAdd={handleCreateTask}
            can_create={!!taskClassId}
            emptyMessage={emptyMessage}
          />
        </DataStateView>
      </div>
    </article>
  );
}

export default TasksView;
