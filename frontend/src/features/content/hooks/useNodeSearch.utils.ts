import type { Node } from '@/types';
import { parseHierarchicalPath, filterNodesByHierarchy } from '@/utils/hierarchicalPath';
import type { NodeSearchItem } from './useNodeSearch.types';

function isClassDef(node: Node): boolean {
  return node.is_class === true;
}

export function getClassesResults(
  debouncedQuery: string,
  query: string,
  classSearchResults: Node[] | undefined,
  allClassNodes: Node[] | undefined,
  allPages: Node[] | undefined,
  excludeNodeId: string | undefined,
  maxResults: number,
): { pageResults: NodeSearchItem[]; blockResults: NodeSearchItem[]; truncated: boolean } {
  const parsed = parseHierarchicalPath(debouncedQuery);
  const searchQuery = parsed.isHierarchical ? parsed.leaf : debouncedQuery;

  let results = searchQuery.length > 0
    ? (classSearchResults ?? [])
    : (allClassNodes ?? []).slice(0, maxResults);

  if (parsed.isHierarchical && allPages) {
    results = filterNodesByHierarchy(query, results, allPages);
  }

  if (excludeNodeId !== undefined) {
    results = results.filter(n => n.uuid !== excludeNodeId);
  }

  const truncatedClasses = results.length > maxResults;
  return {
    pageResults: results.slice(0, maxResults).map(node => ({
      node,
      section: 'class' as const,
    })),
    blockResults: [],
    truncated: truncatedClasses,
  };
}

export function getUsersResults(
  debouncedQuery: string,
  searchResults: Node[] | undefined,
  excludeNodeId: string | undefined,
  maxResults: number,
): { pageResults: NodeSearchItem[]; blockResults: NodeSearchItem[]; truncated: boolean } {
  const parsed = parseHierarchicalPath(debouncedQuery);
  const searchQuery = parsed.isHierarchical ? parsed.leaf : debouncedQuery;

  let results = searchQuery.length > 0
    ? (searchResults ?? [])
    : [];

  if (excludeNodeId !== undefined) {
    results = results.filter(n => n.uuid !== excludeNodeId);
  }

  const truncatedUsers = results.length > maxResults;
  return {
    pageResults: results.slice(0, maxResults).map(node => ({
      node,
      section: 'page' as const,
    })),
    blockResults: [],
    truncated: truncatedUsers,
  };
}

export function getTagsResults(
  debouncedQuery: string,
  query: string,
  searchResults: Node[] | undefined,
  allPages: Node[] | undefined,
  classFilters: string[],
  excludeNodeId: string | undefined,
  maxResults: number,
): { pageResults: NodeSearchItem[]; blockResults: NodeSearchItem[]; truncated: boolean } {
  const parsed = parseHierarchicalPath(debouncedQuery);
  const searchQuery = parsed.isHierarchical ? parsed.leaf : debouncedQuery;

  let results = (searchQuery.length > 0
    ? (searchResults ?? []).filter(n => n.is_page)
    : (allPages ?? []).slice(0, maxResults * 3)
  ).filter(n => !isClassDef(n));

  if (parsed.isHierarchical && allPages) {
    results = filterNodesByHierarchy(query, results, allPages);
  }

  if (classFilters.length > 0) {
    results = results.filter(node => {
      if (node.classes_uuid && node.classes_uuid.length > 0) {
        return classFilters.some(filterId => node.classes_uuid!.includes(filterId));
      }
      return false;
    });
  }

  if (excludeNodeId !== undefined) {
    results = results.filter(n => n.uuid !== excludeNodeId);
  }

  const truncatedTags = results.length > maxResults;
  results = results.slice(0, maxResults);

  return {
    pageResults: results.map(node => ({
      node,
      section: 'page' as const,
    })),
    blockResults: [],
    truncated: truncatedTags,
  };
}

export function getAliasesResults(
  debouncedQuery: string,
  query: string,
  searchResults: Node[] | undefined,
  allPages: Node[] | undefined,
  excludeNodeId: string | undefined,
  maxResults: number,
): { pageResults: NodeSearchItem[]; blockResults: NodeSearchItem[]; truncated: boolean } {
  const parsed = parseHierarchicalPath(debouncedQuery);
  const searchQuery = parsed.isHierarchical ? parsed.leaf : debouncedQuery;

  let results = (searchQuery.length > 0
    ? (searchResults ?? []).filter(n => n.is_page)
    : (allPages ?? []).slice(0, maxResults * 3)
  ).filter(n => !isClassDef(n) && !n.aliased_uuid && (!n.aliases_uuid || n.aliases_uuid.length === 0));

  if (parsed.isHierarchical && allPages) {
    results = filterNodesByHierarchy(query, results, allPages);
  }

  if (excludeNodeId !== undefined) {
    results = results.filter(n => n.uuid !== excludeNodeId);
  }

  const truncatedAliases = results.length > maxResults;
  results = results.slice(0, maxResults);

  return {
    pageResults: results.map(node => ({
      node,
      section: 'page' as const,
    })),
    blockResults: [],
    truncated: truncatedAliases,
  };
}

