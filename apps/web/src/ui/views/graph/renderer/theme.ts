/**
 * theme.ts — resolves the graph view's canvas colors from the design tokens
 * (`--graph-*` custom properties in variables.css, both themes) and
 * re-resolves them when `data-theme` flips (the archived MutationObserver
 * approach, encapsulated). No hex literals of our own — the fallbacks only
 * fire when the custom properties are absent (tests).
 */

import type { LabelColors } from "./labelCanvas.js";

function hexVarToRgba(varName: string, alpha: number, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const match = /^#([0-9a-f]{6})$/i.exec(raw);
  if (match === null) return fallback;
  const rgb = parseInt(match[1]!, 16);
  const channel = (shift: number) => ((rgb >> shift) & 0xff).toString().padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

function hexVarToRgbaTuple(
  varName: string,
  alpha: number,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const match = /^#([0-9a-f]{6})$/i.exec(raw);
  if (match === null) return fallback;
  const rgb = parseInt(match[1]!, 16);
  return [((rgb >> 16) & 0xff) / 255, ((rgb >> 8) & 0xff) / 255, (rgb & 0xff) / 255, alpha];
}

function hexVarToRgbTriple(
  varName: string,
  fallback: [number, number, number],
): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const match = /^#([0-9a-f]{6})$/i.exec(raw);
  if (match === null) return fallback;
  const rgb = parseInt(match[1]!, 16);
  return [((rgb >> 16) & 0xff) / 255, ((rgb >> 8) & 0xff) / 255, (rgb & 0xff) / 255];
}

export interface GraphTheme extends LabelColors {
  /** Default node fill when the node carries no color of its own. */
  nodeDefault: [number, number, number, number];
  /** Structural edge stroke. */
  edgeDefault: [number, number, number];
  /** Semantic (co-occurrence) edge stroke — the --graph-edge-cooccurrence token. */
  semanticEdge: [number, number, number];
}

let cache: GraphTheme | null = null;
let observer: MutationObserver | null = null;

export function graphTheme(): GraphTheme {
  if (cache !== null) return cache;
  cache = {
    regular: hexVarToRgba("--color-on-surface", 0.85, "rgba(220,220,220,0.85)"),
    emphasis: hexVarToRgba("--color-on-surface", 1.0, "rgba(240,240,240,1.0)"),
    shadow: hexVarToRgba("--color-surface", 0.9, "rgba(18,18,18,0.9)"),
    nodeDefault: hexVarToRgbaTuple("--graph-node-default", 1.0, [0.62, 0.62, 0.66, 1.0]),
    edgeDefault: hexVarToRgbTriple("--graph-edge-color", [0.83, 0.83, 0.83]),
    semanticEdge: hexVarToRgbTriple("--graph-edge-cooccurrence", [0.54, 0.42, 0.79]),
  };
  if (observer === null && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => {
      cache = null;
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
  return cache;
}
