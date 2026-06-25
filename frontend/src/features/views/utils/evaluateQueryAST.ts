/**
 * Client-side QueryAST Evaluator for Graph Color Groups
 *
 * Evaluates a QueryAST against a single ApiGraphNode using local data.
 * Supports: class, property, content, page, parent, child, reference,
 * parent_path, child_path, reference_path conditions.
 *
 * Style and extends return false (content AST / full hierarchy
 * not available client-side).
 */

import type {
  QueryAST,
  GroupNode,
  ConditionNode,
  NotNode,
  PropertyOperator,
} from '@/types/queryAST';
import type { GraphNode as ApiGraphNode, GraphLink } from '@/api/nodes';
import { nodeNameToText } from '@/features/queries';
import type { Node } from '@/types';

// ==================== Types ====================

export interface EvalContext {
  /** All visible nodes for looking up related nodes */
  allNodes: ApiGraphNode[];
  /** Map for O(1) node lookup by UUID */
  nodeByUuid: Map<string, ApiGraphNode>;
  /** Links between visible nodes */
  links: GraphLink[];
  /** Parent relationships: childUuid -> parentUuids */
  parentMap: Map<string, string[]>;
  /** Child relationships: parentUuid -> childUuids */
  childMap: Map<string, string[]>;
  /** Reference relationships: sourceUuid -> targetUuids */
  referenceMap: Map<string, string[]>;
  /** Transitive ancestor closure: nodeUuid -> Set<ancestorUuids> */
  transitiveParentMap: Map<string, Set<string>>;
  /** Transitive descendant closure: nodeUuid -> Set<descendantUuids> */
  transitiveChildMap: Map<string, Set<string>>;
  /** Class hierarchy: classUuid -> Set<descendantClassUuids> (classes that extend this one) */
  classDescendants: Map<string, Set<string>>;
  /** All classes for name lookups */
  classes: Node[];
}

// ==================== Public API ====================

/**
 * Evaluate a QueryAST against a single node.
 * Returns true if the node matches the query.
 */
export function evaluateQueryAST(
  ast: QueryAST,
  node: ApiGraphNode,
  ctx: EvalContext,
): boolean {
  // Check scope first
  if (!evaluateScope(ast.scope, node)) {
    return false;
  }

  // Evaluate root group
  return evaluateGroup(ast.root_group, node, ctx);
}

/**
 * Build all indexes needed for fast evaluation from raw data.
 */
export function buildEvalContext(
  nodes: ApiGraphNode[],
  links: GraphLink[],
  classes: Node[],
): EvalContext {
  const nodeByUuid = new Map<string, ApiGraphNode>();
  for (const n of nodes) {
    nodeByUuid.set(n.uuid, n);
  }

  const parentMap = new Map<string, string[]>();
  const childMap = new Map<string, string[]>();
  const referenceMap = new Map<string, string[]>();

  for (const link of links) {
    if (link.type === 'parent') {
      // source is parent, target is child
      const parents = parentMap.get(link.target) ?? [];
      parents.push(link.source);
      parentMap.set(link.target, parents);

      const children = childMap.get(link.source) ?? [];
      children.push(link.target);
      childMap.set(link.source, children);
    } else if (link.type === 'reference') {
      const refs = referenceMap.get(link.source) ?? [];
      refs.push(link.target);
      referenceMap.set(link.source, refs);
    }
  }

  const transitiveParentMap = buildTransitiveClosure(parentMap);
  const transitiveChildMap = buildTransitiveClosure(childMap);

  const classDescendants = buildClassDescendants(classes, links);

  return {
    allNodes: nodes,
    nodeByUuid,
    links,
    parentMap,
    childMap,
    referenceMap,
    transitiveParentMap,
    transitiveChildMap,
    classDescendants,
    classes,
  };
}

// ==================== Scope Evaluation ====================

function evaluateScope(
  scope: { scope_type: string; excluded_page_uuids?: string[] },
  node: ApiGraphNode,
): boolean {
  switch (scope.scope_type) {
    case 'entire_workspace':
      return true;
    case 'pages':
      return node.type === 'page' || node.type === undefined;
    case 'current_page':
      // Not applicable for graph coloring; treat as pages
      return node.type === 'page' || node.type === undefined;
    default:
      return true;
  }
}

