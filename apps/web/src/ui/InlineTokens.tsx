/**
 * InlineTokens — renders a flat content token stream (SCHEMA.md content
 * grammar) into React elements. Renders only what slice 1 implements;
 * unknown tokens render nothing (never crash). Text marks map to
 * <strong>/<em>/<s>/<mark>/<code>; mentions and class chips render as chips
 * (names resolved through the optional resolveName callback, with graceful
 * fallbacks); quote recurses; embed_ref renders the live subtree via the
 * optional renderEmbed callback (placeholder box when absent); query renders
 * the live query block via the optional renderQuery callback (placeholder box
 * when absent); whiteboard renders the live canvas via the optional
 * renderWhiteboard callback (placeholder box when absent); asset_ref renders
 * via the optional renderAsset callback (SCHEMA.md:61 — full-bleed when alone
 * in the stream; placeholder box when absent); embed_ref card views (§34.34
 * B8) route through the optional renderEmbedCard callback (falling back to
 * renderEmbed); code_block renders read-only as a mono pre with the language
 * badge (§34.34 B3) and hr as a horizontal rule (§34.34 B5); typed_link marks
 * show the verb in the tooltip — PG1 bound verbs (`{ propertySchemaId }`)
 * resolve the schema's name through the optional resolveVerb callback; other
 * block-scale tokens render as labeled placeholder boxes.
 */

import { Fragment, type ReactNode } from "react";

import { cssColorFor } from "./components/ui/colorPresets.js";

export interface InlineTokensProps {
  tokens: readonly unknown[];
  resolveName?: ((nodeId: string) => string | null) | undefined;
  /**
   * Live embed renderer for `embed_ref` tokens (EmbedView). Injected by the
   * row so this module stays pure; when absent, embed_ref falls back to the
   * placeholder box. Receives the raw token + its stream index so the
   * renderer can write the token's `view` field (the embed view switcher).
   */
  renderEmbed?: ((nodeId: string, token: unknown, index: number) => ReactNode) | undefined;
  /**
   * Live query-block renderer for `query` tokens (QueryBlockView), injected
   * by the row; when absent (e.g. read-only embed projections), query falls
   * back to the placeholder box.
   */
  renderQuery?: ((token: unknown, index: number) => ReactNode) | undefined;
  /**
   * Live canvas renderer for `whiteboard` tokens (WhiteboardCanvas),
   * injected by the row (embedded mini-canvas) or the page view (fullscreen
   * canvas); when absent (e.g. read-only embed projections, plain token
   * previews), whiteboard falls back to the placeholder box.
   */
  renderWhiteboard?: ((token: unknown, index: number) => ReactNode) | undefined;
  /**
   * Live asset renderer for `asset_ref` tokens (AssetView), injected by the
   * row; `fullBleed` is true when the token is alone in its stream
   * (SCHEMA.md:61 — a block whose entire content is one asset renders at
   * block width). When absent (read-only embed projections), asset_ref falls
   * back to the placeholder box.
   */
  renderAsset?: ((token: unknown, index: number, fullBleed: boolean) => ReactNode) | undefined;
  /**
   * Card renderer for `embed_ref` tokens carrying a card `view`
   * (§34.34 B8 — the intermediate reference views between mention and full
   * transclusion). Injected by the row; when absent, card views fall back
   * to the default `renderEmbed` (the full live subtree). Receives the raw
   * token + its stream index so the renderer can write the token's `view`.
   */
  renderEmbedCard?:
    | ((
        nodeId: string,
        view: "small_card" | "wide_card",
        token: unknown,
        index: number,
      ) => ReactNode)
    | undefined;
  /**
   * PG1 bound-verb label: resolves a typed_link mark's `{ propertySchemaId }`
   * verb to the schema's display name (title tooltip). When absent, the raw
   * schema id shows (the broken-mention fallback philosophy).
   */
  resolveVerb?: ((propertySchemaId: string) => string | null) | undefined;
  /**
   * Navigation for inline node references: when set, mention tokens render
   * as dashed-underline links that open the target (read mode).
   */
  onOpenNode?: ((nodeId: string) => void) | undefined;
  /** Effective-color resolver: tints mention underlines with the target's color. */
  resolveColor?: ((nodeId: string) => string | null) | undefined;
  /**
   * Right-click menu for mention tokens (the node-link context menu):
   * receives the token identity + pointer position; the caller supplies the
   * owning node's id (see openNodeLinkMenu). Works in every view mode.
   */
  onMentionMenu?:
    | ((info: {
        targetNodeId: string;
        tokenIndex: number;
        displayText?: string | undefined;
        x: number;
        y: number;
      }) => void)
    | undefined;
}

