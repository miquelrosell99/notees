import { describe, expect, it } from 'vitest';

import {
  buildClassPresetQuery,
  buildCollectionPresetQuery,
  DEFAULT_FILENAME_TEMPLATE,
  emptyFormState,
  formToProfile,
  ProfileFormError,
  profileToForm,
} from './profileForm';
import type { ExportProfile } from './types';

const BOOK_UUID = '00000000-0000-0000-0001-000000000024';
const COLLECTION_UUID = '11111111-2222-3333-4444-555555555555';

describe('buildClassPresetQuery', () => {
  it('compiles a class condition AST', () => {
    const ast = buildClassPresetQuery(BOOK_UUID);
    expect(ast.scope.scope_type).toBe('entire_workspace');
    expect(ast.root_group.children).toEqual([
      { type: 'condition', condition_type: 'class', class_uuid: BOOK_UUID },
    ]);
  });
});

describe('buildCollectionPresetQuery', () => {
  it('compiles a parent_path AST with a static uuid group', () => {
    const ast = buildCollectionPresetQuery(COLLECTION_UUID);
    const child = ast.root_group.children[0] as Record<string, any>;
    expect(child.condition_type).toBe('parent_path');
    const nested = child.nested_group.children[0];
    expect(nested.property_name).toBe('uuid');
    expect(nested.value).toBe(COLLECTION_UUID);
  });
});

describe('formToProfile', () => {
  it('builds a bibliographic profile from a class preset', () => {
    const form = { ...emptyFormState(), name: 'Books', classUuid: BOOK_UUID };
    const profile = formToProfile(form);
    expect(profile.provider).toBe('bibliographic');
    expect(profile.materializer).toBe('copy');
    expect(profile.reconciliation_policy).toBe('sync');
    expect(profile.provider_config.filename_template).toBe(DEFAULT_FILENAME_TEMPLATE);
    expect(profile.provider_config.asset_filter?.roles).toEqual(['representation']);
    expect('ast' in profile.query && profile.query.ast.root_group.children[0]).toMatchObject({
      condition_type: 'class',
      class_uuid: BOOK_UUID,
    });
  });

  it('defaults missing roles/mime to null (all)', () => {
    const form = { ...emptyFormState(), name: 'x', classUuid: BOOK_UUID, roles: [] };
    const profile = formToProfile(form);
    expect(profile.provider_config.asset_filter?.roles).toBeNull();
    expect(profile.provider_config.asset_filter?.mime_types).toBeNull();
  });

  it('parses comma-separated MIME types', () => {
    const form = {
      ...emptyFormState(),
      name: 'x',
      classUuid: BOOK_UUID,
      mimeTypes: 'application/epub+zip, application/pdf ,',
    };
    const profile = formToProfile(form);
    expect(profile.provider_config.asset_filter?.mime_types).toEqual([
      'application/epub+zip',
      'application/pdf',
    ]);
  });

  it('rejects traversal in template and destination', () => {
    expect(() =>
      formToProfile({
        ...emptyFormState(),
        name: 'x',
        classUuid: BOOK_UUID,
        filenameTemplate: '../../etc/x',
      }),
    ).toThrow(ProfileFormError);
    expect(() =>
      formToProfile({
        ...emptyFormState(),
        name: 'x',
        classUuid: BOOK_UUID,
        destination: '../escape',
      }),
    ).toThrow(ProfileFormError);
    expect(() =>
      formToProfile({
        ...emptyFormState(),
        name: 'x',
        classUuid: BOOK_UUID,
        destination: '/abs/path',
      }),
    ).toThrow(ProfileFormError);
  });

  it('requires a name, a selection, and a template', () => {
    expect(() => formToProfile(emptyFormState())).toThrow(ProfileFormError);
    expect(() =>
      formToProfile({ ...emptyFormState(), name: 'x', classUuid: '' }),
    ).toThrow(ProfileFormError);
    expect(() =>
      formToProfile({
        ...emptyFormState(),
        name: 'x',
        classUuid: BOOK_UUID,
        filenameTemplate: '  ',
      }),
    ).toThrow(ProfileFormError);
  });

  it('validates raw AST JSON in ast mode', () => {
    expect(() =>
      formToProfile({
        ...emptyFormState(),
        name: 'x',
        selectionMode: 'ast',
        astJson: '{invalid',
      }),
    ).toThrow(ProfileFormError);
    const profile = formToProfile({
      ...emptyFormState(),
      name: 'x',
      selectionMode: 'ast',
      astJson: JSON.stringify(buildClassPresetQuery(BOOK_UUID)),
    });
    expect('ast' in profile.query).toBe(true);
  });

  it('uses saved query refs verbatim', () => {
    const profile = formToProfile({
      ...emptyFormState(),
      name: 'x',
      selectionMode: 'saved_query',
      savedQueryId: ' view-1 ',
    });
    expect(profile.query).toEqual({ saved_query_id: 'view-1' });
  });
});

describe('profileToForm round-trips', () => {
  const baseProfile: ExportProfile = {
    id: 'p-1',
    name: 'Books',
    enabled: true,
    provider: 'bibliographic',
    query: { ast: buildClassPresetQuery(BOOK_UUID) },
    destination: '',
    materializer: 'copy',
    reconciliation_policy: 'sync',
    provider_config: {
      asset_filter: { roles: ['representation'], mime_types: null },
      filename_template: DEFAULT_FILENAME_TEMPLATE,
    },
  };

  it('detects the class preset', () => {
    const form = profileToForm(baseProfile);
    expect(form.selectionMode).toBe('class');
    expect(form.classUuid).toBe(BOOK_UUID);
    expect(formToProfile(form).query).toEqual(baseProfile.query);
  });

  it('detects the collection preset', () => {
    const profile = {
      ...baseProfile,
      query: { ast: buildCollectionPresetQuery(COLLECTION_UUID) },
    };
    const form = profileToForm(profile);
    expect(form.selectionMode).toBe('collection');
    expect(form.collectionUuid).toBe(COLLECTION_UUID);
    expect(formToProfile(form).query).toEqual(profile.query);
  });

  it('falls back to raw AST editing for arbitrary queries', () => {
    const ast = buildClassPresetQuery(BOOK_UUID);
    ast.root_group.children.push({
      type: 'condition',
      condition_type: 'class',
      class_uuid: COLLECTION_UUID,
    } as never);
    const form = profileToForm({ ...baseProfile, query: { ast } });
    expect(form.selectionMode).toBe('ast');
    expect(JSON.parse(form.astJson)).toEqual(ast);
  });
});
