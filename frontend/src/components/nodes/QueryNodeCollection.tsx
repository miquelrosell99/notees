/**
 * QueryNodeCollection Component
 * 
 * A unified component for displaying query-based node collections.
 * Handles view management, query execution, and result display.
 * 
 * Used by:
 * - Query blocks (inline mode with headless=true)
 * - Page sections (wrapped in NodeViewSection)
 */
import { useState, useMemo, useEffect, useCallback } from 'react';
import { 
  useNodeViews, 
  useEnsureDefaultViews,
  useNodeViewQuery,
  useQuery_,
  useCreateNodeView,
  useUpdateQueryAST,
  useUpdateNodeView,
  useDeleteNodeView,
} from '@/hooks/useNodeViews';
import { useCreateNode, usePageClass } from '@/hooks/useNodes';
import { useClasses } from '@/hooks/useNodeQueries';
import type { NodeView, NodeViewType } from '@/types/query';
import type { QueryAST, ValidationResult } from '@/types/queryAST';
import { createEmptyQueryAST, countConditions, isEmptyQuery } from '@/types/queryAST';
import { NodeCollection } from './NodeCollection';
import { Button } from '../core/Button';
import { Modal } from '../core/Modal';
import { Badge } from '../core/Badge';
import { SelectionButton } from '../core/SelectionButton';
import { InlineConfirmButton } from '../core/InlineConfirmButton';
import { TextField } from '../core/TextField';
import { ViewBuilder } from '../queries';
import { QuerySQLPreview } from '../queries/QuerySQLPreview';
import { ProseScopeSelector } from '../queries/ProseScopeSelector';
import { DeleteIcon } from '../icons';
import { validateQueryAST, canSaveQuery } from '@/lib/queryValidation';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { normalizeAST } from '@/lib/astNormalizer';
import { getQueryIntent } from '@/lib/astProseRenderer';
import type { NodeCollectionViewMode, NodeCollectionGroupBy } from '@/types/nodeCollection';
import { useNodesStore } from '@/stores';
import { mdiPlusBox, mdiFilterOutline, mdiEyeOutline, mdiContentCopy } from '@mdi/js';
import './DynamicNodeViewSection.css';
import './QueryPreview.css';

// ==================== Helper Functions ====================

/**
 * Render prose text with clickable markdown links
 */
function renderProseWithLinks(text: string, onLinkClick: (uuid: string) => void): React.ReactNode {
  // Match markdown links: [text](uuid)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = linkRegex.exec(text)) !== null) {
    // Add text before the link
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    // Add the link
    const linkText = match[1];
    const uuid = match[2];
    parts.push(
      <a
        key={match.index}
        href="#"
        onClick={(e) => {
          e.preventDefault();
          onLinkClick(uuid);
        }}
        style={{
          color: 'var(--color-primary)',
          textDecoration: 'none',
          cursor: 'pointer',
          borderBottom: '1px solid var(--color-primary)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.textDecoration = 'underline';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.textDecoration = 'none';
        }}
      >
        {linkText}
      </a>
    );

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}

// ==================== Types ====================

export interface QueryNodeCollectionProps {
  /** The node ID to display views for */
  nodeId: number;
  /** The node UUID for query placeholders */
  nodeUuid: string;
  /** The view type (e.g., 'linked_references', 'child_pages') */
  viewType: NodeViewType | string;
  /** Callback when a node is clicked */
  onNodeClick?: (nodeId: number, isPage?: boolean) => void;
  /** Callback when a block is created (for opening in sidebar) */
  onBlockCreated?: (nodeId: number) => void;
  /** Additional CSS class */
  className?: string;
  /** Whether to hide the toolbar completely (for inline/headless use like query blocks) */
  hideToolbar?: boolean;
  /** Whether to show add button in toolbar (deprecated - use can_create instead) */
  showAddButton?: boolean;
  /** Element to render at the left side of the toolbar (e.g., block element, collapsible header) */
  leftElement?: React.ReactNode | ((count: number) => React.ReactNode);
  /** Hide toolbar controls while keeping leftElement visible */
  hideToolbarControls?: boolean;
  /** Hide the content area while keeping toolbar visible */
  hideContent?: boolean;
  
