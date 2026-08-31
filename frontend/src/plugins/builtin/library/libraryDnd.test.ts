/**
 * Unit tests for Library drag-and-drop logic (Task 12): drag payload
 * resolution, attachment property merging, link detection, and the
 * collection-membership drop plan.
 */
import { describe, it, expect } from 'vitest';

import {
  NOTEES_NODE_MIME,
  contentLinksTo,
  isFileDrag,
  isNodeDrag,
  mergeAttachmentValue,
  parseNodeDragPayload,
  resolveCollectionDrop,
  serializeNodeDragPayload,
} from './libraryDnd';

describe('node drag payload', () => {
  it('round-trips a serialized payload', () => {
    const raw = serializeNodeDragPayload({ nodeUuid: 'node-1', name: 'My Book' });
    expect(parseNodeDragPayload(raw)).toEqual({ nodeUuid: 'node-1', name: 'My Book' });
  });

  it('parses payloads without a name', () => {
    expect(parseNodeDragPayload('{"nodeUuid":"node-1"}')).toEqual({
      nodeUuid: 'node-1',
      name: undefined,
    });
  });

  it('rejects missing, malformed, or empty payloads', () => {
    expect(parseNodeDragPayload(null)).toBeNull();
    expect(parseNodeDragPayload(undefined)).toBeNull();
    expect(parseNodeDragPayload('')).toBeNull();
    expect(parseNodeDragPayload('not json')).toBeNull();
    expect(parseNodeDragPayload('{"name":"x"}')).toBeNull();
    expect(parseNodeDragPayload('{"nodeUuid":""}')).toBeNull();
    expect(parseNodeDragPayload('{"nodeUuid":42}')).toBeNull();
  });
});

describe('drag type detection', () => {
  it('detects OS file drags', () => {
    expect(isFileDrag(['Files', 'text/plain'])).toBe(true);
    expect(isFileDrag([NOTEES_NODE_MIME])).toBe(false);
    expect(isFileDrag([])).toBe(false);
  });

  it('detects Notees node drags', () => {
    expect(isNodeDrag([NOTEES_NODE_MIME])).toBe(true);
    expect(isNodeDrag(['Files'])).toBe(false);
  });
});

describe('mergeAttachmentValue', () => {
  it('starts a new attachments array when none exists', () => {
    expect(mergeAttachmentValue(undefined, 'asset-1')).toEqual(['asset-1']);
    expect(mergeAttachmentValue(null, 'asset-1')).toEqual(['asset-1']);
  });

  it('appends to an existing array', () => {
    expect(mergeAttachmentValue(['asset-1'], 'asset-2')).toEqual(['asset-1', 'asset-2']);
  });

  it('upgrades a legacy single-string value', () => {
    expect(mergeAttachmentValue('asset-1', 'asset-2')).toEqual(['asset-1', 'asset-2']);
  });

  it('filters non-string garbage from existing values', () => {
    expect(mergeAttachmentValue(['asset-1', 42, null], 'asset-2')).toEqual(['asset-1', 'asset-2']);
  });

  it('returns null when the asset is already attached (no-op)', () => {
    expect(mergeAttachmentValue(['asset-1', 'asset-2'], 'asset-1')).toBeNull();
    expect(mergeAttachmentValue('asset-1', 'asset-1')).toBeNull();
  });
});

describe('contentLinksTo', () => {
  const withNodeLink = JSON.stringify([
    { type: 'paragraph', children: [{ type: 'text', text: 'My Book ' }] },
    {
      type: 'paragraph',
      children: [{ type: 'node_link', link_id: 'col-1:link-9', ref_type: 'node' }],
    },
  ]);

  it('detects a node_link targeting the collection', () => {
    expect(contentLinksTo(withNodeLink, 'col-1')).toBe(true);
  });

  it('detects bare-target and raw [[uuid]] links', () => {
    expect(
      contentLinksTo(
        JSON.stringify([
          { type: 'paragraph', children: [{ type: 'node_link', link_id: 'col-1', ref_type: 'node' }] },
        ]),
        'col-1',
      ),
    ).toBe(true);
    expect(
      contentLinksTo(
        JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', text: 'see [[col-1]]' }] }]),
        'col-1',
      ),
    ).toBe(true);
  });

  it('returns false for other targets and empty content', () => {
    expect(contentLinksTo(withNodeLink, 'col-2')).toBe(false);
    expect(contentLinksTo('', 'col-1')).toBe(false);
    expect(contentLinksTo(null, 'col-1')).toBe(false);
    expect(contentLinksTo('not json', 'col-1')).toBe(false);
  });
});

describe('resolveCollectionDrop', () => {
  const base = {
    sourceUuid: 'src',
    collectionUuid: 'col',
    sourceAncestors: [] as string[],
    collectionAncestors: [] as string[],
    sourceAlreadyLinks: false,
  };

  it('nests a source that is not yet a member', () => {
    expect(resolveCollectionDrop(base)).toEqual({ action: 'nest' });
  });

  it('nests a source that already has a home elsewhere (re-parent)', () => {
    expect(resolveCollectionDrop({ ...base, sourceAncestors: ['other-col'] })).toEqual({
      action: 'nest',
    });
  });

  it('no-ops when source and collection are the same node', () => {
    expect(resolveCollectionDrop({ ...base, collectionUuid: 'src' })).toEqual({
      action: 'noop',
      reason: 'self',
    });
  });

  it('no-ops when the source is already nested under the collection', () => {
    expect(
      resolveCollectionDrop({ ...base, sourceAncestors: ['parent', 'col', 'root'] }),
    ).toEqual({ action: 'noop', reason: 'already-member' });
  });

  it('no-ops when the source already links to the collection', () => {
    expect(resolveCollectionDrop({ ...base, sourceAlreadyLinks: true })).toEqual({
      action: 'noop',
      reason: 'already-linked',
    });
  });

  it('no-ops when nesting would create a cycle', () => {
    expect(
      resolveCollectionDrop({ ...base, collectionAncestors: ['mid', 'src', 'root'] }),
    ).toEqual({ action: 'noop', reason: 'cycle' });
  });

  it('reports already-member before cycle when both hold', () => {
    expect(
      resolveCollectionDrop({
        ...base,
        sourceAncestors: ['col'],
        collectionAncestors: ['src'],
      }),
    ).toEqual({ action: 'noop', reason: 'already-member' });
  });
});
