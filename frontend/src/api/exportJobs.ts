/**
 * Export job API helpers
 *
 * The export endpoints are asynchronous: they return a job id that must be
 * polled until completion, after which the result is downloaded from a
 * separate endpoint.
 */
import api from './client';

export interface ExportJobResponse {
  id: string;
  status: string;
  progress: number;
  status_text: string;
  download_url: string | null;
  error: string | null;
}

export interface StartExportJobOptions {
  nodeUuids: string[];
  params: Record<string, unknown>;
}

export async function startExportJob(options: StartExportJobOptions): Promise<string> {
  const { data } = await api.post('/export', {
    node_ids: options.nodeUuids,
    ...options.params,
  });
  return (data as { job_id: string }).job_id;
}

export async function startSingleExportJob(
  nodeUuid: string,
  params: Record<string, unknown>
): Promise<string> {
  const { data } = await api.get(`/export/${nodeUuid}`, { params });
  return (data as { job_id: string }).job_id;
}

export async function getExportJob(jobId: string): Promise<ExportJobResponse> {
  const { data } = await api.get(`/export/jobs/${jobId}`);
  return data as ExportJobResponse;
}

/**
 * Poll an export job until it completes or fails.
 *
 * @param jobId - The job id returned by the start endpoint.
 * @param options - Polling configuration.
 * @returns The completed job response.
 */
export async function pollExportJob(
  jobId: string,
  options: { intervalMs?: number; timeoutMs?: number; onStatus?: (job: ExportJobResponse) => void } = {}
): Promise<ExportJobResponse> {
  const { intervalMs = 500, timeoutMs = 60000, onStatus } = options;
  const startedAt = Date.now();

  while (true) {
    const job = await getExportJob(jobId);
    onStatus?.(job);

    if (job.status === 'completed') {
      return job;
    }
    if (job.status === 'failed') {
      throw new Error(job.error ?? 'Export failed');
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Export timed out');
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function fetchExportResult<T = Blob>(
  jobId: string,
  responseType: 'blob' | 'text'
): Promise<{ data: T; headers: Record<string, string> }> {
  return api.get(`/export/jobs/${jobId}/download`, { responseType }) as Promise<{
    data: T;
    headers: Record<string, string>;
  }>;
}
