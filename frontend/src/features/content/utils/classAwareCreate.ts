/**
 * Class-aware create flow (Task 6; Decisions 17-19).
 *
 * The standard node-link picker (NodeSelector for property editors,
 * TriggerPopup for slash-menu insertion) interprets "create" according to the
 * class filter in force:
 *
 * - filter on `source` (or a subclass)  -> source quick-create: a properly
 *   classed source page with authors/DOI/publication year.
 * - filter on `asset`                   -> file selector + upload, reusing the
 *   existing upload path (node.create + class.assign + asset.upload).
 * - filter on `agent` / `person` / `organization` -> minimal agent creator:
 *   person gets given_name/family_name, organization just a name.
 *
 * The resolution is generic: it walks the class hierarchy (via the shared
 * helpers in core/query/classFilter.ts) and contains no picker-specific or
 * property-specific special-casing.
 */
import type { Node } from '@/types';
import {
  SYSTEM_CLASS_EXTENDS,
  SYSTEM_CLASS_UUIDS,
  SYSTEM_PROPERTY_UUIDS,
} from '@/constants/systemProperties';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import { uuidv7 } from '@/core/uuid';
import { projectNodeFromClient } from '@/core/adapters/nodeProjection';
import type { ClassHierarchyEntry } from '@/core/query/classFilter';
import { uploadAsset } from '@/features/assets';
import { getOrCreateYearlyNoteClient } from '../hooks/useNodeDateQueries';

export type ClassAwareCreateKind = 'source' | 'asset' | 'agent';

export interface ClassAwareCreatePlan {
  kind: ClassAwareCreateKind;
  /**
   * Class to preselect in the create dialog: the filtered subclass when the
   * filter unambiguously identifies one (e.g. `book`, `organization`), a
   * sensible default for superclass filters (`book` for `source`, `person`
   * for `agent`).
   */
  defaultClassUuid: string;
}

type SystemClassName = keyof typeof SYSTEM_CLASS_UUIDS;

function systemClassUuid(name: SystemClassName): string {
  return SYSTEM_CLASS_UUIDS[name];
}

/** System class UUIDs that extend `source`, in canonical seed order. */
export const SOURCE_SUBCLASS_UUIDS: string[] = Object.entries(SYSTEM_CLASS_EXTENDS)
  .filter(([, parents]) => parents.includes('source'))
  .map(([name]) => systemClassUuid(name as SystemClassName));

/** MDI icon paths for the source subclasses (SelectionButton is icon-only). */
const SOURCE_SUBCLASS_ICONS: Record<string, string> = {
  book: 'mdi mdi-book-open-variant',
  paper: 'mdi mdi-newspaper-variant-outline',
  article: 'mdi mdi-newspaper',
  thesis: 'mdi mdi-school-outline',
  document: 'mdi mdi-file-outline',
  movie: 'mdi mdi-movie-open-outline',
};

/** Selector options for the source-class picker, in canonical seed order. */
export const SOURCE_SUBCLASS_OPTIONS: Array<{ value: string; label: string; icon: string }> =
  Object.entries(SYSTEM_CLASS_EXTENDS)
    .filter(([, parents]) => parents.includes('source'))
    .map(([name]) => ({
      value: systemClassUuid(name as SystemClassName),
      label: sourceClassLabel(systemClassUuid(name as SystemClassName)),
      icon: SOURCE_SUBCLASS_ICONS[name] ?? 'mdi mdi-file-outline',
    }));

/** Display label for a system class UUID ("book" -> "Book"). */
export function sourceClassLabel(classUuid: string): string {
  const entry = Object.entries(SYSTEM_CLASS_UUIDS).find(([, uuid]) => uuid === classUuid);
  if (!entry) return 'Source';
  return entry[0].charAt(0).toUpperCase() + entry[0].slice(1);
}

/**
 * Collect a class UUID plus all of its ancestors by walking `extends_uuid`
 * edges upward, with the static system extends edges as a fallback so system
 * subclasses resolve even before the class list has loaded.
 */
