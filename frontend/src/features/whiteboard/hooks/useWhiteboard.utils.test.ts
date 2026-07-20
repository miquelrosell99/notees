import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '@/core/store';
import { uuidv7 } from '@/core/uuid';
import { createTestDatabase } from '@/core/__tests__/helpers';
import { projectNode } from '@/core/adapters/nodeProjection';
import { parseWhiteboardData, parseWhiteboardTitle } from './useWhiteboard.utils';
import type { WhiteboardData, WhiteboardShapeElement } from '@/features/whiteboard/types/whiteboard';

describe('useWhiteboard utils round-trip', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('reads whiteboard data and title from the raw content projection', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const nodeId = uuidv7();
    store.createNode({ nodeId, kind: 'page', parentId: null });

    const whiteboardData: WhiteboardData = {
      version: 1,
      viewport: { x: 10, y: 20, zoom: 1.5 },
      elements: [
        {
          id: uuidv7(),
          type: 'shape',
          x: 100,
          y: 200,
          width: 120,
          height: 80,
          rotation: 0,
          locked: false,
          opacity: 1,
          zIndex: 1,
          shapeType: 'rectangle',
          fill: 'transparent',
          stroke: 'var(--color-on-surface)',
          strokeWidth: 2,
          strokeStyle: 'solid',
          borderRadius: 4,
          text: '',
          textColor: 'var(--text-primary)',
          fontSize: 14,
          textAlign: 'center',
          fontWeight: 'normal',
        } as WhiteboardShapeElement,
      ],
      groups: [],
    };

    const ast = [
      { type: 'paragraph' as const, children: [{ type: 'text' as const, text: 'Project whiteboard' }] },
      { type: 'whiteboard' as const, data: whiteboardData },
    ];

    store.updateContentAst(nodeId, ast);

    const projected = projectNode(store, nodeId);
    expect(projected).toBeDefined();
    expect(projected!.content).toBe(JSON.stringify(ast));

    const parsedData = parseWhiteboardData(projected);
    expect(parsedData.elements).toHaveLength(1);
    expect((parsedData.elements[0] as WhiteboardShapeElement).shapeType).toBe('rectangle');
    expect(parsedData.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });

    expect(parseWhiteboardTitle(projected)).toBe('Project whiteboard');
  });

  it('returns defaults when the projected node has no raw content', async () => {
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, uuidv7(), uuidv7());
    const nodeId = uuidv7();

    store.createNode({ nodeId, kind: 'page', parentId: null });
    // Do not write any content.

    const projected = projectNode(store, nodeId);
    const parsedData = parseWhiteboardData(projected);
    expect(parsedData.elements).toHaveLength(0);
    expect(parseWhiteboardTitle(projected)).toBe('');
  });
});
