/**
 * React Query hooks for the template system.
 *
 * Templates are pages that carry the system `template` class. Variables are
 * parsed from the template node's content text, and instantiation creates a
 * new node from the template content.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { templateKeys, nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';
import { uuidv7 } from '@/core/uuid';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import type { Node, PaginatedResponse } from '@/types/api';
import type { NodeRow } from '@/core/store';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';

export interface TemplateInstantiateOptions {
  parent_uuid?: string;
  name?: string;
  variables?: Record<string, string>;
  dynamic_context?: Record<string, string>;
  as_blocks?: boolean;
  after_uuid?: string;
}

export interface TemplateInstantiateResult {
  node: Node | null;
  blocks: Node[];
  as_blocks: boolean;
}

export interface TemplateVariablesResult {
  variables: string[];
  dynamic_variables: string[];
}

const STATIC_VAR_REGEX = /\{\{([\s\S]+?)\}\}/g;
const DYNAMIC_VAR_REGEX = /<%([\s\S]+?)%>/g;

function extractVariables(text: string): TemplateVariablesResult {
  const staticMatches = new Set<string>();
  const dynamicMatches = new Set<string>();

  let match: RegExpExecArray | null;

  STATIC_VAR_REGEX.lastIndex = 0;
  while ((match = STATIC_VAR_REGEX.exec(text)) !== null) {
    staticMatches.add(match[1].trim());
  }

  DYNAMIC_VAR_REGEX.lastIndex = 0;
  while ((match = DYNAMIC_VAR_REGEX.exec(text)) !== null) {
    dynamicMatches.add(match[1].trim());
  }

  return {
    variables: Array.from(staticMatches),
    dynamic_variables: Array.from(dynamicMatches),
  };
}

function applySubstitutions(
  content: unknown[],
  variables: Record<string, string>,
  dynamicContext: Record<string, string>
): unknown[] {
  return JSON.parse(
    JSON.stringify(content, (_key, value) => {
      if (typeof value !== 'string') return value;
      return value
        .replace(STATIC_VAR_REGEX, (_, name) => variables[name.trim()] ?? '')
        .replace(DYNAMIC_VAR_REGEX, (_, name) => dynamicContext[name.trim()] ?? '');
    })
  ) as unknown[];
}

export function useTemplates() {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading: storeLoading, error: storeError } =
    useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<PaginatedResponse<Node>, Error>({
    queryKey: templateKeys.list(),
    queryFn: async () => {
      if (!client) throw new Error('Workspace store is not ready');
      const items = await client.query<Node[]>('queryNodes', [
        { classIds: [SYSTEM_CLASS_UUIDS.template], projectionDepth: 0 },
      ]);
      return {
        items,
        total: items.length,
        page: 1,
        page_size: items.length,
        has_next: false,
        has_prev: false,
      };
    },
    enabled: !!client,
    staleTime: 30_000,
  });

  return {
    ...result,
    isLoading: result.isLoading || storeLoading,
    error: result.error ?? storeError,
  };
}

export function useTemplateVariables(nodeUuid: string | null) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client, isLoading: storeLoading, error: storeError } =
    useWorkspaceStoreClient(workspaceUuid ?? '');

  const result = useQuery<TemplateVariablesResult, Error>({
    queryKey: templateKeys.variables(nodeUuid ?? ''),
    queryFn: async () => {
      if (!nodeUuid || !client) {
        throw new Error('Node UUID or workspace store not found');
      }
      const node = await client.query<NodeRow | undefined>('getNode', [nodeUuid]);
      if (!node) throw new Error('Template node not found');
      const text =
        typeof node.content === 'string' && node.content.length > 0
          ? node.content
          : '[]';
      let contentText = text;
      try {
        contentText = JSON.stringify(JSON.parse(text));
      } catch {
        // content is not JSON; use it as plain text
      }
      return extractVariables(contentText);
    },
    enabled: nodeUuid != null && !!client,
    staleTime: 60_000,
  });

  return {
    ...result,
    isLoading: result.isLoading || storeLoading,
    error: result.error ?? storeError,
  };
}

async function instantiateNode(
  client: IWorkspaceStoreClient,
  templateUuid: string,
  options: TemplateInstantiateOptions
): Promise<TemplateInstantiateResult> {
  const template = await client.query<NodeRow | undefined>('getNode', [
    templateUuid,
  ]);
  if (!template) throw new Error('Template node not found');

  const templateContent: unknown[] =
    typeof template.content === 'string' && template.content.length > 0
      ? (JSON.parse(template.content) as unknown[])
      : [];

  const variables = options.variables ?? {};
  const dynamicContext = options.dynamic_context ?? {};
  const substitutedContent = applySubstitutions(
    templateContent,
    variables,
    dynamicContext
  );

  if (options.as_blocks) {
    const parentId = options.parent_uuid ?? template.parentId;
    if (!parentId) throw new Error('Parent UUID is required for block instantiation');

    const blockId = uuidv7();
    await client.mutate<void>('createNode', [
      {
        nodeId: blockId,
        kind: 'block',
        parentId,
        classIds: [],
      },
    ]);
    await client.mutate<void>('moveNode', [blockId, parentId]);
    await client.mutate<void>('updateContentAst', [
      blockId,
      substitutedContent,
    ]);

    const projected = await client.query<Node | undefined>('projectNode', [
      blockId,
      0,
    ]);
    if (!projected) throw new Error('Failed to project instantiated block');
    return { node: null, blocks: [projected], as_blocks: true };
  }

  const pageId = uuidv7();
  const classIds = template.classIds.filter(
    (id) => id !== SYSTEM_CLASS_UUIDS.template
  );
  await client.mutate<void>('createNode', [
    {
      nodeId: pageId,
      kind: 'page',
      parentId: null,
      classIds,
    },
  ]);
  await client.mutate<void>('updateContentAst', [
    pageId,
    substitutedContent,
  ]);

  const projected = await client.query<Node | undefined>('projectNode', [
    pageId,
    1,
  ]);
  if (!projected) throw new Error('Failed to project instantiated page');
  return { node: projected, blocks: [projected], as_blocks: false };
}

export function useInstantiateTemplate() {
  const queryClient = useQueryClient();
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { client } = useWorkspaceStoreClient(workspaceUuid ?? '');

  return useMutation<
    TemplateInstantiateResult,
    Error,
    { nodeUuid: string; options: TemplateInstantiateOptions }
  >({
    mutationFn: async ({ nodeUuid, options }) => {
      if (!nodeUuid || !client) {
        throw new Error('Node UUID or workspace store not found');
      }
      return instantiateNode(client, nodeUuid, options);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: nodeKeys.all });
    },
  });
}
