/**
 * DeckView — the presentation-mode slide renderer (§34.26 P3–P5).
 *
 * A read-only but LIVE projection of one page's subtree (modelling decision
 * 3: collapse/expansion inside a deck never mutates; links click through —
 * exit + navigate, the Capacities contract). The deck model comes from the
 * pure builder in deck.ts; every slide resolves its nodes from the client at
 * render time, so edits anywhere re-project mid-deck through the standard
 * notify path. Slide bodies reuse the embed read-only projection machinery
 * (InlineTokens + EmbedView + QueryBlockView + WhiteboardCanvas embedded) so
 * decks render exactly what PageView renders; the slide chrome (title /
 * section / intro, density sizing, trailing-image pull) is token-only CSS.
 *
 * The view hosts a full OutlinerContext (the §34.21 V12 read seam) because
 * the token renderers consume it; navigation callbacks exit before opening,
 * so nothing inside a slide writes or navigates in place.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { BlockTreeNode, ClientNode, WorkspaceClient } from "@/core/workspace-client.js";

import { PresentationOverlay } from "../components/ui/PresentationOverlay.js";
import { cssColorFor } from "../components/ui/colorPresets.js";
import { openNodeLinkMenu } from "../components/NodeLinkContextMenu.js";
import { resolveAliasOpen } from "../components/aliasProperty.js";
import { EmbedBoundary, EmbedView } from "../EmbedView.js";
import { Icon } from "../Icon.js";
import { InlineTokens } from "../InlineTokens.js";
import { QueryBlockView } from "../QueryBlockView.js";
import { WhiteboardCanvas } from "../WhiteboardCanvas.js";
import { AssetView } from "../AssetView.js";
import { displayNameFromClient } from "../dateDisplay.js";
import { nodeIcon } from "../iconFor.js";
import { OutlinerContext, useOutliner, useOutlinerValue } from "../outliner-context.js";
import { assetImageUrl } from "../views/assetThumbs.js";
import { coverAssetIdOf } from "../components/coverProperty.js";
import { tableClassIdOf } from "../components/tableFamily.js";
import { BlockRow } from "../BlockRow.js";
import { buildDeck, type DeckSlide, type DeckSlideLayout, type DeckTreeEntry } from "./deck.js";
import { rememberResumeIndex, resumeIndexOf } from "./presentationSession.js";
import "./deck.css";

type DeckClient = WorkspaceClient | WorkerClient;

/**
 * The deck's top-level input: ALL of a node's children in true child order
 * (Revision 11 splits the same child list into two render zones — getBlockTree
 * reads the inline body, getChildPages the main-children zone; neither is the
 * whole list). Membership in one of the two zone reads also excludes
 * property-value carrier blocks, exactly as the block tree does. Class
 * children never appear (classes are always roots by the placement rule).
 */
function deckChildren(client: DeckClient, nodeId: string): DeckTreeEntry[] {
  const bodyIds = new Set(client.getBlockTree(nodeId, 1).map((entry) => entry.node.id));
  const mainIds = new Set(client.getChildPages(nodeId).map((node) => node.id));
  return client
    .getChildren(nodeId)
    .filter((node) => !node.isClass && (bodyIds.has(node.id) || mainIds.has(node.id)))
    .map((node) => ({ node, children: client.getBlockTree(node.id) }));
}

/** One image asset rendered on a slide (data URL resolved live, session-cached). */
function DeckImage({ client, assetId }: { client: DeckClient; assetId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void assetImageUrl(client, assetId).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [client, assetId]);
  if (url === null) return <span className="nt-placeholder">asset</span>;
  return <img className="nt-deck-image" src={url} alt="" />;
}