  // ==================== Capability Props ====================
  
  /** Whether new items can be created (default: true). Controls add buttons in toolbar and card view. */
  can_create?: boolean;
  /** Whether items can be edited (default: true). Controls editability of content. */
  can_edit?: boolean;
  /** Whether items can be deleted (default: true). Controls delete actions in context menus. */
  can_delete?: boolean;
  
  /** Render prop - receives controls and results */
  children: (result: QueryNodeCollectionResult) => React.ReactNode;
}

export interface QueryNodeCollectionResult {
  /** Toolbar/header actions */
  controls: React.ReactNode;
  /** The results (NodeCollection) */
  results: React.ReactNode;
  /** Number of results */
  count: number;
  /** Whether loading */
  isLoading: boolean;
}

// ==================== Main Component ====================

export function QueryNodeCollection({
  nodeId,
  nodeUuid,
  viewType,
  onNodeClick,
  onBlockCreated,
  hideToolbar = false,
  showAddButton = true,
  leftElement,
  hideToolbarControls = false,
  hideContent = false,
  can_create = true,
  can_edit = true,
  can_delete = true,
  children,
}: QueryNodeCollectionProps): React.ReactNode {
  // Compute effective capabilities
  // can_create controls both toolbar add button and card view add card
  const effectiveCanCreate = can_create && showAddButton;
  // State
  const [activeViewId, setActiveViewId] = useState<number | null>(null);
  const [editingView, setEditingView] = useState<NodeView | null>(null);
  const [editViewName, setEditViewName] = useState('');
  const [editAST, setEditAST] = useState<QueryAST | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [showProseModal, setShowProseModal] = useState(false);
  const [showSQL, setShowSQL] = useState(false);

  // Handle copying AST to clipboard
  const handleCopyAST = useCallback(() => {
    if (editAST) {
      const astJson = JSON.stringify(editAST, null, 2);
      navigator.clipboard.writeText(astJson);
    }
  }, [editAST]);

  // Handle AST changes during editing
  const handleASTChange = useCallback((newAST: QueryAST) => {
    setEditAST(newAST);
    const validationResult = validateQueryAST(newAST);
    setValidation(validationResult);
  }, []);
  
  // Get persisted view mode from store
  const getNodeViewMode = useNodesStore(state => state.getNodeViewMode);
  const setNodeViewMode = useNodesStore(state => state.setNodeViewMode);
  const openNode = useNodesStore(state => state.openNode);
  const persistedViewMode = getNodeViewMode(nodeId);
  
  // Default to 'table' for classed_nodes, 'list' for others
  const defaultViewMode: NodeCollectionViewMode = viewType === 'classed_nodes' ? 'table' : 'list';
  
  const [collectionViewMode, setCollectionViewMode] = useState<NodeCollectionViewMode>(
    persistedViewMode ?? defaultViewMode
  );
  
  const handleViewModeChange = (mode: NodeCollectionViewMode) => {
    setCollectionViewMode(mode);
    setNodeViewMode(nodeId, mode);
  };
  
  const [groupBy, setGroupBy] = useState<NodeCollectionGroupBy>('page');
  // Property column selection state (for table view)
  // Default to Created and Modified columns (matches default table columns)
  const [selectedPropertyUuids, setSelectedPropertyUuids] = useState<string[]>([]);
  const [hasInitialized, setHasInitialized] = useState(false);

  // Check if this is a pseudo-node (nodeId <= 0, used for all_pages view)
  const isPseudoNode = nodeId <= 0;

  // Ensure default views exist
  const ensureDefaultViews = useEnsureDefaultViews();
  
  useEffect(() => {
    if (nodeId > 0) {
      ensureDefaultViews.mutate(
        { nodeId, viewTypes: [viewType] },
        { onSettled: () => setHasInitialized(true) }
      );
    } else {
      setHasInitialized(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, viewType]);

  const isInitializing = !hasInitialized;

  // Fetch views for this node and view type
  const { 
    data: views = [], 
    isLoading: viewsLoading,
    refetch: refetchViews,
  } = useNodeViews(nodeId, { 
    viewType, 
    enabled: nodeId > 0 && hasInitialized,
  });

  // Mutations
  const createViewMutation = useCreateNodeView();
  const updateQueryMutation = useUpdateQueryAST();
  const updateViewMutation = useUpdateNodeView();
  const deleteViewMutation = useDeleteNodeView();
  const createNodeMutation = useCreateNode();
  const { pageClassId } = usePageClass();
  
  // Fetch all classes for prose rendering
  const { data: allClasses = [] } = useClasses();

  // Determine active view
  const activeView = useMemo(() => {
    if (activeViewId) {
      return views.find(v => v.id === activeViewId) ?? views[0] ?? null;
    }
    const defaultView = views.find(v => v.is_default);
    return defaultView ?? views[0] ?? null;
  }, [views, activeViewId]);

  // Count filter blocks for badge (excludes system query blocks)
  const filterBlockCount = useMemo(() => {
    const ast = activeView?.query_ast;
    if (!ast || typeof ast !== 'object' || ast.type !== 'query') return 0;
    // Apply auto-fix to ensure system conditions have proper capabilities marked
    // before counting (capabilities may be lost after backend round-trip)
    const fixedAST = autoFixSystemQuery(ast, viewType, { nodeUuid });
    return countConditions(fixedAST);
  }, [activeView, viewType, nodeUuid]);

  // Create SelectionButton options from views
  const viewOptions = useMemo(() => {
    return views.map(v => ({
      value: String(v.id),
      icon: mdiEyeOutline,
      label: v.name,
    }));
  }, [views]);

  // Pseudo-node query AST for all_pages
  const pseudoNodeAST = useMemo((): QueryAST | undefined => {
    if (!isPseudoNode) return undefined;
    
    const defaultQueries: Record<string, QueryAST> = {
      all_pages: {
        type: 'query',
        version: '1.0',
        id: 'all_pages_query',
        scope: { type: 'scope', scope_type: 'pages' },
        root_group: {
          type: 'group',
          logic: 'AND',
          children: [
            {
              type: 'condition',
              condition_type: 'class',
              operator: 'is_any_of',
              class_uuids: [],
            } as any,
          ],
        },
      },
    };
    
    return defaultQueries[viewType] ?? createEmptyQueryAST();
  }, [isPseudoNode, viewType]);

  // Execute query for active view
  const {
    data: queryResults,
    isLoading: queryLoading,
  } = useNodeViewQuery(activeView?.id ?? 0, {
    runtimeParams: { 
      current_node_uuid: nodeUuid,
      current_node_id: nodeId,
    },
    includeChildren: viewType === 'linked_references' || viewType === 'child_pages' || collectionViewMode === 'card',
    includeProperties: true,
    enabled: !!activeView && nodeId > 0,
  });

  // Execute ad-hoc query for pseudo-nodes
  const {
    data: pseudoQueryResults,
    isLoading: pseudoQueryLoading,
  } = useQuery_(
    {
      query_ast: pseudoNodeAST ?? undefined,
      runtime_params: {
        current_node_uuid: nodeUuid,
        current_node_id: nodeId,
      },
      include_children: viewType === 'all_pages' || collectionViewMode === 'card',
      include_properties: true,
    },
    {
      enabled: isPseudoNode && !!pseudoNodeAST,
      queryKey: ['pseudo-node-query', viewType, nodeId, collectionViewMode],
    }
  );

  const rawResults = isPseudoNode ? (pseudoQueryResults ?? []) : (queryResults ?? []);
  const activeAST = isPseudoNode ? pseudoNodeAST : activeView?.query_ast;
  const resultNodes = (activeAST && isEmptyQuery(activeAST)) ? [] : rawResults;
  const isQueryLoading = isPseudoNode ? pseudoQueryLoading : queryLoading;

  // Preview query for edit modal
  const previewAST = useMemo(() => editAST ? normalizeAST(editAST) : undefined, [editAST]);

  const {
    data: previewResults,
    isLoading: previewLoading,
  } = useQuery_(
    {
      query_ast: previewAST,
      runtime_params: {
        current_node_uuid: nodeUuid,
        current_node_id: nodeId,
      },
      include_children: viewType === 'all_pages' || collectionViewMode === 'card',
      include_properties: true,
    },
    {
      enabled: !!previewAST,
      queryKey: ['preview-query', nodeId, previewAST, collectionViewMode],
    }
  );

  // Build nodesMap for prose rendering
  const nodesMap = useMemo(() => {
    const map = new Map();
    // Add preview results
    if (previewResults) {
      previewResults.forEach(node => {
        map.set(node.uuid, node);
      });
    }
    // Add all classes/types so they can be referenced by UUID
    allClasses.forEach(node => {
      map.set(node.uuid, node);
    });
    return map;
  }, [previewResults, allClasses]);

  // Handle clicking on a node link in prose preview
  const handleNodeLinkClick = useCallback((uuid: string) => {
    const node = nodesMap.get(uuid);
    if (node) {
      openNode(node.id, node.is_page ? 'page' : 'block');
    }
  }, [nodesMap, openNode]);

  // Handlers
  const handleEditView = useCallback((view: NodeView) => {
    setEditingView(view);
    setEditViewName(view.name);
    
    const queryId = `view-${view.id}-${view.uuid}`;
    let ast: QueryAST;
    
    if (view.query_ast && typeof view.query_ast === 'object' && view.query_ast.type === 'query') {
      ast = view.query_ast;
      if (!ast.id) {
        ast.id = queryId;
      }
    } else {
      ast = createEmptyQueryAST();
      ast.id = queryId;
    }
    
    ast = autoFixSystemQuery(ast, viewType, { nodeUuid });
    
    setEditAST(ast);
    const validationResult = validateQueryAST(ast);
    setValidation(validationResult);
  }, [viewType]);

  const handleSaveEdit = useCallback(async () => {
    if (!editingView || !editAST) return;
    
    try {
      const normalizedAST = normalizeAST(editAST);
      
      await Promise.all([
        updateQueryMutation.mutateAsync({
          viewId: editingView.id,
          queryAST: normalizedAST,
        }),
        editViewName !== editingView.name && updateViewMutation.mutateAsync({
          viewId: editingView.id,
          data: { name: editViewName },
        }),
      ].filter(Boolean));
      
      setEditingView(null);
      setEditAST(null);
      setValidation(null);
      setEditViewName('');
      refetchViews();
    } catch (error) {
      console.error('Failed to save view:', error);
    }
  }, [editingView, editAST, editViewName, updateQueryMutation, updateViewMutation, refetchViews]);

  const handleDeleteView = useCallback(async () => {
    if (!editingView) return;
    try {
      await deleteViewMutation.mutateAsync(editingView.id);
      setEditingView(null);
      setEditAST(null);
      setValidation(null);
      setEditViewName('');
      if (activeViewId === editingView.id) {
        setActiveViewId(null);
      }
    } catch (error) {
      console.error('Failed to delete view:', error);
    }
  }, [editingView, activeViewId, deleteViewMutation]);

  const handlePropertyColumnsChange = useCallback((propertyUuids: string[]) => {
    setSelectedPropertyUuids(propertyUuids);
  }, []);

  const handleAddView = useCallback(async () => {
    try {
      const newView = await createViewMutation.mutateAsync({
        node_id: nodeId,
        name: 'New View',
        view_type: viewType,
        order_index: views.length,
        is_default: views.length === 0,
      });
      setActiveViewId(newView.id);
      handleEditView(newView);
    } catch (error) {
      console.error('Failed to create view:', error);
    }
  }, [nodeId, viewType, views.length, createViewMutation, handleEditView]);

  const handleAddNode = useCallback(async () => {
    try {
      if (!pageClassId) {
        console.error('Page class not found');
        return;
      }

      let nodeData: { name: string; classes?: number[]; parent_id?: number } = {
        name: '',
      };

      switch (viewType) {
        case 'child_pages':
          nodeData = {
            name: '',
            classes: [pageClassId],
            parent_id: nodeId,
          };
          break;
        
        case 'classed_nodes':
          nodeData = {
            name: '',
            parent_id: nodeId,
          };
          break;
        
        case 'all_pages':
          nodeData = {
            name: '',
            classes: [pageClassId],
          };
          break;
        
        default:
          nodeData = { name: '' };
      }

      const newNode = await createNodeMutation.mutateAsync(nodeData);
      
      if (newNode.is_page) {
        onNodeClick?.(newNode.id, true);
      } else {
        onBlockCreated?.(newNode.id);
      }
    } catch (error) {
      console.error('Failed to create node:', error);
    }
  }, [viewType, nodeId, pageClassId, createNodeMutation, onNodeClick, onBlockCreated]);

  // Loading state - return empty result
  if (viewsLoading || isInitializing) {
    return children({
      controls: null,
      results: null,
      count: 0,
      isLoading: true,
    });
  }

  const resultCount = resultNodes.length;

  // Resolve leftElement (can be static or function)
  const resolvedLeftElement = typeof leftElement === 'function' 
    ? leftElement(resultCount) 
    : leftElement;

  // Toolbar prefix - view selector, filter button, add view button
  const toolbarPrefix = (
    <>
      {/* View selection (only when multiple views) */}
      {views.length > 1 && (
        <SelectionButton
          options={viewOptions}
          value={String(activeView?.id ?? '')}
          onChange={(value) => setActiveViewId(Number(value))}
          size="sm"
        />
      )}
      
      {activeView && (
        <div className="dynamic-section__filter-btn-wrapper">
          <Button
            icon={mdiFilterOutline}
            iconOnly
            variant="ghost"
            size="xs"
            onClick={() => handleEditView(activeView)}
            title="Edit view"
          />
          {filterBlockCount > 0 && (
            <Badge variant="primary" size="xs" className="dynamic-section__filter-badge">
              {filterBlockCount}
            </Badge>
          )}
        </div>
      )}
      
      <Button
        icon={mdiPlusBox}
        iconOnly
        variant="ghost"
        size="xs"
        onClick={handleAddView}
        title="Add view"
      />
    </>
  );

  // Results with integrated toolbar
  const results = (
    <>
      {isQueryLoading ? (
        <div className="dynamic-section__loading">Loading...</div>
      ) : (
        <NodeCollection
          nodes={resultNodes}
          viewId={activeView?.id}
          view={activeView}
          viewMode={collectionViewMode}
          availableViewModes={['list', 'table', 'card']}
          onViewModeChange={handleViewModeChange}
          editable={can_edit}
          hideToolbar={hideToolbar}
          toolbarPrefix={hideToolbar ? undefined : toolbarPrefix}
          leftElement={resolvedLeftElement}
          hideToolbarControls={hideToolbarControls}
          hideContent={hideContent}
          showGroupBy={collectionViewMode === 'list'}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          showAddButton={effectiveCanCreate && viewType !== 'linked_references'}
          onAdd={effectiveCanCreate ? handleAddNode : undefined}
          can_create={can_create}
          can_edit={can_edit}
          can_delete={can_delete}
          pagesOnly={viewType === 'all_pages' || viewType === 'child_pages'}
          showClasses={true}
          selectedPropertyUuids={selectedPropertyUuids}
          onPropertyColumnsChange={handlePropertyColumnsChange}
          onNodeClick={(node) => onNodeClick?.(node.id, node.is_page)}
          emptyMessage={filterBlockCount > 0 ? "No results match the query filters" : "No results found"}
        />
      )}

      {/* Edit Modal */}
      <Modal
        isOpen={!!editingView}
        onClose={() => {
          setEditingView(null);
          setEditAST(null);
          setEditViewName('');
        }}
        title="Query"
        headerLeftElement={
          <Button
            icon={mdiEyeOutline}
            iconOnly
            variant="ghost"
            size="xs"
            onClick={() => setShowProseModal(true)}
            title="Show query as prose"
          />
        }
        size="xl"
        className="dynamic-section__edit-modal"
        footer={editingView && (
          <div className="dynamic-section__modal-footer">
            <div className="view-builder__footer-left">
              <ProseScopeSelector
                scope={editAST?.scope || { type: 'scope', scope_type: 'current_page' }}
                onChange={(newScope) => {
                  if (editAST) {
                    setEditAST({
                      ...editAST,
                      scope: newScope,
                    });
                  }
                }}
                readOnly={['linked_references', 'child_pages', 'classed_nodes', 'extended_by'].includes(viewType)}
              />
            </div>
            
            {previewResults && (
              <div className="view-builder__result-preview">
                {previewLoading ? (
                  <span className="view-builder__result-loading">Calculating…</span>
                ) : (
                  <span className="view-builder__result-count">
                    <span className="view-builder__result-dot">●</span>
                    {previewResults.length} node{previewResults.length !== 1 ? 's' : ''} found
                  </span>
                )}
              </div>
            )}
            
            <div className="dynamic-section__footer-spacer" />
            
            <TextField
              value={editViewName}
              onChange={(e) => setEditViewName(e.target.value)}
              placeholder="View name"
              size="sm"
              className="dynamic-section__view-name-field"
            />
            
            {!editingView?.is_default && (
              <InlineConfirmButton
                variant="ghost"
                size="sm"
                title="Delete view"
                onConfirm={handleDeleteView}
              >
                <DeleteIcon size="sm" />
              </InlineConfirmButton>
            )}
            
            <Button
              variant="primary"
              size="sm"
              onClick={handleSaveEdit}
              disabled={validation ? !canSaveQuery(validation) : false}
            >
              Save
            </Button>
          </div>
        )}
      >
        {editingView && editAST && (
          <div className="dynamic-section__edit-content">
            <ViewBuilder
              ast={editAST}
              onChange={handleASTChange}
              resultCount={previewResults?.length ?? 0}
              isLoading={previewLoading}
            />
          </div>
        )}
      </Modal>

      {/* Prose query preview modal */}
      <Modal
        isOpen={showProseModal}
        onClose={() => {
          setShowProseModal(false);
          setShowSQL(false);
        }}
        title="Query Preview"
        size="xl"
        className="query-preview-modal"
      >
        {editAST && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Prose description */}
            <div>
              <h4 style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--text-secondary)',
                marginBottom: '12px',
                textTransform: 'uppercase',
                letterSpacing: '0.5px'
              }}>
                Natural Language
              </h4>
              <div style={{
                padding: '16px',
                fontSize: '15px',
                lineHeight: '1.6',
                color: 'var(--text-primary)',
                backgroundColor: 'var(--bg-secondary)',
                borderRadius: '4px'
              }}>
                {renderProseWithLinks(getQueryIntent(editAST, nodesMap), handleNodeLinkClick)}
              </div>
            </div>

            {/* AST Section */}
            <div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '12px'
              }}>
                <h4 style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px'
                }}>
                  Query Structure
                </h4>
                <Button
                  icon={mdiContentCopy}
                  onClick={handleCopyAST}
                  variant="ghost"
                  size="xs"
                >
                  Copy
                </Button>
              </div>
              <pre style={{
                padding: '16px',
                fontSize: '13px',
                lineHeight: '1.5',
                backgroundColor: 'var(--bg-tertiary)',
                borderRadius: '4px',
                overflow: 'auto',
                maxHeight: '300px',
                color: 'var(--text-primary)'
              }}>
                {JSON.stringify(editAST, null, 2)}
              </pre>
            </div>

            {/* SQL Section */}
            <div>
              {!showSQL ? (
                <button
                  type="button"
                  onClick={() => setShowSQL(true)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: '8px 0',
                    fontSize: '13px',
                    color: 'var(--text-tertiary)',
                    cursor: 'pointer',
                    textDecoration: 'underline'
                  }}
                >
                  Show SQL preview
                </button>
              ) : (
                <>
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    marginBottom: '12px'
                  }}>
                    <h4 style={{
                      fontSize: '13px',
                      fontWeight: 600,
                      color: 'var(--text-secondary)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px'
                    }}>
                      Execution Preview
                    </h4>
                    <span style={{
                      fontSize: '12px',
                      color: 'var(--text-tertiary)',
                      fontStyle: 'italic'
                    }}>
                      (informational only)
                    </span>
                  </div>
                  <QuerySQLPreview ast={editAST} />
                  <button
                    type="button"
                    onClick={() => setShowSQL(false)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: '8px 0',
                      marginTop: '8px',
                      fontSize: '13px',
                      color: 'var(--text-tertiary)',
                      cursor: 'pointer',
                      textDecoration: 'underline'
                    }}
                  >
                    Hide
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );

  return children({
    controls: null,  // No longer separate - integrated into NodeCollection toolbar
    results,
    count: resultCount,
    isLoading: isQueryLoading,
  });
}

export default QueryNodeCollection;