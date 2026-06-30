/**
 * Unit tests for BlockYjsStore.
 */

import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { blockYjsStore } from './BlockYjsStore';

describe('BlockYjsStore', () => {
  it('creates and returns the same doc for a block UUID', () => {
    const doc = blockYjsStore.getDoc('block-a');
    expect(doc).toBeInstanceOf(Y.Doc);
    expect(blockYjsStore.getDoc('block-a')).toBe(doc);
    expect(blockYjsStore.getDoc('block-b')).not.toBe(doc);
  });

  it('exposes a shared XmlElement named content', () => {
    const content = blockYjsStore.getContent('block-content');
    expect(content).toBeInstanceOf(Y.XmlElement);
    expect(blockYjsStore.getContent('block-content')).toBe(content);
  });

  it('applies a remote update and notifies subscribers', () => {
    const blockUuid = 'block-update';
    const handler = vi.fn();
    const unsubscribe = blockYjsStore.subscribe(blockUuid, handler);

    // Build an update on a separate document with the same shape.
    const sourceDoc = new Y.Doc();
    const sourceContent = sourceDoc.get('content', Y.XmlElement);
    const text = new Y.XmlText('hello');
    sourceContent.insert(0, [text]);
    const update = Y.encodeStateAsUpdate(sourceDoc);

    blockYjsStore.applyUpdate(blockUuid, update);

    expect(handler).toHaveBeenCalled();
    expect(blockYjsStore.getContent(blockUuid).toString()).toContain('hello');

    unsubscribe();
  });

  it('allows unsubscribing from updates', () => {
    const blockUuid = 'block-unsubscribe';
    const handler = vi.fn();
    const unsubscribe = blockYjsStore.subscribe(blockUuid, handler);
    unsubscribe();

    const update = Y.encodeStateAsUpdate(new Y.Doc());
    blockYjsStore.applyUpdate(blockUuid, update);

    expect(handler).not.toHaveBeenCalled();
  });
});
