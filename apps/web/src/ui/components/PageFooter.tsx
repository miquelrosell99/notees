/**
 * PageFooter — the card-bottom chrome: a word
 * count over the page's content and Created/Updated stamps that open the
 * corresponding day pages. Pure chrome — the counts derive from the derived
 * store on render, and the day links go through the ordinary ensure-chain
 * read (idempotent, no-op when the chain exists).
 */

import { useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { proseFromAst } from "@/editor/prose.js";

import { displayNameForSettings, formatIsoDate } from "../dateDisplay.js";
import { todayIsoLocal } from "./calendarViewUtils.js";
import "./PageFooter.css";

type AnyClient = WorkspaceClient | WorkerClient;

/** Local-midnight ISO date (YYYY-MM-DD) for a timestamp — never UTC. */
function localIsoDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/** Word count over the title + the whole block tree (prose projections). */
export function wordCountOf(page: ClientNode, tree: BlockTreeNode[]): number {
  const parts: string[] = [displayNameForSettings(page)];
  const walk = (nodes: BlockTreeNode[]) => {
    for (const entry of nodes) {
      parts.push(proseFromAst(entry.node.contentAst));
      walk(entry.children);
    }
  };
  walk(tree);
  let count = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed !== "") count += trimmed.split(/\s+/).length;
  }
  return count;
}

/** One Created/Updated stamp → its day page. */
function DayLink({
  client,
  label,
  iso,
  onOpenNode,
}: {
  client: AnyClient;
  label: string;
  iso: string | null;
  onOpenNode: (nodeId: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const dayIso = iso === null ? null : localIsoDate(iso);
  if (dayIso === null) {
    return <span className="nt-page-footer__date nt-page-footer__date--empty">{label} —</span>;
  }
  // Owner 2026-10-06: the Created stamp reads "Created today" when the page
  // was created today (the Updated stamp keeps the plain date).
  const text = label === "Created" && dayIso === todayIsoLocal() ? "today" : (formatIsoDate(iso) ?? "—");
  return (
    <button
      type="button"
      className="nt-page-footer__date"
      title={`Open the ${dayIso} day page`}
      disabled={pending}
      onClick={() => {
        setPending(true);
        void client
          .ensureDateChain(dayIso)
          .then(({ day }) => onOpenNode(day))
          .finally(() => setPending(false));
      }}
    >
      {label} {text}
    </button>
  );
}

export function PageFooter({
  client,
  page,
  tree,
  onOpenNode,
}: {
  client: AnyClient;
  page: ClientNode;
  tree: BlockTreeNode[];
  onOpenNode: ((nodeId: string) => void) | undefined;
}) {
  const words = wordCountOf(page, tree);
  return (
    <footer className="nt-page-footer">
      <span className="nt-page-footer__words">
        {words} {words === 1 ? "word" : "words"}
      </span>
      {onOpenNode !== undefined && (
        <span className="nt-page-footer__dates">
          <DayLink client={client} label="Created" iso={page.createdAt} onOpenNode={onOpenNode} />
          <DayLink client={client} label="Updated" iso={page.updatedAt} onOpenNode={onOpenNode} />
        </span>
      )}
    </footer>
  );
}