function collectSelfAndAncestors(
  classUuid: string,
  classes: ClassHierarchyEntry[],
): Set<string> {
  const parentsByChild = new Map<string, string[]>();
  for (const cls of classes) {
    if (cls.extends_uuid && cls.extends_uuid.length > 0) {
      parentsByChild.set(cls.uuid, cls.extends_uuid);
    }
  }
  for (const [name, parents] of Object.entries(SYSTEM_CLASS_EXTENDS)) {
    const childUuid = systemClassUuid(name as SystemClassName);
    if (!parentsByChild.has(childUuid)) {
      parentsByChild.set(childUuid, parents.map((p) => systemClassUuid(p as SystemClassName)));
    }
  }

  const lineage = new Set<string>();
  const stack = [classUuid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (lineage.has(current)) continue;
    lineage.add(current);
    for (const parent of parentsByChild.get(current) ?? []) {
      stack.push(parent);
    }
  }
  return lineage;
}

/**
 * Resolve how "create" should behave under the given class filters.
 * Returns null when no class-aware flow applies (plain node create).
 */
export function resolveClassAwareCreate(
  classFilters: string[],
  classes: ClassHierarchyEntry[],
): ClassAwareCreatePlan | null {
  for (const filterUuid of classFilters) {
    const lineage = collectSelfAndAncestors(filterUuid, classes);

    if (lineage.has(SYSTEM_CLASS_UUIDS.asset)) {
      return { kind: 'asset', defaultClassUuid: SYSTEM_CLASS_UUIDS.asset };
    }
    if (lineage.has(SYSTEM_CLASS_UUIDS.source)) {
      const isSubclass = filterUuid !== SYSTEM_CLASS_UUIDS.source;
      return {
        kind: 'source',
        defaultClassUuid: isSubclass ? filterUuid : SYSTEM_CLASS_UUIDS.book,
      };
    }
    if (lineage.has(SYSTEM_CLASS_UUIDS.agent)) {
      const defaultClassUuid =
        filterUuid === SYSTEM_CLASS_UUIDS.organization
          ? SYSTEM_CLASS_UUIDS.organization
          : SYSTEM_CLASS_UUIDS.person;
      return { kind: 'agent', defaultClassUuid };
    }
  }
  return null;
}

// ─── Node creators (store-level; take an injected client for testability) ───

export interface SourceCreateInput {
  title: string;
  /** Source class to assign (source itself or a subclass such as book). */
  classUuid: string;
  /** Agent node UUIDs for the system `authors` property. */
  authorUuids?: string[];
  doi?: string;
  /** Optional 4-digit publication year; stored as a ref to the year page. */
  publicationYear?: number | null;
}

/**
 * Create a properly classed source node (page kind by default) with the
 * system bibliographic properties that were provided.
 */
export async function createSourceNode(
  client: IWorkspaceStoreClient,
  input: SourceCreateInput,
): Promise<Node> {
  const nodeId = uuidv7();
  await client.mutate<void>('createNode', [
    { nodeId, kind: 'page', parentId: null, classIds: [input.classUuid] },
  ]);
  await client.mutate<void>('setNodeText', [nodeId, input.title]);

  if (input.authorUuids && input.authorUuids.length > 0) {
    await client.mutate<void>('setProperty', [
      {
        propertyValueId: uuidv7(),
        nodeId,
        schemaId: SYSTEM_PROPERTY_UUIDS.authors,
        value: input.authorUuids,
      },
    ]);
  }

  const doi = input.doi?.trim();
  if (doi) {
    await client.mutate<void>('setProperty', [
      { propertyValueId: uuidv7(), nodeId, schemaId: SYSTEM_PROPERTY_UUIDS.doi, value: doi },
    ]);
  }

  if (input.publicationYear != null && Number.isInteger(input.publicationYear)) {
    const yearNode = await getOrCreateYearlyNoteClient(client, input.publicationYear);
    await client.mutate<void>('setProperty', [
      {
        propertyValueId: uuidv7(),
        nodeId,
        schemaId: SYSTEM_PROPERTY_UUIDS.publication_date,
        value: yearNode.uuid,
      },
    ]);
  }

  const node = await projectNodeFromClient(client, nodeId);
  if (!node) throw new Error('Failed to project created source node');
  return node;
}

