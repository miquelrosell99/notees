import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { projectNode } from '../nodeProjection';

describe('projectNode', () => {
  beforeAll(() => {
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('builds a correct Node shape from a page and a child block', async () => {
    const db = await createTestDatabase();
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const store = new WorkspaceStore(db, workspaceId, actorId);

    const pageId = uuidv7();
    const blockId = uuidv7();

    store.createNode({ nodeId: pageId, kind: 'page', parentId: null });
    store.updateText(pageId, (text) => text.insert(0, 'My page title'));

    store.createNode({ nodeId: blockId, kind: 'block', parentId: null });
    store.moveNode(blockId, pageId);
    store.updateText(blockId, (text) => text.insert(0, 'A child block'));

    const page = projectNode(store, pageId);
    expect(page).toBeDefined();
    expect(page!.uuid).toBe(pageId);
    expect(page!.name).toBe('My page title');
    expect(page!.is_page).toBe(true);
    expect(page!.is_class).toBe(false);
    expect(page!.parent_uuid).toBeNull();
    expect(page!.active).toBe(true);
    expect(page!.has_children).toBe(true);
    expect(page!.children).toBeDefined();
    expect(page!.children).toHaveLength(1);

    const child = page!.children![0];
    expect(child.uuid).toBe(blockId);
    expect(child.name).toBe('A child block');
    expect(child.is_page).toBe(false);
    expect(child.parent_uuid).toBe(pageId);
    expect(child.page_uuid).toBe(pageId);
  });

  it('falls back to raw content when content is not valid AST JSON', async () => {
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, uuidv7(), uuidv7());
    const nodeId = uuidv7();

    store.createNode({ nodeId, kind: 'page', parentId: null });
    // Bypass the CRDT and write raw text directly into the content column.
    db.run("UPDATE node SET content = ? WHERE id = ?", ["Raw title text", nodeId]);

    const node = projectNode(store, nodeId);
    expect(node).toBeDefined();
    expect(node!.name).toBe('Raw title text');
  });

  it('truncates long raw content to 200 characters', async () => {
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, uuidv7(), uuidv7());
    const nodeId = uuidv7();

    store.createNode({ nodeId, kind: 'page', parentId: null });
    const longText = 'a'.repeat(500);
    db.run("UPDATE node SET content = ? WHERE id = ?", [longText, nodeId]);

    const node = projectNode(store, nodeId);
    expect(node!.name).toHaveLength(200);
    expect(node!.name).toBe('a'.repeat(200));
  });
});
