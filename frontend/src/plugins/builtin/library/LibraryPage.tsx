/**
 * LibraryPage — three-pane Library view (notees.library plugin, Task 11).
 *
 * Left pane: collection tree ("All sources" pseudo-root + nested collections,
 * expandable). Center pane: sources of the selected collection — nested under
 * it recursively (subcollections included) ∪ linking to it, deduped,
 * intersected with class:source (Decision 22, via `collectionContents`) — or,
 * with "All sources" selected, the Task 7 sections (per subclass, authors)
 * with flat/Work→Edition grouping. Right pane: metadata inspector for the
 * selected source (class-bound property panel; edits persist via normal
 * property ops). Selection never navigates; opening a node is explicit.
 * Drag-and-drop (Task 12): dropping a file on a source row/card attaches it
 * (upload + asset node + `attachments` entry); dragging a source row/card
 * onto a collection in the tree nests it there (node.move). Header action
 * "Add by identifier" (Task 13) opens the ISBN/DOI lookup dialog; confirm
 * creates the source backend-side, then selects and opens it.
 */
import { useMemo, useState, useCallback } from 'react';
import { PageViewHeader } from '@/features/content/components/nodes/PageViewHeader';
import { DataStateView } from '@/components/ui/DataStateView';
import { Button } from '@/components/ui/Button';
import { useNavigationStore } from '@/stores';
import { useClasses } from '@/features/content/hooks/useNodeQueries';
import { useQuery_ } from '@/features/content/hooks/useNodeViews.queries';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import {
  buildCollectionLinkedQueryAst,
  buildCollectionNestedQueryAst,
  computeCollectionContents,
} from '@/features/content/utils/collectionContents';
import type { Node } from '@/types';
import {
  buildLibraryQueryAst,
  filterNodesBySection,
  getLibrarySection,
  groupSourcesIntoWorks,
  libraryNodeName,
  LIBRARY_SECTIONS,
  type LibraryGrouping,
  type LibraryViewMode,
} from './libraryUtils';
import {
  ALL_SOURCES_SELECTION,
  buildCollectionTree,
  flattenCollectionTree,
  pruneSourceSelection,
  selectCollection,
  selectSource,
  toggleExpanded,
  type LibraryPaneSelection,
} from './collectionTree';
import { CollectionTreePane } from './components/CollectionTreePane';
import { LibraryInspector } from './components/LibraryInspector';
import { LibraryTable } from './components/LibraryTable';
import { LibraryCardGrid } from './components/LibraryCardGrid';
import { AddByIdentifierDialog } from './components/AddByIdentifierDialog';
import { useLibraryDnd } from './useLibraryDnd';
import './LibraryPage.css';

