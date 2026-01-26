/**
 * Query AST Converters
 * 
 * Bidirectional converters between QueryBlockTree (legacy) and QueryAST (new).
 * Maintains backward compatibility while enabling new AST-based features.
 */

import type {
  QueryBlock,
  QueryBlockTree,
  ContainerBlock,
  NotBlock,
  TypeBlock,
  PropertyBlock,
  ContentBlock,
  ReferenceBlock,
  ReferencePathBlock,
  AncestorPathBlock,
  UuidBlock,
} from '@/types/query';

import type {
  QueryAST,
  ScopeNode,
  GroupNode,
  NotNode as ASTNotNode,
  ConditionNode,
  TypeCondition,
  PropertyCondition,
  ContentCondition,
  ReferenceCondition,
  ReferencePathCondition,
  AncestorPathCondition,
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
    scope_type: 'entire_graph',
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
export function blockTreeToAST(blockTree: QueryBlockTree, queryId?: string): QueryAST {
  const ast = createEmptyQueryAST();
  
  // Set query identity
  if (queryId) {
    ast.id = queryId;
  }
  ast.updated_at = new Date().toISOString();
  
  // Extract scope from blocks (look for ANCESTOR_PATH, UUID blocks)
  const { scope, filteredBlocks } = extractScope(blockTree.blocks);
  ast.scope = scope;
  
  // Convert remaining blocks to conditions
  ast.root_group = {
    type: 'group',
    logic: blockTree.type === 'AND_CONTAINER' ? 'AND' : 'OR',
    children: filteredBlocks.map(block => convertBlockToASTNode(block)),
  };
  
  return ast;
}

/**
 * Extract scope information from blocks
 * Returns the scope node and blocks that are NOT part of scope
 */
function extractScope(blocks: QueryBlock[]): { scope: ScopeNode; filteredBlocks: QueryBlock[] } {
  const pageUuids: string[] = [];
  const excludedPageUuids: string[] = [];
  const nonScopeBlocks: QueryBlock[] = [];
  
  for (const block of blocks) {
    // Look for ANCESTOR_PATH blocks with UUID children (page scope)
    if (block.type === 'ANCESTOR_PATH') {
      const ancestorBlock = block as AncestorPathBlock;
      const uuidBlock = ancestorBlock.blocks?.find(b => b.type === 'UUID') as UuidBlock | undefined;
      
      if (uuidBlock?.value && !uuidBlock.value.startsWith('{')) {
        pageUuids.push(uuidBlock.value);
        continue; // Don't include in filtered blocks
      }
    }
    // Look for NOT(ANCESTOR_PATH) blocks (excluded pages)
    else if (block.type === 'NOT_CONTAINER') {
      const notBlock = block as NotBlock;
      if (notBlock.block?.type === 'ANCESTOR_PATH') {
        const ancestorBlock = notBlock.block as AncestorPathBlock;
        const uuidBlock = ancestorBlock.blocks?.find(b => b.type === 'UUID') as UuidBlock | undefined;
        
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
    
    case 'TYPE': {
      const typeBlock = block as TypeBlock;
      return {
        type: 'condition',
        condition_type: 'type',
        type_uuid: typeBlock.value,
        type_id: typeBlock.type_id,
      } as TypeCondition;
    }
    
    case 'PROPERTY': {
      const propBlock = block as PropertyBlock;
      return {
        type: 'condition',
        condition_type: 'property',
        property_name: propBlock.property_name,
        property_id: propBlock.property_id,
        property_type: propBlock.property_type,
        operator: propBlock.operator,
        value: propBlock.value,
      } as PropertyCondition;
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
      };
      
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
    
    case 'ANCESTOR_PATH': {
      const ancestorBlock = block as AncestorPathBlock;
      return {
        type: 'condition',
        condition_type: 'ancestor_path',
        nested_group: {
          type: 'group',
          logic: 'AND',
          children: ancestorBlock.blocks.map(b => convertBlockToASTNode(b)),
        },
        max_depth: ancestorBlock.max_depth,
      } as AncestorPathCondition;
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
  const blocks: QueryBlock[] = [];
  
  // Convert scope to blocks (ANCESTOR_PATH, NOT_CONTAINER, etc.)
  const scopeBlocks = scopeToBlocks(ast.scope);
  blocks.push(...scopeBlocks);
  
  // Convert root group children to blocks
  const conditionBlocks = ast.root_group.children.map(child => convertASTNodeToBlock(child));
  blocks.push(...conditionBlocks);
  
  return {
    type: ast.root_group.logic === 'AND' ? 'AND_CONTAINER' : 'OR_CONTAINER',
    blocks,
  };
}

/**
 * Convert scope node to blocks
 */
function scopeToBlocks(scope: ScopeNode): QueryBlock[] {
  const blocks: QueryBlock[] = [];
  
  // Add included pages as ANCESTOR_PATH blocks
  if (scope.page_uuids && scope.page_uuids.length > 0) {
    for (const uuid of scope.page_uuids) {
      blocks.push({
        type: 'ANCESTOR_PATH',
        blocks: [{ type: 'UUID', value: uuid }],
      } as AncestorPathBlock);
    }
  }
  
  // Add excluded pages as NOT(ANCESTOR_PATH) blocks
  if (scope.excluded_page_uuids && scope.excluded_page_uuids.length > 0) {
    for (const uuid of scope.excluded_page_uuids) {
      blocks.push({
        type: 'NOT_CONTAINER',
        block: {
          type: 'ANCESTOR_PATH',
          blocks: [{ type: 'UUID', value: uuid }],
        } as AncestorPathBlock,
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
    case 'type': {
      const typeCond = condition as TypeCondition;
      return {
        type: 'TYPE',
        value: typeCond.type_uuid,
        type_id: typeCond.type_id,
      } as TypeBlock;
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
      const refBlock: ReferenceBlock = {
        type: 'REFERENCE',
        target_uuid: refCond.target_uuid,
        target_id: refCond.target_id,
      };
      
      if (refCond.nested_group) {
        refBlock.blocks = refCond.nested_group.children.map(child => convertASTNodeToBlock(child));
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
    
    case 'ancestor_path': {
      const ancestorCond = condition as AncestorPathCondition;
      return {
        type: 'ANCESTOR_PATH',
        blocks: ancestorCond.nested_group.children.map(child => convertASTNodeToBlock(child)),
        max_depth: ancestorCond.max_depth,
      } as AncestorPathBlock;
    }
    
    default:
      throw new Error(`Unknown condition type: ${(condition as ConditionNode).condition_type}`);
  }
}