// ==================== Group / NOT Evaluation ====================

function evaluateGroup(group: GroupNode, node: ApiGraphNode, ctx: EvalContext): boolean {
  if (!group.children || group.children.length === 0) {
    return true; // Empty group matches everything
  }

  if (group.logic === 'AND') {
    return group.children.every(child => evaluateNode(child, node, ctx));
  } else {
    return group.children.some(child => evaluateNode(child, node, ctx));
  }
}

function evaluateNot(notNode: NotNode, node: ApiGraphNode, ctx: EvalContext): boolean {
  return !evaluateNode(notNode.child, node, ctx);
}

function evaluateNode(
  node: ConditionNode | GroupNode | NotNode,
  apiNode: ApiGraphNode,
  ctx: EvalContext,
): boolean {
  if (node.type === 'group') {
    return evaluateGroup(node, apiNode, ctx);
  }
  if (node.type === 'not') {
    return evaluateNot(node, apiNode, ctx);
  }
  return evaluateCondition(node, apiNode, ctx);
}

// ==================== Condition Evaluation ====================

function evaluateCondition(condition: ConditionNode, node: ApiGraphNode, ctx: EvalContext): boolean {
  switch (condition.condition_type) {
    case 'class':
      return evaluateClassCondition(condition, node, ctx);
    case 'property':
      return evaluatePropertyCondition(condition, node);
    case 'content':
      return evaluateContentCondition(condition, node);
    case 'page':
      return evaluatePageCondition(condition, node);
    case 'parent':
      return evaluateParentCondition(condition, node, ctx);
    case 'parent_path':
      return evaluateParentPathCondition(condition, node, ctx);
    case 'child':
      return evaluateChildCondition(condition, node, ctx);
    case 'child_path':
      return evaluateChildPathCondition(condition, node, ctx);
    case 'reference':
      return evaluateReferenceCondition(condition, node, ctx);
    case 'reference_path':
      return evaluateReferencePathCondition(condition, node, ctx);
    case 'extends':
      return evaluateExtendsCondition(condition, node, ctx);
    case 'style':
      // Content AST not available client-side
      return false;
    default:
      return false;
  }
}

// ----- Class -----

function resolveClassUuid(raw: string | number | undefined, ctx: EvalContext): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw;
  return ctx.classes.find(c => c.id === raw)?.uuid;
}

function getNodeClassUuids(node: ApiGraphNode, ctx: EvalContext): string[] {
  if (node.class_uuids) return node.class_uuids;
  if (node.class_ids) {
    return node.class_ids
      .map(id => ctx.classes.find(c => c.id === id)?.uuid)
      .filter((uuid): uuid is string => !!uuid);
  }
  return [];
}

function evaluateClassCondition(
  cond: Extract<ConditionNode, { condition_type: 'class' }>,
  node: ApiGraphNode,
  ctx: EvalContext,
): boolean {
  const nodeClassUuids = getNodeClassUuids(node, ctx);
  const targetUuid = resolveClassUuid(cond.class_uuid ?? cond.class_id, ctx);

  if (!targetUuid) return false;

  const op = cond.operator ?? 'contains';

  // Direct class membership
  const hasDirectClass = nodeClassUuids.includes(targetUuid);

  // Inherited class membership: check if any of the node's classes extend the target
  const descendants = ctx.classDescendants.get(targetUuid);
  const hasDescendantClass = descendants
    ? nodeClassUuids.some(cid => descendants.has(cid))
    : false;

  const hasClass = hasDirectClass || hasDescendantClass;

  switch (op) {
    case 'is':
      return hasClass && nodeClassUuids.length === 1;
    case 'is_not':
      return !hasClass;
    case 'contains':
      return hasClass;
    case 'does_not_contain':
      return !hasClass;
    case 'defined':
      return nodeClassUuids.length > 0;
    case 'not_defined':
      return nodeClassUuids.length === 0;
    default:
      return hasClass;
  }
}

// ----- Extends -----