/** One read-only body block, recursive over children (the embed projection). */
function DeckBlock({ tree }: { tree: BlockTreeNode }) {
  const { client, rootId, openNode } = useOutliner();
  const node = tree.node;
  // §34.34 B4: a table-classed block routes through the BlockRow grid even
  // in the deck (the directive's "same BlockRow path") — the flat deck
  // projection would otherwise flatten rows/cells into a plain list. The
  // seam narrows to the full client for BlockRow's prop surface (the
  // EmbedView precedent).
  if (node.classIds.includes(tableClassIdOf(client))) {
    return <BlockRow tree={tree} client={client as DeckClient} readOnly />;
  }
  return (
    <div className="nt-deck-block">
      <div className="nt-deck-block-content">
        <InlineTokens
          tokens={node.contentAst}
          resolveName={(id) => displayNameFromClient(client, id)}
          resolveVerb={(schemaId) =>
            client.listPropertySchemas().find((schema) => schema.id === schemaId)?.name ?? null
          }
          // Issue #7 — a mention whose target is an alias page opens the
          // MAIN page (the alias view stays reachable outside the deck).
          onOpenNode={(id) => openNode(resolveAliasOpen(client, id))}
          resolveColor={(id) => {
            const target = client.getNode(id);
            return target === undefined ? null : client.effectiveNodeColor(target);
          }}
          renderEmbed={(id, _token, index) => (
            <EmbedView nodeId={id} hostId={node.id} tokenIndex={index} />
          )}
          renderQuery={(token, index) => (
            <QueryBlockView
              client={client}
              ownerId={node.id}
              tokenIndex={index}
              queryAst={(token as { queryAst?: unknown }).queryAst}
              view={(token as { view?: unknown }).view}
              rootId={rootId}
              onOpenNode={openNode}
            />
          )}
          renderWhiteboard={(_token, index) => (
            <WhiteboardCanvas client={client} hostId={node.id} tokenIndex={index} embedded />
          )}
          renderAsset={(token, _index, fullBleed) => {
            const assetId = (token as { assetId?: unknown }).assetId;
            // The outliner context narrows the client type; the underlying
            // object is the full deck client (the BlockRow precedent).
            return typeof assetId === "string" ? (
              <AssetView client={client as DeckClient} assetId={assetId} fullBleed={fullBleed} />
            ) : null;
          }}
          onMentionMenu={(info) => openNodeLinkMenu({ blockId: node.id, ...info })}
        />
      </div>
      {tree.children.length > 0 && (
        <div className="nt-deck-block-children">
          {tree.children.map((child) => (
            <DeckBlock key={child.node.id} tree={child} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Render a body block list (or a single trailing image) per the layout. */
function DeckBody({
  client,
  slide,
  blocks,
}: {
  client: DeckClient;
  slide: Extract<DeckSlide, { kind: "intro" | "section" }>;
  blocks: BlockTreeNode[];
}) {
  const layout = slide.layout;
  if (layout.type === "image-full") {
    return (
      <div className="nt-deck-image-solo">
        <DeckImage client={client} assetId={layout.imageAssetId} />
      </div>
    );
  }
  // split: the trailing block IS the image (dropped from the text column);
  // cover-split: the node's cover rides the right column, ALL blocks text.
  const textBlocks = layout.type === "split" ? blocks.slice(0, -1) : blocks;
  const body = (
    <div className={`nt-deck-body nt-deck-body--${slide.density}`}>
      {textBlocks.map((tree) => (
        <DeckBlock key={tree.node.id} tree={tree} />
      ))}
    </div>
  );
  if (layout.type === "split" || layout.type === "cover-split") {
    return (
      <div className="nt-deck-columns">
        {body}
        <div className="nt-deck-image-column">
          <DeckImage client={client} assetId={layout.imageAssetId} />
        </div>
      </div>
    );
  }
  return body;
}

function DeckSlideView({
  client,
  pageId,
  slide,
}: {
  client: DeckClient;
  /** The deck root — the embed cycle guard seeds with it, as PageView does. */
  pageId: string;
  slide: DeckSlide;
}) {
  if (slide.kind === "title") {
    const node = client.getNode(slide.nodeId);
    const icon = node !== undefined ? nodeIcon(node, client.classIcons()) : null;
    const color = node !== undefined ? client.effectiveNodeColor(node) : null;
    // §34.75: the presented page's cover opens the deck (a hero above the
    // title) — covers are presentation imagery like any slide image.
    const coverAssetId = coverAssetIdOf(client, slide.nodeId);
    return (
      <div className="nt-deck-slide nt-deck-slide--title">
        {coverAssetId !== null && (
          <div className="nt-deck-cover">
            <DeckImage client={client} assetId={coverAssetId} />
          </div>
        )}
        {icon !== null && (
          <span
            className="nt-deck-title-icon"
            style={color !== null ? { color: cssColorFor(color) } : undefined}
          >
            <Icon path={icon} size={2.4} />
          </span>
        )}
        <h1 className="nt-deck-title">
          {displayNameFromClient(client, slide.nodeId) ?? "Untitled"}
        </h1>
      </div>
    );
  }

  let titleNode: ClientNode | undefined;
  let blocks: BlockTreeNode[];
  if (slide.kind === "section") {
    titleNode = client.getNode(slide.nodeId);
    blocks = client.getBlockTree(slide.nodeId);
  } else {
    blocks = slide.blockIds
      .map((id) => client.getNode(id))
      .filter((node): node is ClientNode => node !== undefined)
      .map((node) => ({ node, children: client.getBlockTree(node.id) }));
  }
  const titleIcon =
    titleNode !== undefined ? nodeIcon(titleNode, client.effectiveClassIcons()) : null;
  const titleColor =
    titleNode !== undefined ? client.effectiveNodeColor(titleNode) : null;

  // §34.75: a section whose body carries no image of its own but has a
  // cover property gets the cover in the right column (cover-split keeps
  // ALL body blocks in the text column — unlike split, nothing is dropped).
  const coverAssetId = titleNode !== undefined ? coverAssetIdOf(client, titleNode.id) : null;
  const layout: DeckSlideLayout =
    slide.layout.type === "standard" && coverAssetId !== null
      ? { type: "cover-split", imageAssetId: coverAssetId }
      : slide.layout;

  return (
    <div className={`nt-deck-slide nt-deck-slide--${slide.kind}`}>
      {titleNode !== undefined && (
        <div className="nt-deck-slide-title">
          {titleIcon !== null && (
            <span
              className="nt-deck-slide-title-icon"
              style={titleColor !== null ? { color: cssColorFor(titleColor) } : undefined}
            >
              <Icon path={titleIcon} size={1.2} />
            </span>
          )}
          <h2>{displayNameFromClient(client, titleNode.id) ?? "Untitled"}</h2>
        </div>
      )}
      <EmbedBoundary rootId={pageId}>
        <DeckBody client={client} slide={{ ...slide, layout }} blocks={blocks} />
      </EmbedBoundary>
    </div>
  );
}

export function DeckView({
  client,
  pageId,
  onOpenNode,
  onClose,
}: {
  client: DeckClient;
  pageId: string;
  /** Link click-through: navigate the app (the deck exits first). */
  onOpenNode: (nodeId: string) => void;
  onClose: () => void;
}) {
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const [index, setIndex] = useState(() => resumeIndexOf(pageId));

  /** Link click-through is the Capacities contract: exit, then navigate. */
  const exitAndOpen = useCallback(
    (nodeId: string) => {
      onClose();
      onOpenNode(nodeId);
    },
    [onClose, onOpenNode],
  );

  const outliner = useOutlinerValue(client, pageId, {
    openNode: exitAndOpen,
    openInSidebar: () => {},
  });

  const node = client.getNode(pageId);
  const deck: DeckSlide[] = (() => {
    if (node === undefined) return [];
    const root: DeckTreeEntry = { node, children: deckChildren(client, pageId) };
    return buildDeck(root, (id) => {
      const target = client.getNode(id);
      return target === undefined ? undefined : { node: target, children: deckChildren(client, id) };
    });
  })();
  const safeIndex = deck.length === 0 ? 0 : Math.min(index, deck.length - 1);

  // P7 (D3): session-local resume — remember on move, on exit, on unmount.
  const indexRef = useRef(safeIndex);
  indexRef.current = safeIndex;
  useEffect(() => {
    rememberResumeIndex(pageId, safeIndex);
  }, [pageId, safeIndex]);
  useEffect(() => {
    const finalPage = pageId;
    // Read the ref at cleanup time — capturing its value here would freeze
    // the mount-time index (0) and clobber the remembered slide on exit.
    return () => rememberResumeIndex(finalPage, indexRef.current);
  }, [pageId]);

  // The page was deleted mid-deck: exit (the host navigates to its fallback).
  useEffect(() => {
    if (client.getNode(pageId) === undefined) onClose();
  }, [client, pageId, onClose, version]);

  const slide = deck[safeIndex];

  return (
    <OutlinerContext.Provider value={outliner}>
      <PresentationOverlay
        isOpen
        index={safeIndex}
        count={deck.length}
        onIndexChange={setIndex}
        onClose={onClose}
        ariaLabel={`Presenting ${displayNameFromClient(client, pageId) ?? "page"}`}
      >
        {slide !== undefined ? (
          <DeckSlideView client={client} pageId={pageId} slide={slide} />
        ) : (
          <div className="nt-deck-slide nt-deck-slide--title">
            <h1 className="nt-deck-title">Page not found.</h1>
          </div>
        )}
      </PresentationOverlay>
    </OutlinerContext.Provider>
  );
}