export function LibraryPage() {
  const openNode = useNavigationStore((state) => state.openNode);

  const [sectionId, setSectionId] = useState<string>('all');
  const [viewMode, setViewMode] = useState<LibraryViewMode>('table');
  const [grouping, setGrouping] = useState<LibraryGrouping>('flat');
  const [selection, setSelection] = useState<LibraryPaneSelection>(ALL_SOURCES_SELECTION);
  const [expandedCollections, setExpandedCollections] = useState<ReadonlySet<string>>(new Set());
  const [addByIdentifierOpen, setAddByIdentifierOpen] = useState(false);

  const isCollectionSelected = selection.collectionUuid !== null;
  const section = getLibrarySection(sectionId);
  const isAuthorsSection = !isCollectionSelected && section.className === 'agent';

  // Hierarchy-aware class queries back the view: sources, agents, collections.
  const sourcesAst = useMemo(
    () => buildLibraryQueryAst(SYSTEM_CLASS_UUIDS.source, 'sources'),
    [],
  );
  const agentsAst = useMemo(() => buildLibraryQueryAst(SYSTEM_CLASS_UUIDS.agent, 'agents'), []);
  const collectionsAst = useMemo(
    () => buildLibraryQueryAst(SYSTEM_CLASS_UUIDS.collection, 'collections'),
    [],
  );

  const { data: sources = [], isLoading: sourcesLoading } = useQuery_(
    { query_ast: sourcesAst },
    { enabled: !isAuthorsSection },
  );
  const { data: agents = [], isLoading: agentsLoading } = useQuery_(
    { query_ast: agentsAst },
    { enabled: true },
  );
  const { data: collectionCandidates = [] } = useQuery_(
    { query_ast: collectionsAst },
    { enabled: true },
  );

  // Collection contents (Decision 22): nested recursively ∪ linking, both
  // intersected with class:source, deduped. Only queried when a collection is
  // selected.
  const selectedCollectionUuid = selection.collectionUuid;
  const nestedAst = useMemo(
    () =>
      selectedCollectionUuid
        ? buildCollectionNestedQueryAst(selectedCollectionUuid, SYSTEM_CLASS_UUIDS.source)
        : undefined,
    [selectedCollectionUuid],
  );
  const linkedAst = useMemo(
    () =>
      selectedCollectionUuid
        ? buildCollectionLinkedQueryAst(selectedCollectionUuid, SYSTEM_CLASS_UUIDS.source)
        : undefined,
    [selectedCollectionUuid],
  );
  const { data: nestedSources, isLoading: nestedLoading } = useQuery_(
    { query_ast: nestedAst, include_properties: true },
    { enabled: !!nestedAst },
  );
  const { data: linkedSources, isLoading: linkedLoading } = useQuery_(
    { query_ast: linkedAst, include_properties: true },
    { enabled: !!linkedAst },
  );
  const collectionContents = useMemo(
    () => computeCollectionContents(nestedSources ?? [], linkedSources ?? []),
    [nestedSources, linkedSources],
  );

  const { data: classes = [] } = useClasses();

  const collectionTree = useMemo(
    () => buildCollectionTree(collectionCandidates, SYSTEM_CLASS_UUIDS.collection, classes),
    [collectionCandidates, classes],
  );
  const treeRows = useMemo(
    () => flattenCollectionTree(collectionTree, expandedCollections),
    [collectionTree, expandedCollections],
  );
  const selectedCollection = useMemo(
    () => collectionCandidates.find((node) => node.uuid === selectedCollectionUuid) ?? null,
    [collectionCandidates, selectedCollectionUuid],
  );

  const agentsByUuid = useMemo(
    () => new Map<string, Node>(agents.map((agent) => [agent.uuid, agent])),
    [agents],
  );
  // Unfiltered source map so edition covers can fall back to parent.cover even
  // when the parent is outside the active section/collection filter.
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

  // Center pane: collection contents when a collection is selected, the
  // active section otherwise.
  const centerNodes = isCollectionSelected ? collectionContents : sectionNodes;

  const groups = useMemo(
    () => (grouping === 'grouped' && !isAuthorsSection ? groupSourcesIntoWorks(centerNodes) : []),
    [grouping, isAuthorsSection, centerNodes],
  );

  // The inspector tracks the selection as long as the source stays visible.
  const visibleUuids = useMemo(
    () => new Set<string>(centerNodes.map((node) => node.uuid)),
    [centerNodes],
  );
  const inspectorUuid = pruneSourceSelection(selection, visibleUuids).sourceUuid;

  const handleOpenNode = useCallback(
    (nodeUuid: string) => {
      openNode(nodeUuid);
    },
    [openNode],
  );
  const handleSelectCollection = useCallback((collectionUuid: string | null) => {
    setSelection((prev) => selectCollection(prev, collectionUuid));
  }, []);
  const handleSelectSource = useCallback((sourceUuid: string) => {
    setSelection((prev) => selectSource(prev, sourceUuid));
  }, []);
  const handleCloseInspector = useCallback(() => {
    setSelection((prev) => ({ ...prev, sourceUuid: null }));
  }, []);
  const handleToggleExpand = useCallback((collectionUuid: string) => {
    setExpandedCollections((prev) => toggleExpanded(prev, collectionUuid));
  }, []);
  // Add-by-identifier (Task 13): the created source is selected in the
  // inspector and opened — selection lands after sync pulls the new ops.
  const handleIdentifierCreated = useCallback(
    (nodeUuid: string) => {
      setSelection((prev) => selectSource(prev, nodeUuid));
      openNode(nodeUuid);
    },
    [openNode],
  );

  // Drag-to-attach / drag-to-collect (Task 12). Both flow through normal ops
  // (asset upload + property.set; node.move), so sync comes free.
  const { attachFileToSource, addSourceToCollection } = useLibraryDnd();
  const handleDropFile = useCallback(
    (sourceUuid: string, file: File) => {
      void attachFileToSource(sourceUuid, file);
    },
    [attachFileToSource],
  );
  const handleDropSourceOnCollection = useCallback(
    (sourceUuid: string, collectionUuid: string) => {
      void addSourceToCollection(sourceUuid, collectionUuid);
    },
    [addSourceToCollection],
  );

  const isLoading = isCollectionSelected
    ? nestedLoading || linkedLoading
    : isAuthorsSection
      ? agentsLoading
      : sourcesLoading;

  return (
    <article className="node-view node-view--page library-view">
      <PageViewHeader
        className="library-view__header"
        title={<h1>Library</h1>}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              icon="mdi mdi-barcode-scan"
              onClick={() => setAddByIdentifierOpen(true)}
              aria-label="Add by identifier"
              title="Add by identifier (ISBN/DOI)"
            >
              Add by identifier
            </Button>
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

      <div className="library-view__panes">
        <div className="library-view__tree-pane">
          <CollectionTreePane
            rows={treeRows}
            selectedCollectionUuid={selection.collectionUuid}
            onSelectCollection={handleSelectCollection}
            onToggleExpand={handleToggleExpand}
            onDropSource={handleDropSourceOnCollection}
          />
        </div>

        <div className="library-view__center-pane">
          {isCollectionSelected ? (
            <div className="library-view__collection-heading">
              <span className="library-view__collection-heading-label">
                {selectedCollection ? libraryNodeName(selectedCollection) : 'Collection'}
              </span>
            </div>
          ) : (
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
          )}

          <div className="library-view__content">
            <DataStateView
              isLoading={isLoading}
              isEmpty={centerNodes.length === 0}
              emptyTitle={
                isCollectionSelected
                  ? 'No sources in this collection yet'
                  : isAuthorsSection
                    ? 'No authors yet'
                    : 'No sources yet'
              }
              emptyDescription={
                isCollectionSelected
                  ? 'Nest sources under this collection or link them to it.'
                  : isAuthorsSection
                    ? 'Agents (persons, organizations) referenced by sources appear here.'
                    : 'Class a page or block as a source (book, paper, ...) and it appears here.'
              }
              skeletonRows={4}
            >
              {viewMode === 'table' ? (
                <LibraryTable
                  rows={centerNodes}
                  groups={groups}
                  grouped={grouping === 'grouped' && !isAuthorsSection}
                  classNamesByUuid={classNamesByUuid}
                  agentsByUuid={agentsByUuid}
                  onOpenNode={handleOpenNode}
                  onSelectNode={handleSelectSource}
                  selectedUuid={inspectorUuid}
                  onDropFile={isAuthorsSection ? undefined : handleDropFile}
                />
              ) : (
                <LibraryCardGrid
                  rows={centerNodes}
                  groups={groups}
                  grouped={grouping === 'grouped' && !isAuthorsSection}
                  allSourcesByUuid={allSourcesByUuid}
                  agentsByUuid={agentsByUuid}
                  onOpenNode={handleOpenNode}
                  onSelectNode={handleSelectSource}
                  selectedUuid={inspectorUuid}
                  onDropFile={isAuthorsSection ? undefined : handleDropFile}
                />
              )}
            </DataStateView>
          </div>
        </div>

        {inspectorUuid && (
          <div className="library-view__inspector-pane">
            <LibraryInspector
              nodeUuid={inspectorUuid}
              onOpenNode={handleOpenNode}
              onClose={handleCloseInspector}
            />
          </div>
        )}
      </div>

      <AddByIdentifierDialog
        isOpen={addByIdentifierOpen}
        onClose={() => setAddByIdentifierOpen(false)}
        onCreated={handleIdentifierCreated}
      />
    </article>
  );
}

export default LibraryPage;
