export type BridgeResult = { objectId: string; title: string; citekey?: string;
  authors?: string[]; year?: number; classKey?: string };

export type BridgeError = { code: string; message: string; status?: number };
export type BridgeResponse<T> = { ok: true } & T | { ok: false; error: BridgeError };

export interface Bridge {
  search(query: string): Promise<BridgeResponse<{ results: BridgeResult[] }>>;
  renderCitation(objectIds: string[], styleId: string, locator?: string):
    Promise<BridgeResponse<{ citation: string }>>;
  renderBibliography(objectIds: string[], styleId: string):
    Promise<BridgeResponse<{ bibliography: string }>>;
  listStyles(): Promise<BridgeResponse<{ styles: { id: string; label: string }[] }>>;
}
