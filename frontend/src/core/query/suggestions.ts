/**
 * Build suggested pages from the core SQLite derived store.
 */

import type { Node } from '@/types/api';
import { queryAll } from '../db/sqlite';
import { projectNode } from '../adapters/nodeProjection';
import type { WorkspaceStore } from '../store';

const SUGGESTION_LIMIT = 20;
const RECENT_MINUTES = 15;

export function buildSuggestions(store: WorkspaceStore, classFilters?: string): Node[] {
  const db = store.getDb();
  const classFilterSet = classFilters ? new Set(classFilters.split(',').filter(Boolean)) : null;

  const recentCutoff = new Date(Date.now() - RECENT_MINUTES * 60 * 1000).toISOString();

  // Recently created pages
  const recentRows = queryAll<{ id: string }>(
    db,
    `SELECT id FROM node
     WHERE kind = 'page'
       AND created_at >= ?
     ORDER BY created_at DESC`,
    [recentCutoff]
  );

  // Most recently linked targets (from explicit link clicks, then edge references)
  const linkedRows = queryAll<{ id: string }>(
    db,
    `SELECT id FROM (
       SELECT n.id, MAX(lc.last_clicked_at) AS last_at
       FROM node n
       JOIN link_click lc ON lc.target_id = n.id
       WHERE n.kind = 'page'
       GROUP BY n.id

       UNION ALL

       SELECT n.id, MAX(e.created_at) AS last_at
       FROM node n
       JOIN edge e ON e.target_id = n.id
       WHERE n.kind = 'page'
         AND e.type = 'reference'
       GROUP BY n.id
     )
     ORDER BY last_at DESC`,
    []
  );

  const seen = new Set<string>();
  const suggestions: Node[] = [];

  const addNode = (node: Node) => {
    if (seen.has(node.uuid)) return;
    if (classFilterSet && !(node.classes_uuid ?? []).some((id) => classFilterSet!.has(id))) return;
    seen.add(node.uuid);
    suggestions.push(node);
  };

  for (const row of recentRows) {
    const node = projectNode(store, row.id);
    if (node) addNode(node);
  }

  for (const row of linkedRows) {
    const node = projectNode(store, row.id);
    if (node) addNode(node);
    if (suggestions.length >= SUGGESTION_LIMIT) break;
  }

  return suggestions.slice(0, SUGGESTION_LIMIT);
}
