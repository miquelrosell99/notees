/**
 * LibraryPage — top-level Library view (notees.library plugin).
 *
 * Sections: All Sources, per-subclass sections (Books, Papers, Articles,
 * Theses, Documents, Movies) and Authors (class:agent). Source lists are
 * driven by a `class:source` query AST (hierarchy-aware by construction) and
 * support table/card view modes and flat/Work→Edition grouping.
 */
import { useMemo, useState, useCallback } from 'react';
import { PageViewHeader } from '@/features/content/components/nodes/PageViewHeader';
import { DataStateView } from '@/components/ui/DataStateView';
import { Button } from '@/components/ui/Button';
import { useNavigationStore } from '@/stores';
import { useClasses } from '@/features/content/hooks/useNodeQueries';
import { useQuery_ } from '@/features/content/hooks/useNodeViews.queries';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import type { Node } from '@/types';
import {
  buildLibraryQueryAst,
  filterNodesBySection,
  getLibrarySection,
  groupSourcesIntoWorks,
  LIBRARY_SECTIONS,
  type LibraryGrouping,
  type LibraryViewMode,
} from './libraryUtils';
import { LibraryTable } from './components/LibraryTable';
import { LibraryCardGrid } from './components/LibraryCardGrid';
import './LibraryPage.css';

export function LibraryPage() {
  const openNode = useNavigationStore((state) => state.openNode);

  const [sectionId, setSectionId] = useState<string>('all');
  const [viewMode, setViewMode] = useState<LibraryViewMode>('table');
  const [grouping, setGrouping] = useState<LibraryGrouping>('flat');

  const section = getLibrarySection(sectionId);
  const isAuthorsSection = section.className === 'agent';

  // Two hierarchy-aware class queries back every section: sources and agents.
  const sourcesAst = useMemo(
    () => buildLibraryQueryAst(SYSTEM_CLASS_UUIDS.source, 'sources'),
    [],
  );
  const agentsAst = useMemo(() => buildLibraryQueryAst(SYSTEM_CLASS_UUIDS.agent, 'agents'), []);

  const { data: sources = [], isLoading: sourcesLoading } = useQuery_(
    { query_ast: sourcesAst },
    { enabled: !isAuthorsSection },
  );
  const { data: agents = [], isLoading: agentsLoading } = useQuery_(
    { query_ast: agentsAst },
    { enabled: true },
  );

  const { data: classes = [] } = useClasses();

  const agentsByUuid = useMemo(
    () => new Map<string, Node>(agents.map((agent) => [agent.uuid, agent])),
    [agents],
  );
  // Unfiltered source map so edition covers can fall back to parent.cover even
  // when the parent is outside the active section filter.
  const allSourcesByUuid = useMemo(
    () => new Map<string, Node>(sources.map((source) => [source.uuid, source])),
    [sources],
  );
  const classNamesByUuid = useMemo(
    () =>
      new Map<string, string>(
        classes.map((cls) => [cls.uuid, cls.name?.toLowerCase?.() ?? cls.name ?? '']),
      ),
    [classes],
  );

  const sectionClassUuid = SYSTEM_CLASS_UUIDS[section.className];
  const sectionNodes = useMemo(() => {
    const base = isAuthorsSection ? agents : sources;
    return filterNodesBySection(base, sectionClassUuid, classes);
  }, [isAuthorsSection, agents, sources, sectionClassUuid, classes]);

  const groups = useMemo(
    () => (grouping === 'grouped' && !isAuthorsSection ? groupSourcesIntoWorks(sectionNodes) : []),
    [grouping, isAuthorsSection, sectionNodes],
  );

  const handleOpenNode = useCallback(
    (nodeUuid: string) => {
      openNode(nodeUuid);
    },
    [openNode],
  );

  const isLoading = isAuthorsSection ? agentsLoading : sourcesLoading;

  return (
    <article className="node-view node-view--page library-view">
      <PageViewHeader
        className="library-view__header"
        title={<h1>Library</h1>}
        actions={
          <>
            <div className="library-view__toggle-group" role="group" aria-label="View mode">
              <Button
                variant="ghost"
                size="sm"
                icon="mdi mdi-table"
                active={viewMode === 'table'}
                onClick={() => setViewMode('table')}
                aria-label="Table view"
                title="Table view"
              />
              <Button
                variant="ghost"
                size="sm"
                icon="mdi mdi-view-grid-outline"
                active={viewMode === 'cards'}
                onClick={() => setViewMode('cards')}
                aria-label="Card view"
                title="Card view"
              />
            </div>
            {!isAuthorsSection && (
              <div className="library-view__toggle-group" role="group" aria-label="Grouping">
                <Button
                  variant="ghost"
                  size="sm"
                  icon="mdi mdi-format-list-bulleted"
                  active={grouping === 'flat'}
                  onClick={() => setGrouping('flat')}
                  aria-label="Flat list"
                  title="Flat list — every source its own row"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon="mdi mdi-file-tree-outline"
                  active={grouping === 'grouped'}
                  onClick={() => setGrouping('grouped')}
                  aria-label="Group by work"
                  title="Group by work — editions collapsed beneath their work"
                />
              </div>
            )}
          </>
        }
      />

      <div className="library-view__sections" role="tablist" aria-label="Library sections">
        {LIBRARY_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === sectionId}
            className={`library-view__section-tab${s.id === sectionId ? ' library-view__section-tab--active' : ''}`}
            onClick={() => setSectionId(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="library-view__content">
        <DataStateView
          isLoading={isLoading}
          isEmpty={sectionNodes.length === 0}
          emptyTitle={isAuthorsSection ? 'No authors yet' : 'No sources yet'}
          emptyDescription={
            isAuthorsSection
              ? 'Agents (persons, organizations) referenced by sources appear here.'
              : 'Class a page or block as a source (book, paper, ...) and it appears here.'
          }
          skeletonRows={4}
        >
          {viewMode === 'table' ? (
            <LibraryTable
              rows={sectionNodes}
              groups={groups}
              grouped={grouping === 'grouped' && !isAuthorsSection}
              classNamesByUuid={classNamesByUuid}
              agentsByUuid={agentsByUuid}
              onOpenNode={handleOpenNode}
            />
          ) : (
            <LibraryCardGrid
              rows={sectionNodes}
              groups={groups}
              grouped={grouping === 'grouped' && !isAuthorsSection}
              allSourcesByUuid={allSourcesByUuid}
              agentsByUuid={agentsByUuid}
              onOpenNode={handleOpenNode}
            />
          )}
        </DataStateView>
      </div>
    </article>
  );
}

export default LibraryPage;
