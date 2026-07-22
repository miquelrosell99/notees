import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createWorkspaceStoreClient,
  resetSharedWorkspaceStoreClient,
  WorkerStoreClient,
} from '../WorkspaceStoreClient';
import type { IWorkspaceStoreClient } from '../workerProtocol';
import { uuidv7 } from '../../uuid';

describe('WorkspaceStoreClient', () => {
  let client: IWorkspaceStoreClient;

  beforeEach(() => {
    client = createWorkspaceStoreClient();
  });

  afterEach(() => {
    client.close();
    resetSharedWorkspaceStoreClient();
  });

  it('initializes and exports an empty workspace database', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();

    await client.init(workspaceId, actorId);
    const bytes = await client.export();

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('initializes with persisted database bytes', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();

    await client.init(workspaceId, actorId);
    const firstExport = await client.export();

    const secondClient = createWorkspaceStoreClient();
    await secondClient.init(workspaceId, actorId, { dbBytes: firstExport });
    const secondExport = await secondClient.export();
    secondClient.close();

    expect(secondExport.length).toBeGreaterThan(0);
  });

  it('mutates and queries data through the worker boundary', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const nodeId = uuidv7();

    await client.init(workspaceId, actorId);
    await client.mutate('createNode', [
      { nodeId, kind: 'page', parentId: null, classIds: [] },
    ]);
    const node = await client.query('getNode', [nodeId]);

    expect(node).toBeDefined();
    expect((node as { id: string }).id).toBe(nodeId);
  });

  it('queries aggregated node properties through the worker boundary', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const nodeId = uuidv7();
    const schemaId = uuidv7();

    await client.init(workspaceId, actorId);
    await client.mutate('createNode', [
      { nodeId, kind: 'page', parentId: null, classIds: [] },
    ]);
    await client.mutate('setProperty', [
      { propertyValueId: uuidv7(), nodeId, schemaId, index: 0, value: 'hello' },
    ]);

    const properties = await client.query<Record<string, unknown[]>>('getNodeProperties', [nodeId]);

    expect(properties[schemaId]).toEqual(['hello']);
  });

  it('queries property schemas through the worker boundary', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const schemaId = uuidv7();

    await client.init(workspaceId, actorId);
    await client.mutate('createPropertySchema', [
      { schemaId, name: 'Test Property', type: 'text' },
    ]);

    const schemas = await client.query<{ uuid: string; name: string }[]>('getPropertySchemas', []);

    expect(schemas.some((s) => s.uuid === schemaId && s.name === 'Test Property')).toBe(true);
  });

  it('queries batch property values through the worker boundary', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const nodeId = uuidv7();
    const schemaId = uuidv7();

    await client.init(workspaceId, actorId);
    await client.mutate('createNode', [
      { nodeId, kind: 'page', parentId: null, classIds: [] },
    ]);
    await client.mutate('setProperty', [
      { propertyValueId: uuidv7(), nodeId, schemaId, index: 0, value: 'batch-value' },
    ]);

    const batch = await client.query<Record<string, Record<string, unknown>>>('getBatchPropertyValues', [
      [nodeId],
    ]);

    expect(batch[nodeId]?.[schemaId]).toBe('batch-value');
  });

  it('queries class properties through the worker boundary', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const classId = uuidv7();
    const schemaId = uuidv7();

    await client.init(workspaceId, actorId);
    await client.mutate('createNode', [
      { nodeId: classId, kind: 'class', parentId: null, classIds: [] },
    ]);
    await client.mutate('createPropertySchema', [
      { schemaId, name: 'Class Property', type: 'text' },
    ]);
    await client.mutate('addPropertyToClass', [
      { classId, propertySchemaId: schemaId, sequence: 0 },
    ]);

    const edges = await client.query<{ property_uuid: string }[]>('getClassProperties', [
      classId,
      false,
    ]);

    expect(edges.some((e) => e.property_uuid === schemaId)).toBe(true);
  });

  it('queries class-property edges for multiple classes through the worker boundary', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const classId = uuidv7();
    const schemaId = uuidv7();

    await client.init(workspaceId, actorId);
    await client.mutate('createNode', [
      { nodeId: classId, kind: 'class', parentId: null, classIds: [] },
    ]);
    await client.mutate('createPropertySchema', [
      { schemaId, name: 'Multi Class Property', type: 'text' },
    ]);
    await client.mutate('addPropertyToClass', [
      { classId, propertySchemaId: schemaId, sequence: 0 },
    ]);

    const perClassEdges = await client.query<{ property_uuid: string }[][]>('getNodeClassPropertyEdges', [
      [classId],
    ]);

    expect(perClassEdges).toHaveLength(1);
    expect(perClassEdges[0].some((e) => e.property_uuid === schemaId)).toBe(true);
  });

  it('sets node text through the worker boundary', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const nodeId = uuidv7();

    await client.init(workspaceId, actorId);
    await client.mutate('createNode', [
      { nodeId, kind: 'page', parentId: null, classIds: [] },
    ]);
    await client.mutate('setNodeText', [nodeId, 'Hello worker']);

    const node = await client.query('getNode', [nodeId]);
    expect(node).toBeDefined();
    const content = JSON.parse((node as { content: string }).content);
    expect(content[0].text).toBe('Hello worker');
  });

  it('inserts and deletes node text through the worker boundary', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const nodeId = uuidv7();

    await client.init(workspaceId, actorId);
    await client.mutate('createNode', [
      { nodeId, kind: 'page', parentId: null, classIds: [] },
    ]);
    await client.mutate('setNodeText', [nodeId, 'Hello']);
    await client.mutate('insertNodeText', [nodeId, 5, ' world']);
    await client.mutate('deleteNodeText', [nodeId, 5, 6]);

    const node = await client.query('getNode', [nodeId]);
    expect(node).toBeDefined();
    const content = JSON.parse((node as { content: string }).content);
    expect(content[0].text).toBe('Hello');
  });

  describe('WorkerStoreClient main-thread timeout behavior', () => {
    function createMockWorker(): Worker {
      return {
        postMessage: vi.fn(),
        terminate: vi.fn(),
        onmessage: null,
        onmessageerror: null,
        onerror: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as unknown as Worker;
    }

    function getLastRequestId(worker: Worker): number {
      const calls = (worker.postMessage as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = calls[calls.length - 1];
      return (lastCall[0] as { id: number }).id;
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects pending requests that time out and terminates the worker', async () => {
      const worker = createMockWorker();
      const mainClient = new WorkerStoreClient(worker);
      const promise = mainClient
        .query('getNode', ['node-1'])
        .catch((err: Error) => err);

      vi.advanceTimersByTime(31_000);

      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('timed out after 30000ms');
      expect(worker.terminate).toHaveBeenCalled();
      expect(mainClient.isClosed()).toBe(true);
      mainClient.close();
    });

    it('rejects all pending requests on worker error', async () => {
      const worker = createMockWorker();
      const mainClient = new WorkerStoreClient(worker);
      const p1 = mainClient.query('getNode', ['node-1']);
      const p2 = mainClient.mutate('createNode', [
        { nodeId: 'node-2', kind: 'page', parentId: null, classIds: [] },
      ]);

      if (worker.onerror) {
        worker.onerror(new ErrorEvent('error', { message: 'boom' }));
      }

      await expect(p1).rejects.toThrow('Worker error: boom');
      await expect(p2).rejects.toThrow('Worker error: boom');
      expect(worker.terminate).toHaveBeenCalled();
      mainClient.close();
    });

    it('uses a longer timeout for init requests', async () => {
      const worker = createMockWorker();
      const mainClient = new WorkerStoreClient(worker);
      const promise = mainClient.init('ws-1', 'actor-1').catch((err: Error) => err);

      vi.advanceTimersByTime(35_000);
      // Should still be pending at 35s; reject by advancing to 65s.
      vi.advanceTimersByTime(30_000);

      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('timed out after 60000ms');
      mainClient.close();
    });

    it('clears the timeout when a response arrives', async () => {
      const worker = createMockWorker();
      const mainClient = new WorkerStoreClient(worker);
      const promise = mainClient.query('getNode', ['node-1']);
      const requestId = getLastRequestId(worker);

      if (worker.onmessage) {
        worker.onmessage(
          new MessageEvent('message', {
            data: { type: 'query-result', id: requestId, result: { id: 'node-1' } },
          })
        );
      }

      const result = await promise;
      expect(result).toEqual({ id: 'node-1' });

      // Ensure the timeout timer was cleared and the worker is still alive.
      await vi.advanceTimersByTimeAsync(35_000);
      expect(worker.terminate).not.toHaveBeenCalled();
      mainClient.close();
    });
  });
});
