/**
 * Store-level tests for the class-aware create flow (Task 6; Decisions 17-19).
 *
 * The UI dialogs are thin wrappers; these tests cover the plan resolution and
 * the node creators against a real WorkspaceStore via the inline client.
 */
import { describe, it, expect } from 'vitest';
import { createWorkspaceStoreClient } from '@/core/worker/WorkspaceStoreClient';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import { createOperation } from '@/core/types/operation';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { uuidv7 } from '@/core/uuid';
import {
  createAgentNode,
  createSourceNode,
  resolveClassAwareCreate,
  splitPersonName,
} from './classAwareCreate';

async function createClient(): Promise<IWorkspaceStoreClient> {
  const client = createWorkspaceStoreClient();
  await client.init(uuidv7(), uuidv7());
  return client;
}

/**
 * Seed the system agent classes with their extends edges, so the
 * class_hierarchy closure exists (production gets this from the seed).
 */
async function seedAgentClasses(client: IWorkspaceStoreClient): Promise<void> {
  const workspaceId = await client.query<string>('getWorkspaceId', []);
  const actorId = await client.query<string>('getActorId', []);
  let hlc = 0;
  const makeOp = (classId: string, name: string, parents: string[]) =>
    createOperation(
      {
        workspaceId,
        actorId,
        hlc: { physical: ++hlc, logical: 0 },
        affectedNodeIds: [classId],
        opType: 'class.create',
      },
      { classId, name, extends: parents }
    );
  await client.mutate<number>('applyMany', [[
    makeOp(SYSTEM_CLASS_UUIDS.agent, 'agent', []),
    makeOp(SYSTEM_CLASS_UUIDS.person, 'person', [SYSTEM_CLASS_UUIDS.agent]),
    makeOp(SYSTEM_CLASS_UUIDS.organization, 'organization', [SYSTEM_CLASS_UUIDS.agent]),
  ]]);
}

/** Read a property value off the projected node (schema UUID -> parsed value). */
function propertyValue(node: { properties_uuid?: Record<string, unknown> }, schemaId: string): unknown {
  return node.properties_uuid?.[schemaId];
}

describe('resolveClassAwareCreate', () => {
  it('returns null without filters or for unrelated classes', () => {
    expect(resolveClassAwareCreate([], [])).toBeNull();
    expect(resolveClassAwareCreate([SYSTEM_CLASS_UUIDS.task], [])).toBeNull();
  });

  it('resolves a plain source filter to the source flow (default book)', () => {
    expect(resolveClassAwareCreate([SYSTEM_CLASS_UUIDS.source], [])).toEqual({
      kind: 'source',
      defaultClassUuid: SYSTEM_CLASS_UUIDS.book,
    });
  });

  it('resolves a source-subclass filter with that subclass as default', () => {
    expect(resolveClassAwareCreate([SYSTEM_CLASS_UUIDS.paper], [])).toEqual({
      kind: 'source',
      defaultClassUuid: SYSTEM_CLASS_UUIDS.paper,
    });
  });

  it('resolves user subclasses of source through live hierarchy data', () => {
    const classes = [{ uuid: 'my-zine-class', extends_uuid: [SYSTEM_CLASS_UUIDS.source] }];
    expect(resolveClassAwareCreate(['my-zine-class'], classes)).toEqual({
      kind: 'source',
      defaultClassUuid: 'my-zine-class',
    });
  });

  it('resolves agent filters, preselecting the filtered agent type', () => {
    expect(resolveClassAwareCreate([SYSTEM_CLASS_UUIDS.agent], [])).toEqual({
      kind: 'agent',
      defaultClassUuid: SYSTEM_CLASS_UUIDS.person,
    });
    expect(resolveClassAwareCreate([SYSTEM_CLASS_UUIDS.person], [])).toEqual({
      kind: 'agent',
      defaultClassUuid: SYSTEM_CLASS_UUIDS.person,
    });
    expect(resolveClassAwareCreate([SYSTEM_CLASS_UUIDS.organization], [])).toEqual({
      kind: 'agent',
      defaultClassUuid: SYSTEM_CLASS_UUIDS.organization,
    });
  });

  it('resolves the asset filter to the upload flow', () => {
    expect(resolveClassAwareCreate([SYSTEM_CLASS_UUIDS.asset], [])).toEqual({
      kind: 'asset',
      defaultClassUuid: SYSTEM_CLASS_UUIDS.asset,
    });
  });
});

