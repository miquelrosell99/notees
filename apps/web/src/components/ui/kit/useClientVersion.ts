/**
 * useClientVersion — the live-by-subscription idiom as a hook.
 *
 * Returns a version that bumps on every client notification; a `useMemo`
 * keyed on it re-derives per notify (the facets/table/metadata idiom) so no
 * surface hand-rolls the subscribe-and-bump effect. An absent client
 * (optional-prop surfaces) yields a constant 0 — the hook never subscribes.
 */

import { useEffect, useState } from "react";

/** The minimal notification surface every workspace/worker client carries. */
export interface VersionedClient {
  subscribe(listener: () => void): () => void;
}

export function useClientVersion(client: VersionedClient | null | undefined): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (client === null || client === undefined) return;
    return client.subscribe(() => setVersion((v) => v + 1));
  }, [client]);
  return version;
}
