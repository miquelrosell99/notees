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
 * renderWhiteboard callback (placeholder box when absent); other block-scale
 * tokens render as labeled placeholder boxes.
 */

import { Fragment, type ReactNode } from "react";

export interface InlineTokensProps {
  tokens: readonly unknown[];
  resolveName?: ((nodeId: string) => string | null) | undefined;
  /**
   * Live embed renderer for `embed_ref` tokens (EmbedView). Injected by the
   * row so this module stays pure; when absent, embed_ref falls back to the
   * placeholder box.
   */
  renderEmbed?: ((nodeId: string) => ReactNode) | undefined;
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
   * Navigation for inline node references: when set, mention tokens render
   * as dashed-underline links that open the target (read mode).
   */
  onOpenNode?: ((nodeId: string) => void) | undefined;
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
  renderEmbed: InlineTokensProps["renderEmbed"],
  renderQuery: InlineTokensProps["renderQuery"],
  renderWhiteboard: InlineTokensProps["renderWhiteboard"],
  onOpenNode: InlineTokensProps["onOpenNode"],
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
      const verb =
        typeof t.verb === "string"
          ? t.verb
          : typeof t.verb === "object" && t.verb !== null && "propertySchemaId" in t.verb
            ? String((t.verb as { propertySchemaId: unknown }).propertySchemaId)
            : "link";
      return (
        <span key={key} className="nt-typed-link" title={verb}>
          {t.text}
        </span>
      );
    }
    case "mention": {
      const targetNodeId = typeof t.targetNodeId === "string" ? t.targetNodeId : "";
      const name =
        (typeof t.displayText === "string" ? t.displayText : undefined) ??
        (targetNodeId ? (resolveName?.(targetNodeId) ?? undefined) : undefined) ??
        (typeof t.text === "string" ? t.text : undefined) ??
        targetNodeId;
      if (!name) return null;
      if (onOpenNode !== undefined && targetNodeId !== "") {
        return (
          <button
            key={key}
            type="button"
            className="nt-link"
            title={targetNodeId}
            onClick={(event) => {
              event.stopPropagation();
              onOpenNode(targetNodeId);
            }}
          >
            {name}
          </button>
        );
      }
      return (
        <span key={key} className="nt-chip nt-mention" title={targetNodeId || undefined}>
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
          <InlineTokens tokens={children} resolveName={resolveName} renderEmbed={renderEmbed} onOpenNode={onOpenNode} />
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
      return <Placeholder key={key} label="asset" detail={typeof t.assetId === "string" ? t.assetId : undefined} />;
    case "embed_ref": {
      const nodeId = typeof t.nodeId === "string" ? t.nodeId : "";
      if (renderEmbed !== undefined && nodeId !== "") {
        return <Fragment key={key}>{renderEmbed(nodeId)}</Fragment>;
      }
      return <Placeholder key={key} label="embed" detail={nodeId || undefined} />;
    }
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

export function InlineTokens({ tokens, resolveName, renderEmbed, renderQuery, renderWhiteboard, onOpenNode }: InlineTokensProps) {
  return (
    <>
      {tokens.map((token, index) => renderToken(token, index, resolveName, renderEmbed, renderQuery, renderWhiteboard, onOpenNode))}
    </>
  );
}