/**
 * Split a free-typed person name into given/family parts. The last word is
 * the family name; a single word is treated as the family name (Zotero
 * single-field convention), which keeps citekey generation usable.
 */
export function splitPersonName(name: string): { givenName: string; familyName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { givenName: '', familyName: '' };
  if (parts.length === 1) return { givenName: '', familyName: parts[0] };
  return { givenName: parts.slice(0, -1).join(' '), familyName: parts[parts.length - 1] };
}

export interface AgentCreateInput {
  agentType: 'person' | 'organization';
  /** Organization display name (ignored for persons). */
  name?: string;
  /** Person given name (ignored for organizations). */
  givenName?: string;
  /** Person family name (ignored for organizations). */
  familyName?: string;
}

/**
 * Create a minimal agent node: persons carry `given_name`/`family_name`
 * (feeding citekey generation) and their display name is the full natural
 * name; organizations carry just a name. Deliberately no contact-manager
 * fields (Decision 19).
 */
export async function createAgentNode(
  client: IWorkspaceStoreClient,
  input: AgentCreateInput,
): Promise<Node> {
  const isPerson = input.agentType === 'person';
  const displayName = isPerson
    ? [input.givenName?.trim(), input.familyName?.trim()].filter(Boolean).join(' ')
    : (input.name ?? '').trim();
  if (!displayName) throw new Error('Agent name is required');

  const nodeId = uuidv7();
  await client.mutate<void>('createNode', [
    {
      nodeId,
      kind: 'page',
      parentId: null,
      classIds: [
        isPerson ? SYSTEM_CLASS_UUIDS.person : SYSTEM_CLASS_UUIDS.organization,
      ],
    },
  ]);
  await client.mutate<void>('setNodeText', [nodeId, displayName]);

  if (isPerson) {
    const givenName = input.givenName?.trim();
    const familyName = input.familyName?.trim();
    if (givenName) {
      await client.mutate<void>('setProperty', [
        { propertyValueId: uuidv7(), nodeId, schemaId: SYSTEM_PROPERTY_UUIDS.given_name, value: givenName },
      ]);
    }
    if (familyName) {
      await client.mutate<void>('setProperty', [
        { propertyValueId: uuidv7(), nodeId, schemaId: SYSTEM_PROPERTY_UUIDS.family_name, value: familyName },
      ]);
    }
  }

  const node = await projectNodeFromClient(client, nodeId);
  if (!node) throw new Error('Failed to project created agent node');
  return node;
}

/**
 * Upload a file as an asset node (reusing the existing upload path) and
 * return the asset as a Node so pickers can link/set it immediately. In
 * server mode the node may only arrive via sync; a minimal stub is returned
 * then — callers only need the UUID, and display resolves on projection.
 */
export async function uploadAssetAsNode(
  client: IWorkspaceStoreClient,
  file: File,
): Promise<Node> {
  const asset = await uploadAsset(file);
  const node = await projectNodeFromClient(client, asset.node_uuid);
  if (node) return node;

  const now = new Date().toISOString();
  return {
    uuid: asset.node_uuid,
    name: asset.filename,
    content: asset.filename,
    icon: null,
    color: null,
    parent_uuid: null,
    page_uuid: null,
    sequence: 0,
    active: true,
    is_page: false,
    is_class: false,
    create_date: now,
    write_date: now,
    open_date: null,
    tags_uuid: [],
    classes_uuid: [SYSTEM_CLASS_UUIDS.asset],
    classes_path_uuid: [],
    properties_uuid: {},
    children: undefined,
    has_children: false,
    backlinks: [],
    linked_references: [],
    backlink_count: 0,
    comment_count: 0,
    aliases_uuid: [],
    aliased_uuid: null,
    extends_uuid: [],
    is_private: false,
    parent_locked: false,
  };
}