function evaluateExtendsCondition(
  cond: Extract<ConditionNode, { condition_type: 'extends' }>,
  node: ApiGraphNode,
  ctx: EvalContext,
): boolean {
  const nodeClassUuids = getNodeClassUuids(node, ctx);
  const targetUuid = resolveClassUuid(cond.extends_class_uuid ?? cond.extends_class_id, ctx);

  if (!targetUuid) return false;

  // Check if any of the node's classes are descendants of the target class
  const descendants = ctx.classDescendants.get(targetUuid);
  if (!descendants) return false;

  return nodeClassUuids.some(cid => cid === targetUuid || descendants.has(cid));
}

// ----- Property -----

function evaluatePropertyCondition(
  cond: Extract<ConditionNode, { condition_type: 'property' }>,
  node: ApiGraphNode,
): boolean {
  const value = node.properties?.[cond.property_name];
  return evaluateOperator(cond.operator, value, cond.value);
}

// ----- Content -----

function evaluateContentCondition(
  cond: Extract<ConditionNode, { condition_type: 'content' }>,
  node: ApiGraphNode,
): boolean {
  const text = nodeNameToText(node.name) ?? '';
  const targetValue = cond.value ?? '';
  const caseSensitive = cond.case_sensitive ?? false;

  const lhs = caseSensitive ? text : text.toLowerCase();
  const rhs = caseSensitive ? targetValue : targetValue.toLowerCase();

  switch (cond.operator) {
    case 'contains':
      return lhs.includes(rhs);
    case 'starts_with':
      return lhs.startsWith(rhs);
    case 'ends_with':
      return lhs.endsWith(rhs);
    case 'equals':
      return lhs === rhs;
    case 'regex':
      try {
        const flags = caseSensitive ? '' : 'i';
        return new RegExp(rhs, flags).test(text);
      } catch {
        return false;
      }
    case 'fts': {
      // Simple full-text search: all words must be present
      const words = rhs.split(/\s+/).filter(w => w.length > 0);
      if (words.length === 0) return true;
      return words.every(w => lhs.includes(w));
    }
    default:
      return lhs.includes(rhs);
  }
}

// ----- Page -----

function evaluatePageCondition(
  cond: Extract<ConditionNode, { condition_type: 'page' }>,
  node: ApiGraphNode,
): boolean {
  const op = cond.operator ?? 'is_page';
  const isPage = node.type === 'page' || node.type === undefined;

  switch (op) {
    case 'is_page':
      return isPage;
    case 'is_not_page':
      return !isPage;
    case 'has_no_page':
      return false; // All nodes have a page; not evaluable client-side
    case 'has_any_page':
      return true;
    default:
      return isPage;
  }
}

// ----- Parent -----

function evaluateParentCondition(
  cond: Extract<ConditionNode, { condition_type: 'parent' }>,
  node: ApiGraphNode,
  ctx: EvalContext,
): boolean {
  const op = cond.operator ?? 'has_parent';
  const parentUuids = ctx.parentMap.get(node.uuid) ?? [];

  switch (op) {
    case 'has_no_parent':
      return parentUuids.length === 0;
    case 'has_any_parent':
      return parentUuids.length > 0;
    case 'not_has_parent': {
      // Static mode: check specific parents
      if (cond.parent_uuids && cond.parent_uuids.length > 0) {
        return !cond.parent_uuids.some(uuid => parentUuids.includes(uuid));
      }
      if (cond.parent_ids && cond.parent_ids.length > 0) {
        return !cond.parent_ids.some(pid => {
          const uuid = ctx.nodeByUuid.get(String(pid))?.uuid ?? ctx.classes.find(c => c.id === pid)?.uuid;
          return uuid && parentUuids.includes(uuid);
        });
      }
      return parentUuids.length === 0;
    }
    case 'has_parent': {
      // Dynamic mode: evaluate nested group against each parent
      if (cond.nested_group) {
        return parentUuids.some(uuid => {
          const parent = ctx.nodeByUuid.get(uuid);
          return parent && evaluateGroup(cond.nested_group!, parent, ctx);
        });
      }
      // Static mode
      if (cond.parent_uuids && cond.parent_uuids.length > 0) {
        return cond.parent_uuids.some(uuid => parentUuids.includes(uuid));
      }
      if (cond.parent_ids && cond.parent_ids.length > 0) {
        return cond.parent_ids.some(pid => {
          const uuid = ctx.nodeByUuid.get(String(pid))?.uuid ?? ctx.classes.find(c => c.id === pid)?.uuid;
          return uuid && parentUuids.includes(uuid);
        });
      }
      return parentUuids.length > 0;
    }
    default:
      return parentUuids.length > 0;
  }
}

