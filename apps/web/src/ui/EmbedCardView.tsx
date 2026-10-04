/**
 * EmbedCardView — the intermediate embed reference views (§34.34 B8): a
 * bounded card for an `embed_ref` token carrying `view: "small_card" |
 * "wide_card"`, sitting between the inline `mention` (id-only, resolves at
 * render) and the full `embed_ref` transclusion (EmbedView — the live
 * subtree). Cards NEVER transclude: they show the target's identity (icon +
 * display name; the wide card adds the content excerpt) and navigate via
 * the outliner's openNode on click. A target that no longer exists renders
 * the broken-mention fallback honestly (raw id, dashed).
 */

import { useEffect, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { displayNameFromClient } from "./dateDisplay.js";
import { Icon } from "./Icon.js";
import { classIconMap, nodeIcon } from "./iconFor.js";
import { useOutliner } from "./outliner-context.js";

type AnyClient = WorkspaceClient | WorkerClient;

export function EmbedCardView({ nodeId, view }: { nodeId: string; view: "small_card" | "wide_card" }) {
  const { client: seamClient, openNode } = useOutliner();
  const client = seamClient as AnyClient;
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const node = client.getNode(nodeId);
  if (node === undefined) {
    return (
      <span className="nt-embed-card nt-embed-card--broken" title={nodeId}>
        broken reference <code>{nodeId}</code>
      </span>
    );
  }

  const icon = nodeIcon(node, classIconMap(client.listClasses()));
  const label = displayNameFromClient(client, nodeId) ?? nodeId;
  const excerpt = view === "wide_card" ? plainExcerpt(node.contentAst) : "";

  return (
    <button
      type="button"
      className={`nt-embed-card nt-embed-card--${view}`}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        openNode(nodeId);
      }}
    >
      {icon !== null && <Icon path={icon} size={1} className="nt-embed-card__icon" />}
      <span className="nt-embed-card__label">{label}</span>
      {excerpt !== "" && <span className="nt-embed-card__excerpt">{excerpt}</span>}
    </button>
  );
}

/** One-line plaintext excerpt of a content stream (the wide card's teaser). */
function plainExcerpt(contentAst: readonly unknown[]): string {
  const parts: string[] = [];
  const walk = (tokens: readonly unknown[]): void => {
    for (const token of tokens) {
      if (typeof token !== "object" || token === null) continue;
      const t = token as { type?: unknown; text?: unknown; children?: unknown; expression?: unknown };
      if (t.type === "text" && typeof t.text === "string") parts.push(t.text);
      else if (t.type === "math" && typeof t.expression === "string") parts.push(t.expression);
      else if (t.type === "quote" && Array.isArray(t.children)) walk(t.children);
    }
  };
  walk(contentAst);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
