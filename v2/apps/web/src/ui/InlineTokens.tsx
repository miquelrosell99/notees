/**
 * InlineTokens — renders a flat content token stream (SCHEMA.md content
 * grammar) into React elements. Renders only what slice 1 implements;
 * unknown tokens render nothing (never crash). Text marks map to
 * <strong>/<em>/<s>/<mark>/<code>; mentions and class chips render as chips
 * (names resolved through the optional resolveName callback, with graceful
 * fallbacks); quote recurses; block-scale tokens render as labeled
 * placeholder boxes.
 */

import type { ReactNode } from "react";

export interface InlineTokensProps {
  tokens: readonly unknown[];
  resolveName?: ((nodeId: string) => string | null) | undefined;
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

function renderToken(token: unknown, key: number, resolveName: InlineTokensProps["resolveName"]): ReactNode {
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
          <InlineTokens tokens={children} resolveName={resolveName} />
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
    case "embed_ref":
      return <Placeholder key={key} label="embed" detail={typeof t.nodeId === "string" ? t.nodeId : undefined} />;
    case "query":
      return <Placeholder key={key} label="query" />;
    case "whiteboard":
      return <Placeholder key={key} label="whiteboard" />;
    default:
      // Unknown token type: graceful fallback — render nothing, never crash.
      return null;
  }
}

export function InlineTokens({ tokens, resolveName }: InlineTokensProps) {
  return (
    <>
      {tokens.map((token, index) => renderToken(token, index, resolveName))}
    </>
  );
}
