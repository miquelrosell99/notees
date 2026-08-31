/**
 * Pure profile-editor logic for the Export Profiles plugin.
 *
 * Convenience presets (class picker, collection picker) compile to QueryAST
 * here; the backend compiles the same AST to SQL (same query → same
 * selection in UI, API, and export). Kept React-free so it is unit-testable.
 */

import type { QueryAST } from '@/types/queryAST';
import type { ExportProfile, ProfileQuery } from './types';

export const DEFAULT_FILENAME_TEMPLATE = '/{class}/{citekey}.{ext}';

export const ROLE_OPTIONS = [
  'representation',
  'cover',
  'supplement',
  'attachment',
  'generated',
  'thumbnail',
  'other',
] as const;

export type SelectionMode = 'class' | 'collection' | 'saved_query' | 'ast';

export interface ProfileFormState {
  id?: string;
  name: string;
  enabled: boolean;
  selectionMode: SelectionMode;
  classUuid: string;
  collectionUuid: string;
  savedQueryId: string;
  astJson: string;
  destination: string;
  filenameTemplate: string;
  roles: string[];
  /** Comma-separated MIME types; empty means "all". */
  mimeTypes: string;
}

export function emptyFormState(): ProfileFormState {
  return {
    name: '',
    enabled: true,
    selectionMode: 'class',
    classUuid: '',
    collectionUuid: '',
    savedQueryId: '',
    astJson: '',
    destination: '',
    filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
    roles: ['representation'],
    mimeTypes: '',
  };
}

/** class:<uuid> query AST — hierarchy-aware via the backend closure compiler. */
export function buildClassPresetQuery(classUuid: string): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        {
          type: 'condition',
          condition_type: 'class',
          class_uuid: classUuid,
        },
      ],
    },
  };
}

/**
 * collection:<uuid> query AST — membership via nesting (v1): sources nested
 * anywhere under the collection node. Compiles to a parent_path condition
 * with a static uuid group, which the backend compiler supports.
 */
export function buildCollectionPresetQuery(collectionUuid: string): QueryAST {
  return {
    type: 'query',
    version: '1.0',
    scope: { type: 'scope', scope_type: 'entire_workspace' },
    root_group: {
      type: 'group',
      logic: 'AND',
      children: [
        {
          type: 'condition',
          condition_type: 'parent_path',
          operator: 'has_ancestor',
          nested_group: {
            type: 'group',
            logic: 'AND',
            children: [
              {
                type: 'condition',
                condition_type: 'property',
                property_name: 'uuid',
                property_type: 'text',
                operator: 'equals',
                value: collectionUuid,
              },
            ],
          },
        },
      ],
    },
  };
}

export class ProfileFormError extends Error {}

function validateDestination(destination: string): void {
  if (!destination) return;
  const normalized = destination.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new ProfileFormError('Destination must be a relative path');
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new ProfileFormError("Destination must not contain '..' segments");
  }
}

function validateFilenameTemplate(template: string): void {
  if (!template.trim()) {
    throw new ProfileFormError('Filename template must not be empty');
  }
  const normalized = template.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new ProfileFormError("Filename template must not contain '..' segments");
  }
}

function buildQuery(form: ProfileFormState): ProfileQuery {
  switch (form.selectionMode) {
    case 'class':
      if (!form.classUuid) throw new ProfileFormError('Pick a class for the selection');
      return { ast: buildClassPresetQuery(form.classUuid) };
    case 'collection':
      if (!form.collectionUuid) {
        throw new ProfileFormError('Pick a collection for the selection');
      }
      return { ast: buildCollectionPresetQuery(form.collectionUuid) };
    case 'saved_query':
      if (!form.savedQueryId.trim()) {
        throw new ProfileFormError('Saved query id is required');
      }
      return { saved_query_id: form.savedQueryId.trim() };
    case 'ast': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(form.astJson);
      } catch {
        throw new ProfileFormError('Query AST is not valid JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ProfileFormError('Query AST must be a JSON object');
      }
      return { ast: parsed as QueryAST };
    }
  }
}

/** Convert editor state into a backend profile payload (validates). */
export function formToProfile(form: ProfileFormState): Omit<ExportProfile, 'id'> & { id?: string } {
  if (!form.name.trim()) throw new ProfileFormError('Profile name is required');
  validateDestination(form.destination.trim());
  validateFilenameTemplate(form.filenameTemplate);

  const mimeTypes = form.mimeTypes
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    ...(form.id ? { id: form.id } : {}),
    name: form.name.trim(),
    enabled: form.enabled,
    provider: 'bibliographic',
    query: buildQuery(form),
    destination: form.destination.trim(),
    materializer: 'copy',
    reconciliation_policy: 'sync',
    provider_config: {
      asset_filter: {
        roles: form.roles.length > 0 ? form.roles : null,
        mime_types: mimeTypes.length > 0 ? mimeTypes : null,
      },
      filename_template: form.filenameTemplate,
    },
  };
}

function detectSelection(query: ProfileQuery): Partial<ProfileFormState> {
  if ('saved_query_id' in query) {
    return { selectionMode: 'saved_query', savedQueryId: query.saved_query_id };
  }
  const ast = query.ast as QueryAST;
  const children = ast?.root_group?.children ?? [];
  if (children.length === 1) {
    const child = children[0] as unknown as Record<string, unknown>;
    if (child.condition_type === 'class' && typeof child.class_uuid === 'string') {
      return { selectionMode: 'class', classUuid: child.class_uuid };
    }
    if (child.condition_type === 'parent_path') {
      const nested = (child.nested_group as { children?: Array<Record<string, unknown>> })
        ?.children?.[0];
      if (nested?.property_name === 'uuid' && typeof nested.value === 'string') {
        return { selectionMode: 'collection', collectionUuid: nested.value };
      }
    }
  }
  return { selectionMode: 'ast', astJson: JSON.stringify(ast, null, 2) };
}

/** Convert a stored profile back into editor state (best-effort preset detection). */
export function profileToForm(profile: ExportProfile): ProfileFormState {
  const filter = profile.provider_config?.asset_filter ?? {};
  return {
    ...emptyFormState(),
    id: profile.id,
    name: profile.name,
    enabled: profile.enabled,
    destination: profile.destination,
    filenameTemplate:
      profile.provider_config?.filename_template ?? DEFAULT_FILENAME_TEMPLATE,
    roles: filter.roles ?? [],
    mimeTypes: (filter.mime_types ?? []).join(', '),
    ...detectSelection(profile.query),
  };
}
