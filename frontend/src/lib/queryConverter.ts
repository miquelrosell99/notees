/**
 * Query AST Converters
 * 
 * @deprecated This converter is maintained for backward compatibility only.
 * New code should use QueryAST directly without conversion.
 * 
 * Bidirectional converters between QueryBlockTree (legacy) and QueryAST (new).
 * Maintains backward compatibility while enabling new AST-based features.
 * 
 * Migration path:
 * 1. Update all components to work directly with QueryAST
 * 2. Update API endpoints to accept/return QueryAST
 * 3. Remove this converter once all usage is migrated
 */

import type {
  QueryBlock,
  QueryBlockTree,
  ContainerBlock,
  NotBlock,
  ClassBlock,
  PropertyBlock,
  ContentBlock,
  ReferenceBlock,
  ReferencePathBlock,
  ParentBlock,
  ParentPathBlock,
  ChildBlock,
  ChildPathBlock,
  ClassPathBlock,
  UuidBlock,
} from '@/types/query';

import type {
  QueryAST,
  ScopeNode,
  GroupNode,
  NotNode as ASTNotNode,
  ConditionNode,
  ClassCondition,
  PropertyCondition,
  ContentCondition,
  ReferenceCondition,
  ReferencePathCondition,
  ParentCondition,
  ParentPathCondition,
  ChildCondition,
  ChildPathCondition,
  ClassPathCondition,
} from '@/types/queryAST';

// Helper factory functions
function createEmptyQueryAST(): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    scope: createScopeNode(),
    root_group: createGroupNode(),
  };
}

function createScopeNode(): ScopeNode {
  return {
    type: 'scope',
    scope_type: 'all',
  };
}

function createGroupNode(): GroupNode {
  return {
    type: 'group',
    logic: 'AND',
    children: [],
  };
}

// ==================== BlockTree → AST ====================

/**
 * Convert QueryBlockTree to QueryAST
 * 
 * This is the primary conversion used when loading existing queries.
 */
export function blockTreeToAST(blockTree: QueryBlockTree, queryId?: string, isSystem?: boolean): QueryAST {
  const ast = createEmptyQueryAST();
  
  // Set query identity
  if (queryId) {
    ast.id = queryId;
  }
  ast.updated_at = new Date().toISOString();
  
  // Mark as system query if specified
  if (isSystem) {
    ast.is_system = true;
  }
  
  // Load scope from metadata (defaults to entire_graph, not current_page)
  if (blockTree.scope) {
    ast.scope = {
      type: 'scope',
      scope_type: blockTree.scope.scope_type,
    };
  } else {
    // Default to all for backward compatibility
    ast.scope = {
      type: 'scope',
      scope_type: 'all',
    };
  }
  
  // Convert blocks to conditions (no scope extraction needed)
  ast.root_group = {
    type: 'group',
    logic: blockTree.type === 'AND_CONTAINER' ? 'AND' : 'OR',
    children: blockTree.blocks.map(block => convertBlockToASTNode(block)),
  };
  
  return ast;
}

/**
 * Extract scope information from blocks
 * Returns the scope node and blocks that are NOT part of scope
 */
