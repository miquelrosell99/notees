/**
 * Import API for Markdown files into the current workspace.
 */
import api from '@/api/client';

export interface MarkdownImportItem {
  content: string;
  parent_uuid?: string | null;
  sequence?: number;
}

export interface MarkdownImportResult {
  node_uuid: string;
  title: string;
  created: boolean;
  existing: boolean;
}

export interface MarkdownImportRequest {
  items: MarkdownImportItem[];
  uuid_conflict_mode?: 'block' | 'return_existing';
}

export async function importMarkdown(
  request: MarkdownImportRequest
): Promise<MarkdownImportResult[]> {
  const { data } = await api.post<MarkdownImportResult[]>('/import/markdown', request);
  return data;
}
