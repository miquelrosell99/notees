/**
 * Template Gallery
 *
 * Browse, instantiate, and manage workspace templates.
 */
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { PageViewHeader, NodeCollection, NodeCollectionToolbar } from '@/features/content';
import { DataStateView } from '@/components/ui/DataStateView';
import { useNavigationStore } from '@/stores';
import { useTemplates, useTemplateVariables, useInstantiateTemplate } from '@/features/content';
import { useClasses } from '@/features/content/hooks/useNodeQueries';
import { createNode } from '@/api/nodes';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { TemplateVariableDialog } from '../components/TemplateVariableDialog';
import { useAuthStore } from '@/features/auth/stores/authStore';
import { queryClient } from '@/lib/queryClient';
import { nodeKeys, templateKeys } from '@/hooks/queryKeys';
import type { Node } from '@/types';
import type { NodeCollectionViewMode } from '@/types/nodeCollection';
import type { ContextMenuItem } from '@/components/ui/ContextMenu';
import './TemplateGallery.css';

export function TemplateGallery() {
  const openNode = useNavigationStore((state) => state.openNode);
  const currentUser = useAuthStore((state) => state.user);
  const { data: allClasses } = useClasses();
  const { data: templatesResponse, isLoading, error, refetch } = useTemplates();
  const instantiate = useInstantiateTemplate();

  const [viewMode, setViewMode] = useState<NodeCollectionViewMode>('list');
  const [pendingTemplate, setPendingTemplate] = useState<Node | null>(null);
  const { data: variablesData } = useTemplateVariables(pendingTemplate?.id ?? null);

  const templateClassId = useMemo(() => {
    if (!allClasses) return null;
    const uuid = SYSTEM_CLASS_UUIDS.template;
    return allClasses.find(c => c.uuid === uuid)?.id ?? null;
  }, [allClasses]);

  const templates = templatesResponse?.items ?? [];

  const handleCreateTemplate = useCallback(async () => {
    if (templateClassId == null) return;
    try {
      const newTemplate = await createNode({
        name: 'New template',
        classes: [templateClassId],
      });
      openNode(newTemplate.id);
      queryClient.invalidateQueries({ queryKey: templateKeys.list() });
    } catch (e) {
      console.error('[TemplateGallery] failed to create template', e);
    }
  }, [templateClassId, openNode]);

  const handleInstantiate = useCallback((template: Node) => {
    setPendingTemplate(template);
  }, []);

  const contextMenuItems = useCallback((template: Node, closeMenu: () => void): ContextMenuItem[] => {
    return [
      {
        id: 'use',
        label: 'Use template',
        icon: 'mdi mdi-content-copy',
        onClick: () => {
          handleInstantiate(template);
          closeMenu();
        },
      },
      {
        id: 'open',
        label: 'Open',
        icon: 'mdi mdi-arrow-right',
        onClick: () => {
          openNode(template.id);
          closeMenu();
        },
      },
    ];
  }, [handleInstantiate, openNode]);

  return (
    <article className="node-view node-view--page template-gallery">
      <PageViewHeader
        className="template-gallery__header"
        title={<h1>Templates</h1>}
        actions={
          <Button variant="primary" size="sm" onClick={handleCreateTemplate} disabled={templateClassId == null}>
            New template
          </Button>
        }
      />

      <div className="template-gallery__content">
        <div className="template-gallery__toolbar">
          <NodeCollectionToolbar
            viewMode={viewMode}
            availableViewModes={['list', 'table', 'kanban']}
            onViewModeChange={setViewMode}
            groupBy="none"
            onGroupByChange={() => {}}
          />
        </div>

        <DataStateView
          isLoading={isLoading}
          error={error}
          isEmpty={templates.length === 0}
          onRetry={refetch}
          errorTitle="Failed to load templates"
          emptyTitle="No templates"
          emptyDescription="Create a template page to reuse structure across your workspace."
          skeletonRows={4}
        >
          <NodeCollection
            nodes={templates}
            viewMode={viewMode}
            editable={false}
            showClasses={true}
            hideToolbar={true}
            onNodeClick={(node) => openNode(node.id)}
            customContextMenuItems={contextMenuItems}
          />
        </DataStateView>
      </div>

      {pendingTemplate && (
        <TemplateVariableDialog
          isOpen
          templateName={pendingTemplate.name}
          variables={variablesData?.variables ?? []}
          dynamicVariables={variablesData?.dynamic_variables ?? []}
          context={{
            currentPageName: null,
            currentPageUuid: null,
            currentUserName: currentUser?.name ?? null,
          }}
          onCancel={() => setPendingTemplate(null)}
          onConfirm={(variables, dynamicContext) => {
            instantiate.mutate(
              {
                nodeId: pendingTemplate.id,
                options: {
                  variables,
                  dynamic_context: dynamicContext,
                },
              },
              {
                onSuccess: () => {
                  queryClient.invalidateQueries({ queryKey: nodeKeys.all });
                  setPendingTemplate(null);
                },
              }
            );
          }}
        />
      )}
    </article>
  );
}

export default TemplateGallery;
