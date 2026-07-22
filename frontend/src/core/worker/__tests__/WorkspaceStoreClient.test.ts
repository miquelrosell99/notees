import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createWorkspaceStoreClient,
  resetSharedWorkspaceStoreClient,
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
});