export function getPagesResults(
  debouncedQuery: string,
  query: string,
  searchResults: Node[] | undefined,
  suggestions: Node[] | undefined,
  filteredPages: Node[] | undefined,
  allPages: Node[] | undefined,
  classFilters: string[],
  excludeNodeId: string | undefined,
  pinnedNodeId: string | null | undefined,
  maxResults: number,
): { pageResults: NodeSearchItem[]; blockResults: NodeSearchItem[]; truncated: boolean } {
  const parsed = parseHierarchicalPath(debouncedQuery);
  const searchQuery = parsed.isHierarchical ? parsed.leaf : debouncedQuery;

  let results: Node[];
  if (searchQuery.length > 0) {
    results = (searchResults ?? []).filter(n => n.is_page || n.parent_uuid === null);
  } else if (suggestions && suggestions.length > 0) {
    results = suggestions;
  } else if (classFilters.length > 0) {
    results = (filteredPages ?? []).slice(0, maxResults * 3);
  } else {
    results = (allPages ?? []).slice(0, maxResults * 3);
  }

  if (parsed.isHierarchical && allPages) {
    results = filterNodesByHierarchy(query, results, allPages);
  }

  if (excludeNodeId !== undefined) {
    results = results.filter(n => n.uuid !== excludeNodeId);
  }

  if (pinnedNodeId && searchQuery.length === 0) {
    const pinnedIdx = results.findIndex(n => n.uuid === pinnedNodeId);
    if (pinnedIdx > 0) {
      const [pinned] = results.splice(pinnedIdx, 1);
      results.unshift(pinned);
    } else if (pinnedIdx === -1 && allPages) {
      const pinnedNode = allPages.find(n => n.uuid === pinnedNodeId);
      if (pinnedNode) results.unshift(pinnedNode);
    }
  }

  return {
    pageResults: results.slice(0, maxResults).map(node => ({
      node,
      section: 'page' as const,
    })),
    blockResults: [],
    truncated: results.length > maxResults,
  };
}

export function getBlocksResults(
  debouncedQuery: string,
  searchResults: Node[] | undefined,
  allNodes: Node[] | undefined,
  maxResults: number,
): { pageResults: NodeSearchItem[]; blockResults: NodeSearchItem[]; truncated: boolean } {
  const parsed = parseHierarchicalPath(debouncedQuery);
  const searchQuery = parsed.isHierarchical ? parsed.leaf : debouncedQuery;

  const results = searchQuery.length > 0
    ? (searchResults ?? []).filter(n => !n.is_page && n.parent_uuid !== null)
    : (allNodes ?? []).filter(n => !n.is_page).slice(0, maxResults);

  return {
    pageResults: [],
    blockResults: results.slice(0, maxResults).map(node => ({
      node,
      section: 'block' as const,
    })),
    truncated: results.length > maxResults,
  };
}

export function getAllResults(
  debouncedQuery: string,
  query: string,
  searchResults: Node[] | undefined,
  suggestions: Node[] | undefined,
  allPages: Node[] | undefined,
  allNodes: Node[] | undefined,
  classFilters: string[],
  excludeNodeId: string | undefined,
  pinnedNodeId: string | null | undefined,
  maxResults: number,
): { pageResults: NodeSearchItem[]; blockResults: NodeSearchItem[]; truncated: boolean } {
  const parsed = parseHierarchicalPath(debouncedQuery);
  const searchQuery = parsed.isHierarchical ? parsed.leaf : debouncedQuery;

  let baseResults = searchQuery.length > 0
    ? (searchResults ?? [])
    : suggestions && suggestions.length > 0
      ? [
          ...suggestions.slice(0, Math.floor(maxResults / 2)),
          ...(allNodes ?? []).filter(n => n.parent_uuid !== null).slice(0, Math.floor(maxResults / 2)),
        ]
      : [
          ...(allPages ?? []).slice(0, Math.floor(maxResults / 2)),
          ...(allNodes ?? []).filter(n => n.parent_uuid !== null).slice(0, Math.floor(maxResults / 2)),
        ];

  if (parsed.isHierarchical && allPages) {
    const pagesOnly = baseResults.filter(n => n.is_page || n.parent_uuid === null);
    const blocksOnly = baseResults.filter(n => !n.is_page && n.parent_uuid !== null);
    const filteredPages = filterNodesByHierarchy(query, pagesOnly, allPages);
    baseResults = [...filteredPages, ...blocksOnly];
  }

  if (classFilters.length > 0) {
    baseResults = baseResults.filter(node => {
      if (node.classes_uuid && node.classes_uuid.length > 0) {
        return classFilters.some(filterId => node.classes_uuid!.includes(filterId));
      }
      return false;
    });
  }

  if (excludeNodeId !== undefined) {
    baseResults = baseResults.filter(n => n.uuid !== excludeNodeId);
  }

  if (pinnedNodeId && searchQuery.length === 0) {
    const pinnedIdx = baseResults.findIndex(n => n.uuid === pinnedNodeId);
    if (pinnedIdx > 0) {
      const [pinned] = baseResults.splice(pinnedIdx, 1);
      baseResults.unshift(pinned);
    } else if (pinnedIdx === -1 && allPages) {
      const pinnedNode = allPages.find(n => n.uuid === pinnedNodeId);
      if (pinnedNode) baseResults.unshift(pinnedNode);
    }
  }

  const pages: NodeSearchItem[] = [];
  const blocks: NodeSearchItem[] = [];

  for (const node of baseResults) {
    if (node.is_page || node.parent_uuid === null) {
      if (pages.length < maxResults) {
        pages.push({
          node,
          section: 'page',
        });
      }
    } else {
      if (blocks.length < maxResults) {
        blocks.push({
          node,
          section: 'block',
        });
      }
    }
  }

  const totalAvailable = baseResults.length;
  const totalShown = pages.length + blocks.length;
  return { pageResults: pages, blockResults: blocks, truncated: totalAvailable > totalShown };
}