function extractScope(blocks: QueryBlock[], isSystem?: boolean): { scope: ScopeNode; filteredBlocks: QueryBlock[] } {
  const pageUuids: string[] = [];
  const excludedPageUuids: string[] = [];
  const nonScopeBlocks: QueryBlock[] = [];
  let hasReferenceBlock = false;
  
  for (const block of blocks) {
    // Check if this is a REFERENCE block (linked_references use entire_graph scope)
    if (block.type === 'REFERENCE') {
      hasReferenceBlock = true;
    }
    
    // Look for PARENT_PATH blocks with UUID children (page scope)
    if (block.type === 'PARENT_PATH') {
      const parentPathBlock = block as ParentPathBlock;
      const uuidBlock = parentPathBlock.blocks?.find(b => b.type === 'UUID') as UuidBlock | undefined;
      
      if (uuidBlock?.value && !uuidBlock.value.startsWith('{')) {
        pageUuids.push(uuidBlock.value);
        continue; // Don't include in filtered blocks
      }
    }
    // Look for NOT(PARENT_PATH) blocks (excluded pages)
    else if (block.type === 'NOT_CONTAINER') {
      const notBlock = block as NotBlock;
      if (notBlock.block?.type === 'PARENT_PATH') {
        const parentPathBlock = notBlock.block as ParentPathBlock;
        const uuidBlock = parentPathBlock.blocks?.find(b => b.type === 'UUID') as UuidBlock | undefined;
        
        if (uuidBlock?.value && !uuidBlock.value.startsWith('{')) {
          excludedPageUuids.push(uuidBlock.value);
          continue; // Don't include in filtered blocks
        }
      }
    }
    
    // Not a scope block, keep it
    nonScopeBlocks.push(block);
  }
  
  // Determine scope type
  let scopeType: ScopeNode['scope_type'] = 'current_page';
  
  if (pageUuids.length > 0) {
    scopeType = 'specific_pages';
  }
  // Note: We no longer force entire_graph based on REFERENCE blocks
  // The scope should be independently configurable regardless of conditions
  
  const scope: ScopeNode = {
    type: 'scope',
    scope_type: scopeType,
    page_uuids: pageUuids.length > 0 ? pageUuids : undefined,
    excluded_page_uuids: excludedPageUuids.length > 0 ? excludedPageUuids : undefined,
    include_descendants: true,
  };
  
  return { scope, filteredBlocks: nonScopeBlocks };
}

/**
 * Convert a QueryBlock to an AST node
 */
