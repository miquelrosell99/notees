/**
 * AliasOfBanner — the node-alias banner: rendered at the top of an ALIAS
 * page's view (the alias opened as a node — the aliases UI's NAVIGATE,
 * deep links). The alias view itself stays put (the alias's own body and
 * only its own linked references); the banner names the MAIN page (the
 * direct `aliasedNodeId` target) and jumps to it on click. Mentions/links
 * targeting the alias resolve to the main view separately (the
 * resolveAliasOpen seam) — this chip is the explicit alias→main surface,
 * not a redirect. Null when the page carries no `aliasedNodeId` (every
 * ordinary page).
 */

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameFromClient } from "../dateDisplay.js";
import { Icon } from "../Icon.js";
import { Pill } from "./ui/Pill.js";
import "./AliasOfBanner.css";

type AnyClient = WorkspaceClient | WorkerClient;

export function AliasOfBanner({
  client,
  aliasPageId,
  onOpenPage,
}: {
  client: AnyClient;
  aliasPageId: string;
  onOpenPage?: ((pageId: string) => void) | undefined;
}) {
  const mainId = client.getNode(aliasPageId)?.aliasedNodeId ?? null;
  if (mainId === null) return null;
  const label = displayNameFromClient(client, mainId) ?? mainId;
  return (
    <button
      type="button"
      className="nt-alias-banner"
      title={`Open the main page: ${label}`}
      onClick={() => onOpenPage?.(mainId)}
    >
      <Pill
        variant="link-page"
        leftIcon={<Icon path="mdi-link-variant" size={0.7} />}
        text={`Alias of ${label}`}
      />
    </button>
  );
}
