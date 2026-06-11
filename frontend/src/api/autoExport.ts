/**
 * Auto-export API functions
 */
import api from '@/api/client';

export interface AutoExportStatus {
  running: boolean;
  total: number;
  completed: number;
  current_page: string | null;
  error: string | null;
}

export async function autoExportPage(nodeUuid: string): Promise<{ status: string; filename: string }> {
  const response = await api.post(`/auto-export/${nodeUuid}`);
  return response.data;
}

export async function autoExportBatch(): Promise<{ status: string }> {
  const response = await api.post('/auto-export/batch', {});
  return response.data;
}

export async function getAutoExportStatus(): Promise<AutoExportStatus> {
  const response = await api.get('/auto-export/status');
  return response.data;
}

/**
 * Download all exported markdown files as a ZIP archive.
 * Returns a Blob and the suggested filename from the Content-Disposition header.
 */
export async function downloadAutoExportZip(): Promise<{ blob: Blob; filename: string }> {
  const response = await api.get('/auto-export/download', {
    responseType: 'blob',
  });
  const disposition = response.headers['content-disposition'] ?? undefined;
  let filename = 'export.zip';
  if (disposition) {
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match) {
      filename = match[1];
    }
  }
  const blob = new Blob([response.data], { type: 'application/zip' });
  return { blob, filename };
}