function convertBlockToASTNode(block: QueryBlock): ConditionNode | GroupNode | ASTNotNode {
  switch (block.type) {
    case 'AND_CONTAINER':
    case 'OR_CONTAINER': {
      const container = block as ContainerBlock;
      return {
        type: 'group',
        logic: block.type === 'AND_CONTAINER' ? 'AND' : 'OR',
        children: container.blocks.map(b => convertBlockToASTNode(b)),
      };
    }
    
    case 'NOT_CONTAINER': {
      const notBlock = block as NotBlock;
      if (!notBlock.block) {
        throw new Error('NOT_CONTAINER must have a child block');
      }
      return {
        type: 'not',
        child: convertBlockToASTNode(notBlock.block) as ConditionNode | GroupNode,
      };
    }
    
    case 'CLASS': {
      const classBlock = block as ClassBlock;
      // Handle both legacy type_id and new class_id for backward compatibility
      const classId = classBlock.class_id ?? classBlock.type_id ?? (block as any).class_id ?? (block as any).type_id;
      const condition: ClassCondition = {
        type: 'condition',
        condition_type: 'class',
        class_uuid: classBlock.value,
        class_id: classId,
        class_uuids: (classBlock as any).class_uuids, // Support dynamic mode
        operator: (classBlock as any).operator,
      };
      // Preserve isSystemNode flag
      if (classBlock.isSystemNode) {
        (condition as any).__isSystemNode = true;
      }
      return condition;
    }
    
    case 'PROPERTY': {
      const propBlock = block as PropertyBlock;
      const condition: PropertyCondition = {
        type: 'condition',
        condition_type: 'property',
        property_name: propBlock.property_name,
        property_id: propBlock.property_id,
        property_type: propBlock.property_type,
        operator: propBlock.operator,
        value: propBlock.value,
      };
      // Preserve isSystemNode flag
      if (propBlock.isSystemNode) {
        (condition as any).__isSystemNode = true;
      }
      return condition;
    }
    
    case 'CONTENT': {
      const contentBlock = block as ContentBlock;
      return {
        type: 'condition',
        condition_type: 'content',
        operator: contentBlock.operator,
        value: contentBlock.value,
        case_sensitive: contentBlock.case_sensitive,
      } as ContentCondition;
    }
    
    case 'REFERENCE': {
      const refBlock = block as ReferenceBlock;
      const condition: ReferenceCondition = {
        type: 'condition',
        condition_type: 'reference',
        target_uuid: refBlock.target_uuid,
        target_id: refBlock.target_id,
        target_uuids: (refBlock as any).target_uuids, // Support dynamic mode
        operator: (refBlock as any).operator,
      };
      
      // Preserve isSystemNode flag
      if (refBlock.isSystemNode) {
        (condition as any).__isSystemNode = true;
      }
      
      if (refBlock.blocks && refBlock.blocks.length > 0) {
        condition.nested_group = {
          type: 'group',
          logic: 'AND',
          children: refBlock.blocks.map(b => convertBlockToASTNode(b)),
        };
      }
      
      return condition;
    }
    
    case 'REFERENCE_PATH': {
      const refPathBlock = block as ReferencePathBlock;
      return {
        type: 'condition',
        condition_type: 'reference_path',
        nested_group: {
          type: 'group',
          logic: 'AND',
          children: refPathBlock.blocks.map(b => convertBlockToASTNode(b)),
        },
      } as ReferencePathCondition;
    }
    
    case 'PARENT': {
      const parentBlock = block as ParentBlock;
      const condition: ParentCondition = {
        type: 'condition',
        condition_type: 'parent',
        nested_group: {
          type: 'group',
          logic: 'AND',
          children: parentBlock.blocks.map(b => convertBlockToASTNode(b)),
        },
      };
      // Preserve isSystemNode flag
      if (parentBlock.isSystemNode) {
        (condition as any).__isSystemNode = true;
      }
      return condition;
    }
    
    case 'PARENT_PATH': {
      const parentPathBlock = block as ParentPathBlock;
      return {
        type: 'condition',
        condition_type: 'parent_path',
        nested_group: {
          type: 'group',
          logic: 'AND',
          children: parentPathBlock.blocks.map(b => convertBlockToASTNode(b)),
        },
        max_depth: parentPathBlock.max_depth,
      } as ParentPathCondition;
    }
    
    case 'CHILD': {
      const childBlock = block as ChildBlock;
      return {
        type: 'condition',
        condition_type: 'child',
        nested_group: {
          type: 'group',
          logic: 'AND',
          children: childBlock.blocks.map(b => convertBlockToASTNode(b)),
        },
      } as ChildCondition;
    }
    
    case 'CHILD_PATH': {
      const childPathBlock = block as ChildPathBlock;
      const condition: ChildPathCondition = {
        type: 'condition',
        condition_type: 'child_path',
        nested_group: {
          type: 'group',
          logic: 'AND',
          children: childPathBlock.blocks.map(b => convertBlockToASTNode(b)),
        },
        max_depth: childPathBlock.max_depth,
      };
      // Preserve isSystemNode flag
      if (childPathBlock.isSystemNode) {
        (condition as any).__isSystemNode = true;
      }
      return condition;
    }
    
    case 'CLASS_PATH': {
      const classPathBlock = block as ClassPathBlock;
      return {
        type: 'condition',
        condition_type: 'class_path',
        nested_group: {
          type: 'group',
          logic: 'AND',
          children: classPathBlock.blocks.map(b => convertBlockToASTNode(b)),
        },
      } as ClassPathCondition;
    }
    
    case 'UUID': {
      const uuidBlock = block as UuidBlock;
      // UUID blocks are used for exact node matching, typically with placeholders like {current_node_uuid}
      // We'll convert them to property conditions on uuid field
      return {
        type: 'condition',
        condition_type: 'property',
        property_name: 'uuid',
        property_type: 'text',
        operator: 'equals',
        value: uuidBlock.value,
      } as PropertyCondition;
    }
    
    default:
      throw new Error(`Unknown block type: ${(block as QueryBlock).type}`);
  }
}

// ==================== AST → BlockTree ====================

/**
 * Convert QueryAST back to QueryBlockTree
 * 
 * This maintains backward compatibility with the backend.
 */
