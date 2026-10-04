/**
 * FavoriteStar — the page-header star toggle (§34.61). Renders in the page
 * title row's toolbar (PageView's default header actions); the same toggle
 * also lives on every node context menu and on the sidebar rows. One shared
 * nodePrefs store backs all of them: the star state is the server-side
 * per-user prefs copy when online, the device-local cache offline — so a
 * page starred here lands in the sidebar Favorites section on every device.
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import { toggleNodeFavorite, useNodePrefs } from "./nodePrefs.js";

export function FavoriteStar({
  client,
  nodeId,
}: {
  client: WorkspaceClient | WorkerClient;
  nodeId: string;
}) {
  const { favorites } = useNodePrefs(client);
  const starred = favorites.includes(nodeId);
  return (
    <button
      type="button"
      className={starred ? "nt-icon-btn nt-icon-btn-active" : "nt-icon-btn"}
      title={starred ? "Remove from favorites" : "Add to favorites"}
      aria-label={starred ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={starred}
      onClick={() => toggleNodeFavorite(client, nodeId)}
    >
      <Icon path={starred ? "mdi-star" : "mdi-star-outline"} size={0.9} />
    </button>
  );
}
