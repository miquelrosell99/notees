export interface PageInfo {
  id: number;
  uuid: string;
}

export interface FolderImportState {
  importing: boolean;
  progress: number;
  statusText: string;
  error: string | null;
  done: boolean;
}