export function astToBlockTree(ast: QueryAST): QueryBlockTree {
  // Convert root group children to blocks (scope is stored separately)
  // Safety check for children array
  const children = Array.isArray(ast.root_group.children) ? ast.root_group.children : [];
  const conditionBlocks = children.map(child => convertASTNodeToBlock(child));
  
  return {
    type: ast.root_group.logic === 'AND' ? 'AND_CONTAINER' : 'OR_CONTAINER',
    blocks: conditionBlocks,
    // Store scope separately in metadata
    scope: {
      scope_type: ast.scope.scope_type,
    },
  };
}

/**
 * Convert scope node to blocks
 */
function scopeToBlocks(scope: ScopeNode): QueryBlock[] {
  const blocks: QueryBlock[] = [];
  
  // Handle current_page scope with runtime parameter
  if (scope.scope_type === 'current_page') {
    blocks.push({
      type: 'PARENT_PATH',
      blocks: [{ type: 'UUID', value: '{current_node_uuid}' }],
    } as ParentPathBlock);
  }
  
  // Add included pages as PARENT_PATH blocks
  if (scope.page_uuids && scope.page_uuids.length > 0) {
    for (const uuid of scope.page_uuids) {
      blocks.push({
        type: 'PARENT_PATH',
        blocks: [{ type: 'UUID', value: uuid }],
      } as ParentPathBlock);
    }
  }
  
  // Add excluded pages as NOT(PARENT_PATH) blocks
  if (scope.excluded_page_uuids && scope.excluded_page_uuids.length > 0) {
    for (const uuid of scope.excluded_page_uuids) {
      blocks.push({
        type: 'NOT_CONTAINER',
        block: {
          type: 'PARENT_PATH',
          blocks: [{ type: 'UUID', value: uuid }],
        } as ParentPathBlock,
      } as NotBlock);
    }
  }
  
  return blocks;
}

/**
 * Convert an AST node back to a QueryBlock
 */
