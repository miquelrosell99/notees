export interface PageInfo {
  nodeUuid: string;
  uuid: string;
}

export interface FolderImportState {
  importing: boolean;
  progress: number;
  statusText: string;
  error: string | null;
  done: boolean;
}