function renderMarkedText(text: string, marks: readonly string[] | undefined): ReactNode {
  if (!marks || marks.length === 0) return text;
  let node: ReactNode = text;
  for (let i = marks.length - 1; i >= 0; i -= 1) {
    switch (marks[i]) {
      case "bold":
        node = <strong>{node}</strong>;
        break;
      case "italic":
        node = <em>{node}</em>;
        break;
      case "strike":
        node = <s>{node}</s>;
        break;
      case "highlight":
        node = <mark>{node}</mark>;
        break;
      case "code":
        node = <code>{node}</code>;
        break;
      default:
        break;
    }
  }
  return node;
}

function Placeholder({ label, detail }: { label: string; detail?: string | undefined }) {
  return (
    <span className="nt-placeholder" title={detail ?? label}>
      {label}
    </span>
  );
}

function renderToken(
  token: unknown,
  key: number,
  resolveName: InlineTokensProps["resolveName"],
  resolveVerb: InlineTokensProps["resolveVerb"],
  renderEmbed: InlineTokensProps["renderEmbed"],
  renderEmbedCard: InlineTokensProps["renderEmbedCard"],
  renderQuery: InlineTokensProps["renderQuery"],
  renderWhiteboard: InlineTokensProps["renderWhiteboard"],
  renderAsset: InlineTokensProps["renderAsset"],
  assetAlone: boolean,
  onOpenNode: InlineTokensProps["onOpenNode"],
  resolveColor: InlineTokensProps["resolveColor"],
  onMentionMenu: InlineTokensProps["onMentionMenu"],
): ReactNode {
  if (typeof token !== "object" || token === null) return null;
  const t = token as Record<string, unknown>;
  switch (t.type) {
    case "text": {
      if (typeof t.text !== "string") return null;
      return <span key={key}>{renderMarkedText(t.text, Array.isArray(t.marks) ? t.marks.filter((m): m is string => typeof m === "string") : undefined)}</span>;
    }
    case "typed_link": {
      if (typeof t.text !== "string") return null;
      // PG1: a bound verb (`{ propertySchemaId }`) renders the schema's name
      // in the tooltip; a free verb renders as written.
      const boundSchemaId =
        typeof t.verb === "object" && t.verb !== null && "propertySchemaId" in t.verb
          ? String((t.verb as { propertySchemaId: unknown }).propertySchemaId)
          : null;
      const verb =
        typeof t.verb === "string"
          ? t.verb
          : boundSchemaId !== null
            ? (resolveVerb?.(boundSchemaId) ?? boundSchemaId)
            : "link";
      return (
        <span key={key} className="nt-typed-link" title={verb} data-verb-bound={boundSchemaId ?? undefined}>
          {t.text}
        </span>
      );
    }
    case "mention": {
      const targetNodeId = typeof t.targetNodeId === "string" ? t.targetNodeId : "";
      const displayText = typeof t.displayText === "string" ? t.displayText : undefined;
      const name =
        displayText ??
        (targetNodeId ? (resolveName?.(targetNodeId) ?? undefined) : undefined) ??
        (typeof t.text === "string" ? t.text : undefined) ??
        targetNodeId;
      if (!name) return null;
      const mentionMenuProps =
        onMentionMenu === undefined
          ? undefined
          : {
              onContextMenu: (event: { preventDefault(): void; clientX: number; clientY: number }) => {
                event.preventDefault();
                onMentionMenu({
                  targetNodeId,
                  tokenIndex: key,
                  displayText,
                  x: event.clientX,
                  y: event.clientY,
                });
              },
            };
      if (onOpenNode !== undefined && targetNodeId !== "") {
        const linkColor = resolveColor?.(targetNodeId) ?? null;
        return (
          <button
            key={key}
            type="button"
            className="nt-link"
            title={targetNodeId}
            style={linkColor !== null ? { borderBottomColor: cssColorFor(linkColor) } : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onOpenNode(targetNodeId);
            }}
            {...mentionMenuProps}
          >
            {name}
          </button>
        );
      }
      return (
        <span key={key} className="nt-chip nt-mention" title={targetNodeId || undefined} {...mentionMenuProps}>
          {name}
        </span>
      );
    }
    case "class_chip": {
      const classId = typeof t.classId === "string" ? t.classId : "";
      const name =
        (typeof t.displayText === "string" ? t.displayText : undefined) ??
        (classId ? (resolveName?.(classId) ?? undefined) : undefined) ??
        classId;
      if (!name) return null;
      return (
        <span key={key} className="nt-chip nt-class-chip" title={classId || undefined}>
          {name}
        </span>
      );
    }
    case "quote": {
      const children = Array.isArray(t.children) ? t.children : [];
      return (
        <span key={key} className="nt-quote">
          <InlineTokens tokens={children} resolveName={resolveName} resolveVerb={resolveVerb} renderEmbed={renderEmbed} onOpenNode={onOpenNode} resolveColor={resolveColor} />
        </span>
      );
    }
    case "external_link": {
      if (typeof t.href !== "string" || typeof t.text !== "string") return null;
      return (
        <a key={key} className="nt-external-link" href={t.href} target="_blank" rel="noreferrer">
          {t.text}
        </a>
      );
    }
    case "math": {
      if (typeof t.expression !== "string") return null;
      // Slice 1: no KaTeX; plain code fallback.
      return (
        <code key={key} className="nt-math">
          {t.expression}
        </code>
      );
    }
    case "hard_break":
      return <br key={key} />;
    case "asset_ref":
      if (renderAsset !== undefined) {
        return <Fragment key={key}>{renderAsset(token, key, assetAlone)}</Fragment>;
      }
      return <Placeholder key={key} label="asset" detail={typeof t.assetId === "string" ? t.assetId : undefined} />;
    case "embed_ref": {
      const nodeId = typeof t.nodeId === "string" ? t.nodeId : "";
      const view = t.view === "small_card" || t.view === "wide_card" ? t.view : null;
      if (view !== null && renderEmbedCard !== undefined && nodeId !== "") {
        return <Fragment key={key}>{renderEmbedCard(nodeId, view, token, key)}</Fragment>;
      }
      if (renderEmbed !== undefined && nodeId !== "") {
        return <Fragment key={key}>{renderEmbed(nodeId, token, key)}</Fragment>;
      }
      return <Placeholder key={key} label="embed" detail={nodeId || undefined} />;
    }
    case "code_block": {
      // Read-only block-scale render (§34.34 B3): the source verbatim in a
      // mono pre, with the optional language hint as a badge. The editing
      // surface (CodeTextarea in an editor branch) is designed with the
      // token but stays unshipped until the protocol lockstep lands.
      if (typeof t.text !== "string") return null;
      const language = typeof t.language === "string" ? t.language : null;
      return (
        <span key={key} className="nt-code-block">
          {language !== null && <span className="nt-code-block__lang">{language}</span>}
          <pre className="nt-code-block__pre">
            <code>{t.text}</code>
          </pre>
        </span>
      );
    }
    case "hr":
      return <hr key={key} className="nt-hr" />;
    case "query": {
      if (renderQuery !== undefined) {
        return <Fragment key={key}>{renderQuery(token, key)}</Fragment>;
      }
      return <Placeholder key={key} label="query" />;
    }
    case "whiteboard":
      if (renderWhiteboard !== undefined) {
        return <Fragment key={key}>{renderWhiteboard(token, key)}</Fragment>;
      }
      return <Placeholder key={key} label="whiteboard" />;
    default:
      // Unknown token type: graceful fallback — render nothing, never crash.
      return null;
  }
}

export function InlineTokens({ tokens, resolveName, resolveVerb, renderEmbed, renderEmbedCard, renderQuery, renderWhiteboard, renderAsset, onOpenNode, resolveColor, onMentionMenu }: InlineTokensProps) {
  // SCHEMA.md:61 — an asset_ref alone in its stream renders full-bleed; the
  // flag reaches only the (single) asset token in that stream.
  const assetAlone =
    renderAsset !== undefined &&
    tokens.length === 1 &&
    typeof tokens[0] === "object" &&
    tokens[0] !== null &&
    (tokens[0] as { type?: unknown }).type === "asset_ref";
  return (
    <>
      {tokens.map((token, index) => renderToken(token, index, resolveName, resolveVerb, renderEmbed, renderEmbedCard, renderQuery, renderWhiteboard, renderAsset, assetAlone, onOpenNode, resolveColor, onMentionMenu))}
    </>
  );
}