function convertASTNodeToBlock(node: ConditionNode | GroupNode | ASTNotNode): QueryBlock {
  if (node.type === 'group') {
    const groupNode = node as GroupNode;
    return {
      type: groupNode.logic === 'AND' ? 'AND_CONTAINER' : 'OR_CONTAINER',
      blocks: groupNode.children.map(child => convertASTNodeToBlock(child)),
    } as ContainerBlock;
  }
  
  if (node.type === 'not') {
    const notNode = node as ASTNotNode;
    return {
      type: 'NOT_CONTAINER',
      block: convertASTNodeToBlock(notNode.child),
    } as NotBlock;
  }
  
  // Must be a condition
  const condition = node as ConditionNode;
  
  switch (condition.condition_type) {
    case 'class': {
      const classCond = condition as ClassCondition;
      
      // For 'defined' and 'not_defined', we use a CLASS block with empty value
      // to check if ANY class is assigned (backend should interpret empty value as "any class")
      const classBlock: any = {
        type: 'CLASS',
        value: classCond.operator === 'defined' || classCond.operator === 'not_defined' ? '' : classCond.class_uuid,
        class_id: classCond.operator === 'defined' || classCond.operator === 'not_defined' ? undefined : classCond.class_id,
        class_uuid: classCond.class_uuid,
        operator: classCond.operator,
        class_uuids: classCond.class_uuids, // Support dynamic mode
      };
      
      // If operator is negative, wrap in NOT_CONTAINER
      if (classCond.operator === 'is_not' || classCond.operator === 'does_not_contain' || classCond.operator === 'not_defined') {
        return {
          type: 'NOT_CONTAINER',
          block: classBlock,
        } as NotBlock;
      }
      
      // For 'is', 'contains', 'defined' (or default), return CLASS block directly
      return classBlock;
    }
    
    case 'property': {
      const propCond = condition as PropertyCondition;
      return {
        type: 'PROPERTY',
        property_name: propCond.property_name,
        property_id: propCond.property_id,
        property_type: propCond.property_type,
        operator: propCond.operator,
        value: propCond.value,
      } as PropertyBlock;
    }
    
    case 'content': {
      const contentCond = condition as ContentCondition;
      return {
        type: 'CONTENT',
        operator: contentCond.operator,
        value: contentCond.value,
        case_sensitive: contentCond.case_sensitive,
      } as ContentBlock;
    }
    
    case 'reference': {
      const refCond = condition as ReferenceCondition;
      const operator = refCond.operator || 'references';
      
      const refBlock: any = {
        type: 'REFERENCE',
        target_uuid: operator === 'has_references' || operator === 'has_no_references' ? '' : refCond.target_uuid,
        target_id: operator === 'has_references' || operator === 'has_no_references' ? undefined : refCond.target_id,
        operator: refCond.operator,
        target_uuids: refCond.target_uuids, // Support dynamic mode
      };
      
      if (refCond.nested_group) {
        refBlock.blocks = refCond.nested_group.children.map(child => convertASTNodeToBlock(child));
      }
      
      // Wrap in NOT_CONTAINER for negative operators
      if (operator === 'does_not_reference' || operator === 'has_no_references') {
        return {
          type: 'NOT_CONTAINER',
          block: refBlock,
        } as NotBlock;
      }
      
      return refBlock;
    }
    
    case 'reference_path': {
      const refPathCond = condition as ReferencePathCondition;
      return {
        type: 'REFERENCE_PATH',
        blocks: refPathCond.nested_group.children.map(child => convertASTNodeToBlock(child)),
      } as ReferencePathBlock;
    }
    
    case 'parent': {
      const parentCond = condition as ParentCondition;
      const operator = parentCond.operator || 'has_parent';
      
      // Static mode: parent_uuid is set directly
      if (parentCond.parent_uuid) {
        const parentBlock: ParentBlock = {
          type: 'PARENT',
          blocks: [{
            type: 'NODE_REFERENCE',
            uuid: parentCond.parent_uuid,
          } as NodeReferenceBlock],
        };
        
        // Wrap in NOT_CONTAINER for negative operator
        if (operator === 'has_no_parent') {
          return {
            type: 'NOT_CONTAINER',
            block: parentBlock,
          } as NotBlock;
        }
        
        return parentBlock;
      }
      
      // Dynamic mode: nested_group is set
      if (parentCond.nested_group) {
        const parentBlock: ParentBlock = {
          type: 'PARENT',
          blocks: parentCond.nested_group.children.map(child => convertASTNodeToBlock(child)),
        };
        
        // Wrap in NOT_CONTAINER for negative operator
        if (operator === 'has_no_parent') {
          return {
            type: 'NOT_CONTAINER',
            block: parentBlock,
          } as NotBlock;
        }
        
        return parentBlock;
      }
      
      // Fallback: empty parent block
      return {
        type: 'PARENT',
        blocks: [],
      } as ParentBlock;
    }
    
    case 'parent_path': {
      const parentPathCond = condition as ParentPathCondition;
      return {
        type: 'PARENT_PATH',
        blocks: parentPathCond.nested_group.children.map(child => convertASTNodeToBlock(child)),
        max_depth: parentPathCond.max_depth,
      } as ParentPathBlock;
    }
    
    case 'child': {
      const childCond = condition as ChildCondition;
      const operator = childCond.operator || 'has_child';
      
      const childBlock: ChildBlock = {
        type: 'CHILD',
        blocks: childCond.nested_group.children.map(child => convertASTNodeToBlock(child)),
      };
      
      // Wrap in NOT_CONTAINER for negative operator
      if (operator === 'has_no_child') {
        return {
          type: 'NOT_CONTAINER',
          block: childBlock,
        } as NotBlock;
      }
      
      return childBlock;
    }
    
    case 'child_path': {
      const childPathCond = condition as ChildPathCondition;
      return {
        type: 'CHILD_PATH',
        blocks: childPathCond.nested_group.children.map(child => convertASTNodeToBlock(child)),
        max_depth: childPathCond.max_depth,
      } as ChildPathBlock;
    }
    
    case 'class_path': {
      const classPathCond = condition as ClassPathCondition;
      return {
        type: 'CLASS_PATH',
        blocks: classPathCond.nested_group.children.map(child => convertASTNodeToBlock(child)),
      } as ClassPathBlock;
    }
    
    default:
      throw new Error(`Unknown condition type: ${(condition as ConditionNode).condition_type}`);
  }
}