// ----- Parent Path -----

function evaluateParentPathCondition(
  cond: Extract<ConditionNode, { condition_type: 'parent_path' }>,
  node: ApiGraphNode,
  ctx: EvalContext,
): boolean {
  const op = cond.operator ?? 'has_ancestor';
  const ancestors = ctx.transitiveParentMap.get(node.uuid) ?? new Set<string>();

  switch (op) {
    case 'has_no_ancestor':
      return ancestors.size === 0;
    case 'has_any_ancestor':
      return ancestors.size > 0;
    case 'not_has_ancestor': {
      if (cond.ancestor_uuids && cond.ancestor_uuids.length > 0) {
        return !cond.ancestor_uuids.some(uuid => ancestors.has(uuid));
      }
      if (cond.ancestor_ids && cond.ancestor_ids.length > 0) {
        return !cond.ancestor_ids.some(aid => {
          const uuid = ctx.nodeByUuid.get(String(aid))?.uuid ?? ctx.classes.find(c => c.id === aid)?.uuid;
          return uuid && ancestors.has(uuid);
        });
      }
      return ancestors.size === 0;
    }
    case 'has_ancestor': {
      if (cond.nested_group) {
        return Array.from(ancestors).some(uuid => {
          const ancestor = ctx.nodeByUuid.get(uuid);
          return ancestor && evaluateGroup(cond.nested_group!, ancestor, ctx);
        });
      }
      if (cond.ancestor_uuids && cond.ancestor_uuids.length > 0) {
        return cond.ancestor_uuids.some(uuid => ancestors.has(uuid));
      }
      if (cond.ancestor_ids && cond.ancestor_ids.length > 0) {
        return cond.ancestor_ids.some(aid => {
          const uuid = ctx.nodeByUuid.get(String(aid))?.uuid ?? ctx.classes.find(c => c.id === aid)?.uuid;
          return uuid && ancestors.has(uuid);
        });
      }
      return ancestors.size > 0;
    }
    default:
      return ancestors.size > 0;
  }
}

// ----- Child -----

function evaluateChildCondition(
  cond: Extract<ConditionNode, { condition_type: 'child' }>,
  node: ApiGraphNode,
  ctx: EvalContext,
): boolean {
  const op = cond.operator ?? 'has_child';
  const childUuids = ctx.childMap.get(node.uuid) ?? [];

  switch (op) {
    case 'has_no_child':
      return childUuids.length === 0;
    case 'has_any_child':
      return childUuids.length > 0;
    case 'not_has_child': {
      if (cond.child_uuids && cond.child_uuids.length > 0) {
        return !cond.child_uuids.some(uuid => childUuids.includes(uuid));
      }
      if (cond.child_ids && cond.child_ids.length > 0) {
        return !cond.child_ids.some(cid => {
          const uuid = ctx.nodeByUuid.get(String(cid))?.uuid ?? ctx.classes.find(c => c.id === cid)?.uuid;
          return uuid && childUuids.includes(uuid);
        });
      }
      return childUuids.length === 0;
    }
    case 'has_child': {
      if (cond.nested_group) {
        return childUuids.some(uuid => {
          const child = ctx.nodeByUuid.get(uuid);
          return child && evaluateGroup(cond.nested_group!, child, ctx);
        });
      }
      if (cond.child_uuids && cond.child_uuids.length > 0) {
        return cond.child_uuids.some(uuid => childUuids.includes(uuid));
      }
      if (cond.child_ids && cond.child_ids.length > 0) {
        return cond.child_ids.some(cid => {
          const uuid = ctx.nodeByUuid.get(String(cid))?.uuid ?? ctx.classes.find(c => c.id === cid)?.uuid;
          return uuid && childUuids.includes(uuid);
        });
      }
      return childUuids.length > 0;
    }
    default:
      return childUuids.length > 0;
  }
}

// ----- Child Path -----

