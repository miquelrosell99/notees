/**
 * Server upload path regression test: uploadAsset must actually attach the
 * file and metadata to the FormData (a past refactor posted an empty body).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/api/client', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
  },
}));

import api from '@/api/client';
import { uploadAsset } from '../assets';

describe('uploadAsset (server path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Force non-local mode: no server URL setting at all = same-origin default.
    localStorage.removeItem('notees.serverUrl');
  });

  it('posts the file and metadata in the FormData body', async () => {
    const file = new File(['image-bytes'], 'photo.png', { type: 'image/png' });
    vi.mocked(api.post).mockResolvedValue({
      data: { uuid: 'asset-1', url: '/api/assets/asset-1' },
      headers: {},
    });

    await uploadAsset(file, 'parent-1', 'node-1', 'Caption');

    const [, formData] = vi.mocked(api.post).mock.calls[0] as [string, FormData];
    expect(formData.get('file')).toBe(file);
    expect(formData.get('parent_uuid')).toBe('parent-1');
    expect(formData.get('existing_node_uuid')).toBe('node-1');
    expect(formData.get('content')).toBe('Caption');
  });

  it('omits optional fields when not provided', async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    vi.mocked(api.post).mockResolvedValue({ data: { uuid: 'asset-2' }, headers: {} });

    await uploadAsset(file);

    const [, formData] = vi.mocked(api.post).mock.calls[0] as [string, FormData];
    expect(formData.get('file')).toBe(file);
    expect(formData.get('parent_uuid')).toBeNull();
    expect(formData.get('existing_node_uuid')).toBeNull();
  });
});
