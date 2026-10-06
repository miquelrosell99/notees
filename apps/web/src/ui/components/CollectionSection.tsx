/**
 * CollectionSection — the ONE section skin (owner pass 7, M7): the
 * collapsible chrome (NodeViewSection, the chrome primitive — the header is
 * a single <button>, so the header ROW cannot host nested controls; an
 * optional ViewToolbar rides the body top instead) around a views/
 * NodeCollection, fed by useSectionData. The lazy contract — first
 * activation, cache across switches, re-run per notification, failure keeps
 * the previous rows — lives entirely in the hook; this component is chrome
 * + the collection host. Nothing rides the skin yet in S2 — the current
 * sections convert slice by slice (their exported signatures stay frozen
 * until S3+); the skin lands now as the single render target for the
 * SectionSpec stacks (S5+).
 */

import { useState, type ReactNode } from "react";

import type { AnyClient, NodeCollectionItem, NodeCollectionProps, ViewMode } from "../views/index.js";
import { NodeCollection } from "../views/index.js";

import { NodeViewSection } from "./NodeViewSection.js";
import { useSectionData, type SectionCtx } from "./useSectionData.js";
import "./CollectionSection.css";

export interface CollectionSectionProps {
  client: AnyClient;
  title: string;
  icon?: ReactNode | undefined;
  /**
   * Eager count badge (a materialized read, exempt from the lazy contract).
   * Omit to show the resolved row count instead (undefined until the first
   * resolution). Pass 0 together with `hideWhenEmpty` for the classic
   * hide-when-empty gate.
   */
  count?: number | undefined;
  /** Collapsed on first render unless overridden. */
  defaultCollapsed?: boolean;
  /** Text when the resolution came back empty. */
  emptyText: string;
  /** The view the collection renders in. */
  viewMode: ViewMode;
  /** Exactly one resolution strategy (see useSectionData). */
  read?: ((ctx: SectionCtx) => NodeCollectionItem[]) | undefined;
  query?: ((ctx: SectionCtx) => Promise<NodeCollectionItem[]>) | undefined;
  /** Optional chrome (a ViewToolbar) riding the body top, above the collection. */
  toolbar?: ReactNode | undefined;
  /** Extra NodeCollection props (groups / renderItem / readOnly / onNodeClick / …). */
  collection?: Omit<NodeCollectionProps, "client" | "items" | "viewMode"> | undefined;
  /** Hide the whole section when the count gate reads 0 (the section never vanishes behind an unresolved count). */
  hideWhenEmpty?: boolean | undefined;
}

export function CollectionSection({
  client,
  title,
  icon,
  count,
  defaultCollapsed = true,
  emptyText,
  viewMode,
  read,
  query,
  toolbar,
  collection,
  hideWhenEmpty = false,
}: CollectionSectionProps) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const { rows } = useSectionData<NodeCollectionItem[]>({ client, active: expanded, read, query });
  const resolvedCount = count ?? (rows !== null ? rows.length : undefined);

  if (hideWhenEmpty && resolvedCount === 0) return null;

  return (
    <NodeViewSection
      title={title}
      icon={icon}
      count={resolvedCount}
      className="nt-collection-section"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {toolbar !== undefined && (
        <div className="nt-collection-section__toolbar">{toolbar}</div>
      )}
      {rows === null ? null : rows.length === 0 ? (
        <div className="nt-section-empty">{emptyText}</div>
      ) : (
        <NodeCollection
          viewMode={viewMode}
          client={client}
          items={rows}
          {...collection}
        />
      )}
    </NodeViewSection>
  );
}