describe('splitPersonName', () => {
  it('splits the last word as the family name', () => {
    expect(splitPersonName('Frank Herbert')).toEqual({ givenName: 'Frank', familyName: 'Herbert' });
    expect(splitPersonName('Ursula K. Le Guin')).toEqual({ givenName: 'Ursula K. Le', familyName: 'Guin' });
  });

  it('treats a single word as the family name', () => {
    expect(splitPersonName('Voltaire')).toEqual({ givenName: '', familyName: 'Voltaire' });
  });

  it('handles empty input', () => {
    expect(splitPersonName('  ')).toEqual({ givenName: '', familyName: '' });
  });
});

describe('createAgentNode', () => {
  it('creates a person with given/family name and a natural display name', async () => {
    const client = await createClient();
    const node = await createAgentNode(client, {
      agentType: 'person',
      givenName: 'Frank',
      familyName: 'Herbert',
    });

    expect(node.classes_uuid).toContain(SYSTEM_CLASS_UUIDS.person);
    expect(node.name).toBe('Frank Herbert');
    expect(propertyValue(node, SYSTEM_PROPERTY_UUIDS.given_name)).toBe('Frank');
    expect(propertyValue(node, SYSTEM_PROPERTY_UUIDS.family_name)).toBe('Herbert');
  });

  it('creates an organization with just a name', async () => {
    const client = await createClient();
    const node = await createAgentNode(client, {
      agentType: 'organization',
      name: 'Penguin Books',
    });

    expect(node.classes_uuid).toContain(SYSTEM_CLASS_UUIDS.organization);
    expect(node.name).toBe('Penguin Books');
    expect(propertyValue(node, SYSTEM_PROPERTY_UUIDS.given_name)).toBeUndefined();
  });

  it('rejects empty names', async () => {
    const client = await createClient();
    await expect(createAgentNode(client, { agentType: 'person' })).rejects.toThrow();
  });

  it('a later search by family name offers the same person node (dedupe)', async () => {
    const client = await createClient();
    await seedAgentClasses(client);
    const node = await createAgentNode(client, {
      agentType: 'person',
      givenName: 'Frank',
      familyName: 'Herbert',
    });

    const matches = await client.query<Array<{ uuid: string }>>('queryNodes', [
      { query: 'Herbert', classIds: [SYSTEM_CLASS_UUIDS.agent], projectionDepth: 0 },
    ]);
    expect(matches.map((n) => n.uuid)).toContain(node.uuid);
  });
});

describe('createSourceNode', () => {
  it('creates a classed source page with authors, DOI and publication year', async () => {
    const client = await createClient();
    const author = await createAgentNode(client, {
      agentType: 'person',
      givenName: 'Frank',
      familyName: 'Herbert',
    });

    const node = await createSourceNode(client, {
      title: 'Dune',
      classUuid: SYSTEM_CLASS_UUIDS.book,
      authorUuids: [author.uuid],
      doi: '10.1000/dune',
      publicationYear: 1965,
    });

    expect(node.is_page).toBe(true);
    expect(node.classes_uuid).toContain(SYSTEM_CLASS_UUIDS.book);
    expect(node.name).toBe('Dune');
    expect(propertyValue(node, SYSTEM_PROPERTY_UUIDS.authors)).toEqual([author.uuid]);
    expect(propertyValue(node, SYSTEM_PROPERTY_UUIDS.doi)).toBe('10.1000/dune');

    // The year is stored as a reference to the year page.
    const yearRef = propertyValue(node, SYSTEM_PROPERTY_UUIDS.publication_date);
    expect(typeof yearRef).toBe('string');
    const yearNode = await client.query<{ name: string } | undefined>('projectNode', [yearRef]);
    expect(yearNode?.name).toContain('1965');
  });

  it('creates a minimal source without optional fields', async () => {
    const client = await createClient();
    const node = await createSourceNode(client, {
      title: 'Minimal',
      classUuid: SYSTEM_CLASS_UUIDS.source,
    });

    expect(node.classes_uuid).toContain(SYSTEM_CLASS_UUIDS.source);
    expect(propertyValue(node, SYSTEM_PROPERTY_UUIDS.authors)).toBeUndefined();
  });
});