function evaluateChildPathCondition(
  cond: Extract<ConditionNode, { condition_type: 'child_path' }>,
  node: ApiGraphNode,
  ctx: EvalContext,
): boolean {
  const op = cond.operator ?? 'has_descendant';
  const descendants = ctx.transitiveChildMap.get(node.uuid) ?? new Set<string>();

  switch (op) {
    case 'has_no_descendant':
      return descendants.size === 0;
    case 'has_any_descendant':
      return descendants.size > 0;
    case 'not_has_descendant': {
      if (cond.descendant_uuids && cond.descendant_uuids.length > 0) {
        return !cond.descendant_uuids.some(uuid => descendants.has(uuid));
      }
      if (cond.descendant_ids && cond.descendant_ids.length > 0) {
        return !cond.descendant_ids.some(did => {
          const uuid = ctx.nodeByUuid.get(String(did))?.uuid ?? ctx.classes.find(c => c.id === did)?.uuid;
          return uuid && descendants.has(uuid);
        });
      }
      return descendants.size === 0;
    }
    case 'has_descendant': {
      if (cond.nested_group) {
        return Array.from(descendants).some(uuid => {
          const descendant = ctx.nodeByUuid.get(uuid);
          return descendant && evaluateGroup(cond.nested_group!, descendant, ctx);
        });
      }
      if (cond.descendant_uuids && cond.descendant_uuids.length > 0) {
        return cond.descendant_uuids.some(uuid => descendants.has(uuid));
      }
      if (cond.descendant_ids && cond.descendant_ids.length > 0) {
        return cond.descendant_ids.some(did => {
          const uuid = ctx.nodeByUuid.get(String(did))?.uuid ?? ctx.classes.find(c => c.id === did)?.uuid;
          return uuid && descendants.has(uuid);
        });
      }
      return descendants.size > 0;
    }
    default:
      return descendants.size > 0;
  }
}

// ----- Reference -----

function evaluateReferenceCondition(
  cond: Extract<ConditionNode, { condition_type: 'reference' }>,
  node: ApiGraphNode,
  ctx: EvalContext,
): boolean {
  const op = cond.operator ?? 'references';
  const refs = ctx.referenceMap.get(node.uuid) ?? [];

  switch (op) {
    case 'has_no_references':
      return refs.length === 0;
    case 'has_references':
      return refs.length > 0;
    case 'does_not_reference': {
      if (cond.target_uuid) {
        return !refs.includes(cond.target_uuid);
      }
      if (cond.target_uuids && cond.target_uuids.length > 0) {
        return !cond.target_uuids.some(uuid => refs.includes(uuid));
      }
      if (cond.target_id) {
        const targetUuid = ctx.nodeByUuid.get(String(cond.target_id))?.uuid ?? ctx.classes.find(c => c.id === cond.target_id)?.uuid;
        return targetUuid ? !refs.includes(targetUuid) : refs.length === 0;
      }
      return refs.length === 0;
    }
    case 'references': {
      if (cond.nested_group) {
        return refs.some(uuid => {
          const target = ctx.nodeByUuid.get(uuid);
          return target && evaluateGroup(cond.nested_group!, target, ctx);
        });
      }
      if (cond.target_uuid) {
        return refs.includes(cond.target_uuid);
      }
      if (cond.target_uuids && cond.target_uuids.length > 0) {
        return cond.target_uuids.some(uuid => refs.includes(uuid));
      }
      if (cond.target_id) {
        const targetUuid = ctx.nodeByUuid.get(String(cond.target_id))?.uuid ?? ctx.classes.find(c => c.id === cond.target_id)?.uuid;
        return targetUuid ? refs.includes(targetUuid) : false;
      }
      return refs.length > 0;
    }
    default:
      return refs.length > 0;
  }
}

// ----- Reference Path -----

function evaluateReferencePathCondition(
  cond: Extract<ConditionNode, { condition_type: 'reference_path' }>,
  node: ApiGraphNode,
  ctx: EvalContext,
): boolean {
  // reference_path requires transitive reference closure which we don't pre-compute
  // For now, evaluate against direct references only as an approximation
  const refs = ctx.referenceMap.get(node.uuid) ?? [];

  if (cond.nested_group) {
    return refs.some(uuid => {
      const target = ctx.nodeByUuid.get(uuid);
      return target && evaluateGroup(cond.nested_group!, target, ctx);
    });
  }

  if (cond.target_uuids && cond.target_uuids.length > 0) {
    return cond.target_uuids.some(uuid => refs.includes(uuid));
  }

  if (cond.target_ids && cond.target_ids.length > 0) {
    return cond.target_ids.some((tid: number) => {
      const uuid = ctx.nodeByUuid.get(String(tid))?.uuid ?? ctx.classes.find(c => c.id === tid)?.uuid;
      return uuid && refs.includes(uuid);
    });
  }

  return refs.length > 0;
}

