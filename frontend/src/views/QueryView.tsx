/**
 * QueryView - Display query results with various view modes
 * 
 * Supports simple queries (like Logseq/Roam) and advanced Datalog queries.
 * Results can be displayed in list, table, cards, calendar, chart, gantt, or graph view.
 */
import { useState, useMemo, useCallback } from 'react';
import './QueryView.css';
import type { Node, Property } from '@/types/api';
import type { 
  Query, 
  SimpleQuery, 
  DatalogQuery,
  QueryCondition,
  QueryOperator,
  ViewMode,
} from '@/types/views';
import { BulletIcon, NodeIcon } from '../components/icons';
import { ButtonAdd } from '../components/core/ButtonAdd';
import { Button } from '../components/core/Button';

export interface QueryViewProps {
  /** All available nodes to query against */
  allNodes: Node[];
  /** All available properties */
  properties?: Property[];
  /** Tag nodes for tag-based queries */
  tags?: Node[];
  /** Initial query */
  query?: Query;
  /** Callback when query changes */
  onQueryChange?: (query: Query) => void;
  /** Callback when a node is clicked */
  onNodeClick?: (nodeId: number) => void;
  /** View mode for results */
  viewMode?: ViewMode;
  /** Callback when view mode changes */
  onViewModeChange?: (mode: ViewMode) => void;
  /** Whether to collapse the query editor by default */
  defaultCollapsed?: boolean;
  /** Extra CSS class */
  className?: string;
  /** Title */
  title?: string;
}

const OPERATORS: { value: QueryOperator; label: string; types: string[] }[] = [
  { value: 'equals', label: 'equals', types: ['text', 'selection', 'date', 'integer', 'float'] },
  { value: 'not-equals', label: 'not equals', types: ['text', 'selection', 'date', 'integer', 'float'] },
  { value: 'contains', label: 'contains', types: ['text'] },
  { value: 'not-contains', label: 'not contains', types: ['text'] },
  { value: 'starts-with', label: 'starts with', types: ['text'] },
  { value: 'ends-with', label: 'ends with', types: ['text'] },
  { value: 'greater-than', label: '>', types: ['integer', 'float'] },
  { value: 'less-than', label: '<', types: ['integer', 'float'] },
  { value: 'greater-or-equal', label: '>=', types: ['integer', 'float'] },
  { value: 'less-or-equal', label: '<=', types: ['integer', 'float'] },
  { value: 'is-empty', label: 'is empty', types: ['text', 'selection', 'node'] },
  { value: 'is-not-empty', label: 'is not empty', types: ['text', 'selection', 'node'] },
  { value: 'is-true', label: 'is true', types: ['boolean'] },
  { value: 'is-false', label: 'is false', types: ['boolean'] },
  { value: 'before', label: 'before', types: ['date'] },
  { value: 'after', label: 'after', types: ['date'] },
  { value: 'between', label: 'between', types: ['date', 'integer', 'float'] },
  { value: 'has-tag', label: 'has tag', types: ['tag'] },
  { value: 'not-has-tag', label: 'does not have tag', types: ['tag'] },
  { value: 'has-property', label: 'has property', types: ['property'] },
  { value: 'not-has-property', label: 'does not have property', types: ['property'] },
];

const VIEW_MODE_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: 'list', label: 'List' },
  { value: 'table', label: 'Table' },
  { value: 'cards', label: 'Cards' },
  { value: 'kanban', label: 'Kanban' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'chart', label: 'Chart' },
  { value: 'gantt', label: 'Gantt' },
  { value: 'graph', label: 'Graph' },
];

/**
 * Get property value from node
 */
function getPropertyValue(node: Node, propertyId: number, properties: Property[]): unknown {
  const prop = properties.find(p => p.id === propertyId);
  if (!prop || !node.properties) return undefined;
  
  const propKey = prop.name.toLowerCase().replace(/\s+/g, '_');
  return (node.properties as Record<string, unknown>)[propKey];
}

/**
 * Evaluate a single condition against a node
 */
