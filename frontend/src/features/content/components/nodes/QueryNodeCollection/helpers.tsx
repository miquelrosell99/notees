import type React from 'react';
import type { QueryAST } from '@/types/queryAST';
import type { Node } from '@/types';

/**
 * Apply collapse level to node children recursively
 * Used to automatically collapse children based on their depth level
 */
export function applyCollapseLevelToChildren(
  node: Node,
  collapseLevel: number,
  currentDepth: number = 0,
): Node {
  if (!node.children || node.children.length === 0 || collapseLevel === 0) {
    return node;
  }

  const processedChildren = node.children.map((child) => {
    const childDepth = currentDepth + 1;
    const hasChildren = !!(child.children && child.children.length > 0);
    const autoCollapse = hasChildren && childDepth >= collapseLevel;

    return applyCollapseLevelToChildren(
      {
        ...child,
        collapsed: autoCollapse || child.collapsed,
      },
      collapseLevel,
      childDepth,
    );
  });

  return {
    ...node,
    children: processedChildren,
  };
}

/**
 * Extract all node UUIDs referenced in a QueryAST (for prose rendering lookups).
 */
export function extractUuidsFromAST(ast: QueryAST | undefined | null): Set<string> {
  const uuids = new Set<string>();
  if (!ast) return uuids;

  function walkGroup(group: { children: Array<{ type: string } & Record<string, unknown>> }) {
    for (const child of group.children || []) {
      if (child.type === 'group') {
        walkGroup(child as unknown as { children: Array<{ type: string } & Record<string, unknown>> });
      } else if (child.type === 'not') {
        const notChild = (child as unknown as { child: { type: string } & Record<string, unknown> }).child;
        if (notChild.type === 'group') {
          walkGroup(notChild as unknown as { children: Array<{ type: string } & Record<string, unknown>> });
        } else {
          extractFromCondition(notChild);
        }
      } else {
        extractFromCondition(child);
      }
    }
  }

  function extractFromCondition(cond: Record<string, unknown>) {
    const type = cond.condition_type as string;
    if (type === 'class' && cond.class_uuid) uuids.add(cond.class_uuid as string);
    if (type === 'extends' && cond.extends_class_uuid) uuids.add(cond.extends_class_uuid as string);
    if (type === 'reference' && cond.target_uuid) uuids.add(cond.target_uuid as string);
    if (type === 'parent' && cond.parent_uuid) uuids.add(cond.parent_uuid as string);
    if (type === 'page' && cond.page_uuid) uuids.add(cond.page_uuid as string);
    if (type === 'property' && typeof cond.value === 'string' && cond.value.includes('-')) {
      uuids.add(cond.value as string);
    }
    if (type === 'reference_path' && Array.isArray(cond.target_uuids)) {
      (cond.target_uuids as string[]).forEach((u) => uuids.add(u));
    }
    if (type === 'parent_path' && Array.isArray(cond.ancestor_uuids)) {
      (cond.ancestor_uuids as string[]).forEach((u) => uuids.add(u));
    }
    if (type === 'child_path' && Array.isArray(cond.descendant_uuids)) {
      (cond.descendant_uuids as string[]).forEach((u) => uuids.add(u));
    }
    if (type === 'class_path' && Array.isArray(cond.class_uuids)) {
      (cond.class_uuids as string[]).forEach((u) => uuids.add(u));
    }
  }

  walkGroup(ast.root_group as unknown as { children: Array<{ type: string } & Record<string, unknown>> });
  return uuids;
}

/**
 * Render prose text with clickable markdown links
 */
export function renderProseWithLinks(text: string, onLinkClick: (uuid: string) => void): React.ReactNode {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = linkRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    const linkText = match[1];
    const uuid = match[2];
    parts.push(
      <button
        key={match.index}
        type="button"
        onClick={() => onLinkClick(uuid)}
        style={{
          color: 'var(--color-primary)',
          textDecoration: 'none',
          cursor: 'pointer',
          borderBottom: '1px solid var(--color-primary)',
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.textDecoration = 'underline';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.textDecoration = 'none';
        }}
      >
        {linkText}
      </button>,
    );

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}