// ==================== Operator Evaluation ====================

function evaluateOperator(
  operator: PropertyOperator,
  actual: unknown,
  expected: unknown,
): boolean {
  // Handle null/undefined
  const isEmpty = actual === null || actual === undefined || actual === '';

  switch (operator) {
    case 'is_empty':
      return isEmpty;
    case 'is_not_empty':
      return !isEmpty;
  }

  if (isEmpty) return false;

  switch (operator) {
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'greater_than':
      return Number(actual) > Number(expected);
    case 'less_than':
      return Number(actual) < Number(expected);
    case 'gte':
      return Number(actual) >= Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    case 'contains': {
      const actualStr = String(actual).toLowerCase();
      const expectedStr = String(expected).toLowerCase();
      return actualStr.includes(expectedStr);
    }
    case 'starts_with': {
      const actualStr = String(actual).toLowerCase();
      const expectedStr = String(expected).toLowerCase();
      return actualStr.startsWith(expectedStr);
    }
    case 'ends_with': {
      const actualStr = String(actual).toLowerCase();
      const expectedStr = String(expected).toLowerCase();
      return actualStr.endsWith(expectedStr);
    }
    case 'in': {
      const expectedArray = Array.isArray(expected) ? expected : [expected];
      return expectedArray.some(v => v === actual);
    }
    case 'not_in': {
      const expectedArray = Array.isArray(expected) ? expected : [expected];
      return !expectedArray.some(v => v === actual);
    }
    default:
      return false;
  }
}

// ==================== Helper: Transitive Closure ====================

function buildTransitiveClosure(directMap: Map<string, string[]>): Map<string, Set<string>> {
  const closure = new Map<string, Set<string>>();

  for (const [nodeUuid] of directMap) {
    const visited = new Set<string>();
    const queue = [...(directMap.get(nodeUuid) ?? [])];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const next = directMap.get(current) ?? [];
      for (const n of next) {
        if (!visited.has(n)) queue.push(n);
      }
    }

    closure.set(nodeUuid, visited);
  }

  return closure;
}

// ==================== Helper: Class Descendants ====================

function buildClassDescendants(classes: Node[], links: GraphLink[]): Map<string, Set<string>> {
  const descendants = new Map<string, Set<string>>();

  // Collect all class UUIDs involved in the hierarchy
  const allClassUuids = new Set<string>();
  for (const cls of classes) {
    if (cls.uuid) allClassUuids.add(cls.uuid);
  }
  for (const link of links) {
    if (link.type === 'extends') {
      allClassUuids.add(link.source);
      allClassUuids.add(link.target);
    }
  }

  // Initialize empty sets
  for (const uuid of allClassUuids) {
    descendants.set(uuid, new Set());
  }

  // Build direct parent -> child relationships
  const children = new Map<string, string[]>();

  // From class nodes' own classes (if available)
  for (const cls of classes) {
    const classUuids = cls.classes_uuid ?? cls.classes?.map(id => classes.find(c => c.id === id)?.uuid).filter((uuid): uuid is string => !!uuid) ?? [];
    for (const parentUuid of classUuids) {
      const siblings = children.get(parentUuid) ?? [];
      siblings.push(cls.uuid);
      children.set(parentUuid, siblings);
    }
  }

  // From extends links (source is child, target is parent)
  for (const link of links) {
    if (link.type === 'extends') {
      const siblings = children.get(link.target) ?? [];
      if (!siblings.includes(link.source)) {
        siblings.push(link.source);
      }
      children.set(link.target, siblings);
    }
  }

  // Compute transitive closure for each class
  for (const [classUuid] of descendants) {
    const visited = new Set<string>();
    const queue = [...(children.get(classUuid) ?? [])];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const next = children.get(current) ?? [];
      for (const n of next) {
        if (!visited.has(n)) queue.push(n);
      }
    }

    descendants.set(classUuid, visited);
  }

  return descendants;
}