function evaluateCondition(
  node: Node,
  condition: QueryCondition,
  properties: Property[],
  _tags: Node[]
): boolean {
  const { type, operator, value, value2 } = condition;
  
  switch (type) {
    case 'name': {
      const nodeName = (node.name || '').toLowerCase();
      const searchValue = String(value || '').toLowerCase();
      
      switch (operator) {
        case 'equals': return nodeName === searchValue;
        case 'not-equals': return nodeName !== searchValue;
        case 'contains': return nodeName.includes(searchValue);
        case 'not-contains': return !nodeName.includes(searchValue);
        case 'starts-with': return nodeName.startsWith(searchValue);
        case 'ends-with': return nodeName.endsWith(searchValue);
        case 'is-empty': return !nodeName;
        case 'is-not-empty': return !!nodeName;
        default: return false;
      }
    }
    
    case 'tag': {
      const nodeTags = node.tags ?? [];
      const tagId = condition.tagId ?? (typeof value === 'number' ? value : 0);
      
      switch (operator) {
        case 'has-tag': return nodeTags.includes(tagId);
        case 'not-has-tag': return !nodeTags.includes(tagId);
        default: return false;
      }
    }
    
    case 'property': {
      if (!condition.propertyId) return false;
      const propValue = getPropertyValue(node, condition.propertyId, properties);
      const prop = properties.find(p => p.id === condition.propertyId);
      
      if (!prop) return false;
      
      switch (operator) {
        case 'is-empty': return propValue === undefined || propValue === null || propValue === '';
        case 'is-not-empty': return propValue !== undefined && propValue !== null && propValue !== '';
        case 'has-property': return propValue !== undefined;
        case 'not-has-property': return propValue === undefined;
        case 'is-true': return propValue === true;
        case 'is-false': return propValue === false;
        case 'equals': return propValue === value;
        case 'not-equals': return propValue !== value;
        case 'contains': return String(propValue ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
        case 'not-contains': return !String(propValue ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
        case 'starts-with': return String(propValue ?? '').toLowerCase().startsWith(String(value ?? '').toLowerCase());
        case 'ends-with': return String(propValue ?? '').toLowerCase().endsWith(String(value ?? '').toLowerCase());
        case 'greater-than': return typeof propValue === 'number' && propValue > Number(value);
        case 'less-than': return typeof propValue === 'number' && propValue < Number(value);
        case 'greater-or-equal': return typeof propValue === 'number' && propValue >= Number(value);
        case 'less-or-equal': return typeof propValue === 'number' && propValue <= Number(value);
        case 'before': return String(propValue ?? '') < String(value ?? '');
        case 'after': return String(propValue ?? '') > String(value ?? '');
        case 'between': {
          const v = String(propValue ?? '');
          return v >= String(value ?? '') && v <= String(value2 ?? '');
        }
        default: return false;
      }
    }
    
    case 'date': {
      // Query against node's create_date or write_date
      const dateValue = new Date(node.create_date);
      const compareDate = value ? new Date(String(value)) : null;
      const compareDate2 = value2 ? new Date(String(value2)) : null;
      
      if (!compareDate) return false;
      
      switch (operator) {
        case 'equals': return dateValue.toDateString() === compareDate.toDateString();
        case 'before': return dateValue < compareDate;
        case 'after': return dateValue > compareDate;
        case 'between': return compareDate2 ? dateValue >= compareDate && dateValue <= compareDate2 : false;
        default: return false;
      }
    }
    
    case 'backlinks': {
      const count = node.backlinks?.length ?? 0;
      const numValue = Number(value ?? 0);
      
      switch (operator) {
        case 'equals': return count === numValue;
        case 'greater-than': return count > numValue;
        case 'less-than': return count < numValue;
        case 'greater-or-equal': return count >= numValue;
        case 'less-or-equal': return count <= numValue;
        case 'is-empty': return count === 0;
        case 'is-not-empty': return count > 0;
        default: return false;
      }
    }
    
    default:
      return false;
  }
}

/**
 * Execute a simple query
 */
function executeSimpleQuery(
  query: SimpleQuery,
  nodes: Node[],
  properties: Property[],
  tags: Node[]
): Node[] {
  let results = nodes;
  
  // Filter by pages only
  if (query.pagesOnly) {
    // Assuming page tag has specific ID - this should come from context
    results = results.filter(n => n.parent_id === null);
  }
  
  // Apply conditions
  if (query.conditions.length > 0) {
    results = results.filter(node => {
      const evaluations = query.conditions.map(c => 
        evaluateCondition(node, c, properties, tags)
      );
      
      return query.logic === 'and' 
        ? evaluations.every(e => e)
        : evaluations.some(e => e);
    });
  }
  
  // Sort
  if (query.sortBy) {
    results = [...results].sort((a, b) => {
      let aVal: unknown, bVal: unknown;
      
      if (typeof query.sortBy === 'object') {
        aVal = getPropertyValue(a, query.sortBy.propertyId, properties);
        bVal = getPropertyValue(b, query.sortBy.propertyId, properties);
      } else {
        switch (query.sortBy) {
          case 'name':
            aVal = a.name || '';
            bVal = b.name || '';
            break;
          case 'create_date':
            aVal = a.create_date;
            bVal = b.create_date;
            break;
          case 'write_date':
            aVal = a.write_date;
            bVal = b.write_date;
            break;
        }
      }
      
      const cmp = String(aVal ?? '').localeCompare(String(bVal ?? ''));
      return query.sortOrder === 'desc' ? -cmp : cmp;
    });
  }
  
  // Limit
  if (query.limit && query.limit > 0) {
    results = results.slice(0, query.limit);
  }
  
  return results;
}

/**
 * Execute a datalog query (simplified implementation)
 * Full Datalog would require a proper query engine
 */
function executeDatalogQuery(
  query: DatalogQuery,
  nodes: Node[],
  properties: Property[],
  tags: Node[]
): Node[] {
  // This is a simplified implementation
  // A full Datalog engine would be much more complex
  
  let results = nodes;
  
  for (const pattern of query.where) {
    switch (pattern.type) {
      case 'node':
        if (pattern.attribute === 'name' && typeof pattern.value === 'string') {
          results = results.filter(n => 
            (n.name || '').toLowerCase().includes(pattern.value.toString().toLowerCase())
          );
        }
        break;
        
      case 'tag':
        if (typeof pattern.tagVar === 'number') {
          results = results.filter(n => n.tags?.includes(pattern.tagVar as number));
        } else if (typeof pattern.tagVar === 'string' && !pattern.tagVar.startsWith('?')) {
          const tag = tags.find(t => t.name?.toLowerCase() === pattern.tagVar.toString().toLowerCase());
          if (tag) {
            results = results.filter(n => n.tags?.includes(tag.id));
          }
        }
        break;
        
      case 'property':
        const prop = properties.find(p => 
          p.name.toLowerCase().replace(/\s+/g, '_') === pattern.propertyName.toLowerCase()
        );
        if (prop && (typeof pattern.valueVar !== 'string' || !pattern.valueVar?.toString().startsWith('?'))) {
          results = results.filter(n => {
            const val = getPropertyValue(n, prop.id, properties);
            return val === pattern.valueVar;
          });
        }
        break;
        
      case 'predicate':
        // Handle predicates
        break;
    }
  }
  
  return results;
}

/**
 * Execute a query
 */
function executeQuery(
  query: Query,
  nodes: Node[],
  properties: Property[],
  tags: Node[]
): Node[] {
  if (query.type === 'simple') {
    return executeSimpleQuery(query, nodes, properties, tags);
  } else {
    return executeDatalogQuery(query, nodes, properties, tags);
  }
}

/**
 * Condition editor component
 */
function ConditionEditor({
  condition,
  properties,
  tags,
  onChange,
  onRemove,
}: {
  condition: QueryCondition;
  properties: Property[];
  tags: Node[];
  onChange: (condition: QueryCondition) => void;
  onRemove: () => void;
}) {
  const typeOptions = [
    { value: 'name', label: 'Name' },
    { value: 'tag', label: 'Tag' },
    { value: 'property', label: 'Property' },
    { value: 'date', label: 'Created Date' },
    { value: 'backlinks', label: 'Backlinks' },
  ];
  
  const availableOperators = OPERATORS.filter(op => {
    if (condition.type === 'tag') return op.types.includes('tag');
    if (condition.type === 'property' && condition.propertyId) {
      const prop = properties.find(p => p.id === condition.propertyId);
      return prop ? op.types.includes(prop.type) : false;
    }
    if (condition.type === 'name') return op.types.includes('text');
    if (condition.type === 'date') return op.types.includes('date');
    if (condition.type === 'backlinks') return ['equals', 'greater-than', 'less-than', 'is-empty', 'is-not-empty'].includes(op.value);
    return true;
  });
  
  return (
    <div className="query-view__condition">
      {/* Type selector */}
      <select
        className="query-view__select"
        value={condition.type}
        onChange={(e) => onChange({ 
          ...condition, 
          type: e.target.value as QueryCondition['type'],
          propertyId: undefined,
          tagId: undefined,
        })}
      >
        {typeOptions.map(t => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>
      
      {/* Property selector (when type is property) */}
      {condition.type === 'property' && (
        <select
          className="query-view__select"
          value={condition.propertyId ?? ''}
          onChange={(e) => onChange({ 
            ...condition, 
            propertyId: e.target.value ? Number(e.target.value) : undefined 
          })}
        >
          <option value="">Select property...</option>
          {properties.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}
      
      {/* Tag selector (when type is tag) */}
      {condition.type === 'tag' && (
        <select
          className="query-view__select"
          value={condition.tagId ?? ''}
          onChange={(e) => onChange({ 
            ...condition, 
            tagId: e.target.value ? Number(e.target.value) : undefined 
          })}
        >
          <option value="">Select tag...</option>
          {tags.map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      )}
      
      {/* Operator selector */}
      <select
        className="query-view__select"
        value={condition.operator}
        onChange={(e) => onChange({ ...condition, operator: e.target.value as QueryOperator })}
      >
        {availableOperators.map(op => (
          <option key={op.value} value={op.value}>{op.label}</option>
        ))}
      </select>
      
      {/* Value input (when needed) */}
      {!['is-empty', 'is-not-empty', 'is-true', 'is-false', 'has-tag', 'not-has-tag'].includes(condition.operator) && (
        <input
          type="text"
          className="query-view__input"
          value={String(condition.value ?? '')}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
          placeholder="Value..."
        />
      )}
      
      {/* Second value for between */}
      {condition.operator === 'between' && (
        <input
          type="text"
          className="query-view__input"
          value={String(condition.value2 ?? '')}
          onChange={(e) => onChange({ ...condition, value2: e.target.value })}
          placeholder="To..."
        />
      )}
      
      {/* Remove button */}
      <Button className="query-view__remove-btn" variant="ghost" size="xs" onClick={onRemove}>×</Button>
    </div>
  );
}

/**
 * Simple query editor
 */
function SimpleQueryEditor({
  query,
  properties,
  tags,
  onChange,
}: {
  query: SimpleQuery;
  properties: Property[];
  tags: Node[];
  onChange: (query: SimpleQuery) => void;
}) {
  const addCondition = () => {
    onChange({
      ...query,
      conditions: [
        ...query.conditions,
        { type: 'name', operator: 'contains', value: '' },
      ],
    });
  };
  
  const updateCondition = (index: number, condition: QueryCondition) => {
    const conditions = [...query.conditions];
    conditions[index] = condition;
    onChange({ ...query, conditions });
  };
  
  const removeCondition = (index: number) => {
    onChange({
      ...query,
      conditions: query.conditions.filter((_, i) => i !== index),
    });
  };
  
  return (
    <div className="query-view__simple-editor">
      {/* Logic selector */}
      <div className="query-view__logic">
        <span>Match</span>
        <select
          className="query-view__select"
          value={query.logic}
          onChange={(e) => onChange({ ...query, logic: e.target.value as 'and' | 'or' })}
        >
          <option value="and">all</option>
          <option value="or">any</option>
        </select>
        <span>of the following:</span>
      </div>
      
      {/* Conditions */}
      <div className="query-view__conditions">
        {query.conditions.map((condition, index) => (
          <ConditionEditor
            key={index}
            condition={condition}
            properties={properties}
            tags={tags}
            onChange={(c) => updateCondition(index, c)}
            onRemove={() => removeCondition(index)}
          />
        ))}
      </div>
      
      {/* Add condition button */}
      <ButtonAdd 
        className="query-view__add-btn" 
        onClick={addCondition}
        title="Add condition"
        size="sm"
      >
        Add condition
      </ButtonAdd>
      
      {/* Options */}
      <div className="query-view__options">
        <label className="query-view__checkbox">
          <input
            type="checkbox"
            checked={query.pagesOnly ?? true}
            onChange={(e) => onChange({ ...query, pagesOnly: e.target.checked })}
          />
          Pages only
        </label>
        
        <div className="query-view__sort">
          <span>Sort by</span>
          <select
            className="query-view__select"
            value={typeof query.sortBy === 'object' ? `prop-${query.sortBy.propertyId}` : query.sortBy ?? 'name'}
            onChange={(e) => {
              const val = e.target.value;
              if (val.startsWith('prop-')) {
                onChange({ ...query, sortBy: { propertyId: Number(val.replace('prop-', '')) } });
              } else {
                onChange({ ...query, sortBy: val as 'name' | 'create_date' | 'write_date' });
              }
            }}
          >
            <option value="name">Name</option>
            <option value="create_date">Created</option>
            <option value="write_date">Modified</option>
            {properties.map(p => (
              <option key={p.id} value={`prop-${p.id}`}>{p.name}</option>
            ))}
          </select>
          <select
            className="query-view__select"
            value={query.sortOrder ?? 'asc'}
            onChange={(e) => onChange({ ...query, sortOrder: e.target.value as 'asc' | 'desc' })}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </div>
        
        <div className="query-view__limit">
          <span>Limit</span>
          <input
            type="number"
            className="query-view__input query-view__input--small"
            value={query.limit ?? ''}
            onChange={(e) => onChange({ ...query, limit: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="No limit"
            min={1}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Advanced query editor (Datalog)
 */
function AdvancedQueryEditor({
  query,
  onChange,
}: {
  query: DatalogQuery;
  onChange: (query: DatalogQuery) => void;
}) {
  const [queryText, setQueryText] = useState(() => {
    // Convert query to text representation
    const findClause = `[:find ${query.find.join(' ')}`;
    const whereClause = query.where.length > 0 
      ? `\n :where\n  ${query.where.map(p => JSON.stringify(p)).join('\n  ')}`
      : '';
    return `${findClause}${whereClause}]`;
  });
  
  const parseQuery = (text: string) => {
    // Simplified parser - in production, use a proper Datalog parser
    try {
      // Extract find variables
      const findMatch = text.match(/:find\s+([\?\w\s]+)/);
      const findVars = findMatch 
        ? findMatch[1].trim().split(/\s+/).filter(v => v.startsWith('?')) as `?${string}`[]
        : ['?node' as const];
      
      onChange({
        type: 'datalog',
        find: findVars,
        where: query.where, // Keep existing patterns for now
      });
    } catch {
      // Invalid query, don't update
    }
  };
  
  return (
    <div className="query-view__advanced-editor">
      <div className="query-view__datalog-help">
        <p>Write a Datalog query. Example:</p>
        <pre>{`[:find ?node
 :where
  [?node :node/tag "project"]
  [?node :prop/status "active"]]`}</pre>
      </div>
      <textarea
        className="query-view__datalog-input"
        value={queryText}
        onChange={(e) => setQueryText(e.target.value)}
        onBlur={() => parseQuery(queryText)}
        rows={8}
        spellCheck={false}
      />
    </div>
  );
}

/**
 * Results list view
 */
function ResultsList({
  nodes,
  onNodeClick,
}: {
  nodes: Node[];
  onNodeClick?: (nodeId: number) => void;
}) {
  return (
    <ul className="query-view__results-list">
      {nodes.map(node => (
        <li key={node.id} className="query-view__result-item">
          <Button 
            className="query-view__result-btn"
            variant="ghost"
            size="sm"
            onClick={() => onNodeClick?.(node.id)}
          >
            <span className="query-view__result-bullet">
              <BulletIcon size="xs" />
            </span>
            <NodeIcon icon={node.icon} isPage={node.parent_id === null} isDaily={node.is_daily} isMonthly={node.is_monthly} isYearly={node.is_yearly} size="sm" />
            <span className="query-view__result-name">{node.name || 'Untitled'}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * QueryView Component
 */
export function QueryView({
  allNodes,
  properties = [],
  tags = [],
  query: initialQuery,
  onQueryChange,
  onNodeClick,
  viewMode: initialViewMode = 'list',
  onViewModeChange,
  defaultCollapsed = false,
  className = '',
  title = 'Query',
}: QueryViewProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [queryMode, setQueryMode] = useState<'simple' | 'advanced'>(
    initialQuery?.type === 'datalog' ? 'advanced' : 'simple'
  );
  const [simpleQuery, setSimpleQuery] = useState<SimpleQuery>(
    initialQuery?.type === 'simple' ? initialQuery : {
      type: 'simple',
      logic: 'and',
      conditions: [],
      sortBy: 'name',
      sortOrder: 'asc',
      pagesOnly: true,
    }
  );
  const [datalogQuery, setDatalogQuery] = useState<DatalogQuery>(
    initialQuery?.type === 'datalog' ? initialQuery : {
      type: 'datalog',
      find: ['?node'],
      where: [],
    }
  );
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
  
  const currentQuery = queryMode === 'simple' ? simpleQuery : datalogQuery;
  
  const results = useMemo(
    () => executeQuery(currentQuery, allNodes, properties, tags),
    [currentQuery, allNodes, properties, tags]
  );
  
  const handleQueryChange = useCallback((query: Query) => {
    if (query.type === 'simple') {
      setSimpleQuery(query);
    } else {
      setDatalogQuery(query);
    }
    onQueryChange?.(query);
  }, [onQueryChange]);
  
  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    onViewModeChange?.(mode);
  }, [onViewModeChange]);
  
  return (
    <div className={`query-view ${className}`}>
      <div className="query-view__header">
        <Button 
          className="query-view__collapse-btn"
          variant="ghost"
          size="xs"
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          {isCollapsed ? '▶' : '▼'}
        </Button>
        <h3 className="query-view__title">{title}</h3>
        <span className="query-view__count">{results.length} results</span>
        
        <div className="query-view__header-controls">
          {/* Query mode toggle */}
          <div className="query-view__mode-toggle">
            <Button
              className="query-view__mode-btn"
              variant={queryMode === 'simple' ? 'default' : 'ghost'}
              size="sm"
              active={queryMode === 'simple'}
              onClick={() => setQueryMode('simple')}
            >
              Simple
            </Button>
            <Button
              className="query-view__mode-btn"
              variant={queryMode === 'advanced' ? 'default' : 'ghost'}
              size="sm"
              active={queryMode === 'advanced'}
              onClick={() => setQueryMode('advanced')}
            >
              Advanced
            </Button>
          </div>
          
          {/* View mode selector */}
          <select
            className="query-view__select"
            value={viewMode}
            onChange={(e) => handleViewModeChange(e.target.value as ViewMode)}
          >
            {VIEW_MODE_OPTIONS.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
      </div>
      
      {/* Query editor */}
      {!isCollapsed && (
        <div className="query-view__editor">
          {queryMode === 'simple' ? (
            <SimpleQueryEditor
              query={simpleQuery}
              properties={properties}
              tags={tags}
              onChange={(q) => handleQueryChange(q)}
            />
          ) : (
            <AdvancedQueryEditor
              query={datalogQuery}
              onChange={(q) => handleQueryChange(q)}
            />
          )}
        </div>
      )}
      
      {/* Results */}
      <div className="query-view__results">
        {results.length === 0 ? (
          <p className="query-view__no-results">No results found</p>
        ) : viewMode === 'list' ? (
          <ResultsList nodes={results} onNodeClick={onNodeClick} />
        ) : (
          <div className="query-view__view-placeholder">
            {/* Other view modes would render their respective components here */}
            <p>{results.length} nodes - {viewMode} view</p>
            <ResultsList nodes={results} onNodeClick={onNodeClick} />
          </div>
        )}
      </div>
    </div>
  );
}

export default QueryView;
