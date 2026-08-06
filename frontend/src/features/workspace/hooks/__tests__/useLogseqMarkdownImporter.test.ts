import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '@/core/store';
import { uuidv7 } from '@/core/uuid';
import { createTestDatabase } from '@/core/__tests__/helpers';
import { importLogseqFolderToStore } from '@/features/workspace/hooks/useLogseqMarkdownImporter';
import { queryOne, queryAll } from '@/core/db/sqlite';
import type { Asset } from '@/features/assets/api/assets';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

function createMockFile(
  name: string,
  webkitRelativePath: string,
  content: string,
): File {
  const blob = new Blob([content], { type: 'text/markdown' });
  return Object.assign(blob, {
    name,
    webkitRelativePath,
    text: () => Promise.resolve(content),
  }) as unknown as File;
}

function createMockFileList(files: File[]): FileList {
  const list = {
    length: files.length,
    item: (i: number) => files[i] ?? null,
    [Symbol.iterator]: function* () {
      for (let i = 0; i < files.length; i++) {
        yield files[i];
      }
    },
  } as unknown as FileList;
  for (let i = 0; i < files.length; i++) {
    (list as unknown as Record<number, File>)[i] = files[i];
  }
  return list;
}

async function createStore() {
  const db = await createTestDatabase();
  const workspaceId = uuidv7();
  const actorId = uuidv7();
  const store = new WorkspaceStore(db, workspaceId, actorId);
  return { db, store, workspaceId, actorId };
}

describe('importLogseqFolderToStore', () => {
  it('creates pages and nested blocks', async () => {
    const { store } = await createStore();
    const files = createMockFileList([
      createMockFile(
        'My Page.md',
        'graph/pages/My Page.md',
        '- Parent block\n  - Child block\n- Another block',
      ),
    ]);

    const report = await importLogseqFolderToStore(store, files);

    expect(report.pagesCreated).toBe(1);
    expect(report.blocksCreated).toBe(3);

    const pageRow = queryOne<{ id: string; content: string }>(
      store.getDb(),
      "SELECT id, content FROM node WHERE kind = 'page' AND active = 1",
      [],
    );
    expect(pageRow).toBeDefined();
    expect(pageRow!.content).toContain('My Page');

    const childRows = queryAll<{ child_id: string }>(
      store.getDb(),
      'SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position',
      [pageRow!.id],
    );
    expect(childRows).toHaveLength(2);
  });

  it('resolves wiki-links by creating target pages and node_link AST nodes', async () => {
    const { store } = await createStore();
    const files = createMockFileList([
      createMockFile(
        'Source.md',
        'graph/pages/Source.md',
        '- See [[Target Page]] for details',
      ),
    ]);

    const report = await importLogseqFolderToStore(store, files);

    expect(report.pagesCreated).toBe(2);
    expect(report.blocksCreated).toBe(1);
    expect(report.linksCreated).toBe(1);

    const targetRow = queryOne<{ id: string }>(
      store.getDb(),
      "SELECT id FROM node WHERE kind = 'page' AND content LIKE '%Target Page%'",
      [],
    );
    expect(targetRow).toBeDefined();

    const linkRow = queryOne<{ source_id: string; target_id: string }>(
      store.getDb(),
      'SELECT source_id, target_id FROM node_link WHERE target_id = ?',
      [targetRow!.id],
    );
    expect(linkRow).toBeDefined();

    const sourceRow = queryOne<{ content: string }>(
      store.getDb(),
      'SELECT content FROM node WHERE id = ?',
      [linkRow!.source_id],
    );
    expect(sourceRow).toBeDefined();
    expect(sourceRow!.content).toContain('node_link');
    expect(sourceRow!.content).toContain(targetRow!.id);
  });

  it('uploads referenced assets and embeds them as node_link nodes', async () => {
    const { store } = await createStore();
    const assetUuid = uuidv7();
    const uploadAsset = async (): Promise<Asset> => ({
      uuid: assetUuid,
      node_id: 0,
      node_uuid: assetUuid,
      filename: 'diagram.png',
      content_type: 'image/png',
      category: 'image',
      size_bytes: 1234,
      url: '/api/assets/' + assetUuid,
    });

    const files = createMockFileList([
      createMockFile(
        'Page With Asset.md',
        'graph/pages/Page With Asset.md',
        '- ![diagram](../assets/diagram.png)',
      ),
      Object.assign(
        new Blob(['fake-image'], { type: 'image/png' }),
        {
          name: 'diagram.png',
          webkitRelativePath: 'graph/assets/diagram.png',
          text: () => Promise.resolve('fake-image'),
        },
      ) as unknown as File,
    ]);

    const report = await importLogseqFolderToStore(store, files, { uploadAsset });

    expect(report.assetsUploaded).toBe(1);
    expect(report.blocksCreated).toBe(1);

    const blockRow = queryOne<{ content: string }>(
      store.getDb(),
      "SELECT content FROM node WHERE kind = 'block' AND active = 1",
      [],
    );
    expect(blockRow).toBeDefined();
    expect(blockRow!.content).toContain('node_link');
    expect(blockRow!.content).toContain(assetUuid);
  });

  it('preserves block ordering via moveNode', async () => {
    const { store } = await createStore();
    const files = createMockFileList([
      createMockFile(
        'Ordered.md',
        'graph/pages/Ordered.md',
        '- First\n- Second\n- Third',
      ),
    ]);

    await importLogseqFolderToStore(store, files);

    const pageRow = queryOne<{ id: string }>(
      store.getDb(),
      "SELECT id FROM node WHERE kind = 'page' AND active = 1",
      [],
    );
    const childRows = queryAll<{ child_id: string }>(
      store.getDb(),
      'SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position',
      [pageRow!.id],
    );

    const contents = childRows.map((row) => {
      const node = queryOne<{ content: string }>(store.getDb(), 'SELECT content FROM node WHERE id = ?', [
        row.child_id,
      ]);
      return node?.content ?? '';
    });

    expect(contents[0]).toContain('First');
    expect(contents[1]).toContain('Second');
    expect(contents[2]).toContain('Third');
  });
});
