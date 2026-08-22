import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { projectNode, projectNodes } from '../nodeProjection';
import { inlineDoc, text, nodeLink, buildLinkId } from '@/lib/astBuilder';

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

  it('projects aliases_uuid and aliased_uuid from node_alias rows', async () => {
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, uuidv7(), uuidv7());
    const canonicalId = uuidv7();
    const aliasId = uuidv7();

    store.createNode({ nodeId: canonicalId, kind: 'page', parentId: null });
    store.createNode({ nodeId: aliasId, kind: 'page', parentId: null });
    store.addAlias(canonicalId, aliasId);

    const canonical = projectNode(store, canonicalId);
    const alias = projectNode(store, aliasId);

    expect(canonical!.aliases_uuid).toEqual([aliasId]);
    expect(canonical!.aliased_uuid).toBeNull();
    expect(alias!.aliased_uuid).toBe(canonicalId);
    expect(alias!.aliases_uuid).toEqual([]);
  });

  it('does not leak raw AST when content contains a node link', async () => {
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, uuidv7(), uuidv7());
    const pageId = uuidv7();
    const targetId = uuidv7();

    store.createNode({ nodeId: pageId, kind: 'page', parentId: null });
    const content = JSON.stringify(inlineDoc(nodeLink(buildLinkId(targetId, uuidv7()), 'node')));
    db.run('UPDATE node SET content = ? WHERE id = ?', [content, pageId]);

    const node = projectNode(store, pageId);
    expect(node!.name).not.toContain('type');
    expect(node!.name).not.toContain('node_link');
    // When the only content is an unresolved node link, show the target UUID
    // so users can identify the reference (owner decision 2026-08, see
    // skills/notees/rules/coding-standards.md).
    expect(node!.name).toBe(targetId);
  });

  it('keeps surrounding text when content mixes text and node links', async () => {
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, uuidv7(), uuidv7());
    const pageId = uuidv7();
    const targetId = uuidv7();

    store.createNode({ nodeId: pageId, kind: 'page', parentId: null });
    const content = JSON.stringify(inlineDoc(text('See '), nodeLink(buildLinkId(targetId, uuidv7()), 'node')));
    db.run('UPDATE node SET content = ? WHERE id = ?', [content, pageId]);

    const node = projectNode(store, pageId);
    expect(node!.name).toBe('See …');
  });

  it('projects a class from the class table when the UUID is not a node', async () => {
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, uuidv7(), uuidv7());

    const classId = uuidv7();
    store.createClass({ classId, name: 'Project', icon: 'folder', color: '#ff0000' });

    const node = projectNode(store, classId);
    expect(node).toBeDefined();
    expect(node!.uuid).toBe(classId);
    expect(node!.name).toBe('Project');
    expect(node!.is_page).toBe(false);
    expect(node!.is_class).toBe(true);
    expect(node!.icon).toBe('folder');
    expect(node!.color).toBe('#ff0000');
    expect(node!.active).toBe(true);
  });

  it('batch projects a mix of nodes and classes', async () => {
    const db = await createTestDatabase();
    const store = new WorkspaceStore(db, uuidv7(), uuidv7());

    const pageId = uuidv7();
    const classId = uuidv7();

    store.createNode({ nodeId: pageId, kind: 'page', parentId: null });
    store.updateText(pageId, (text) => text.insert(0, 'My page'));
    store.createClass({ classId, name: 'Task' });

    const nodes = projectNodes(store, [pageId, classId], 0);
    expect(nodes).toHaveLength(2);

    const page = nodes.find((n) => n.uuid === pageId);
    const cls = nodes.find((n) => n.uuid === classId);

    expect(page).toBeDefined();
    expect(page!.is_page).toBe(true);
    expect(page!.is_class).toBe(false);

    expect(cls).toBeDefined();
    expect(cls!.is_page).toBe(false);
    expect(cls!.is_class).toBe(true);
    expect(cls!.name).toBe('Task');
  });
});
