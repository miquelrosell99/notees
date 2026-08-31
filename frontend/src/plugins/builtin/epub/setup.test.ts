/**
 * EPUB plugin frontend setup tests: node-action registration and the
 * MIME-gated visibility predicate (a non-EPUB attachment shows no actions).
 */
import { describe, expect, it } from 'vitest';

import {
  createPluginContext,
  getNodeAction,
  type NodeActionContext,
  type PluginManifest,
} from '@/plugins/core';
import { isEpubAsset, setup } from './setup';

const manifest: PluginManifest = {
  id: 'notees.epub',
  name: 'EPUB Metadata',
  version: '1.0.0',
};

function actionContext(assetMimeType: string | null | undefined): NodeActionContext {
  return { menu: 'link', nodeUuid: 'asset-1', node: null, assetMimeType, close: () => {} };
}

describe('epub plugin setup', () => {
  it('registers extract/inject node actions and tears them down', () => {
    const context = createPluginContext(manifest);
    setup(context);

    expect(getNodeAction('epub.extractMetadata')).toBeDefined();
    expect(getNodeAction('epub.injectMetadata')).toBeDefined();

    context.unregisterAll();
    expect(getNodeAction('epub.extractMetadata')).toBeUndefined();
    expect(getNodeAction('epub.injectMetadata')).toBeUndefined();
  });

  it('shows actions only for EPUB assets', () => {
    expect(isEpubAsset(actionContext('application/epub+zip'))).toBe(true);
    expect(isEpubAsset(actionContext('application/pdf'))).toBe(false);
    expect(isEpubAsset(actionContext(null))).toBe(false);
    expect(isEpubAsset(actionContext(undefined))).toBe(false);
  });

  it('registered actions use the visibility predicate on link and node menus', () => {
    const context = createPluginContext(manifest);
    setup(context);
    try {
      for (const id of ['epub.extractMetadata', 'epub.injectMetadata']) {
        const action = getNodeAction(id);
        expect(action?.menus).toEqual(['link', 'node']);
        expect(action?.visible?.(actionContext('application/epub+zip'))).toBe(true);
        expect(action?.visible?.(actionContext('image/png'))).toBe(false);
      }
    } finally {
      context.unregisterAll();
    }
  });
});
