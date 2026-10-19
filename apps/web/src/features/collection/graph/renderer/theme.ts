/**
 * theme.ts — resolves the graph view's canvas colors from the design tokens
 * (`--graph-*` custom properties in variables.css, both themes) and
 * re-resolves them when `data-theme` flips (the archived MutationObserver
 * approach, encapsulated). No hex literals of our own — the fallbacks only
 * fire when the custom properties are absent (tests).
 */

import type { LabelColors } from "./labelCanvas.js";

/**
 * Resolves a custom property to a concrete `#rrggbb` string, following ONE
 * level of `var(--other)` indirection — custom properties read via
 * getComputedStyle keep `var()` references UNRESOLVED (substitution happens
 * at use-site), so a token that aliases another token (e.g.
 * `--graph-minimap-viewport: var(--md-sys-color-primary)`) must be chased one hop.
 * Returns null when the value is anything but a plain hex color.
 */
function resolveHexVar(varName: string): string | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw);
  const resolved = alias !== null
    ? getComputedStyle(document.documentElement).getPropertyValue(alias[1]!).trim()
    : raw;
  const match = /^#([0-9a-f]{6})$/i.exec(resolved);
  return match === null ? null : match[1]!;
}

function hexVarToRgba(varName: string, alpha: number, fallback: string): string {
  const hex = resolveHexVar(varName);
  if (hex === null) return fallback;
  const rgb = parseInt(hex, 16);
  const channel = (shift: number) => ((rgb >> shift) & 0xff).toString(16).padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

function hexVarToRgbaTuple(
  varName: string,
  alpha: number,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  const hex = resolveHexVar(varName);
  if (hex === null) return fallback;
  const rgb = parseInt(hex, 16);
  return [((rgb >> 16) & 0xff) / 255, ((rgb >> 8) & 0xff) / 255, (rgb & 0xff) / 255, alpha];
}

function hexVarToRgbTriple(
  varName: string,
  fallback: [number, number, number],
): [number, number, number] {
  const hex = resolveHexVar(varName);
  if (hex === null) return fallback;
  const rgb = parseInt(hex, 16);
  return [((rgb >> 16) & 0xff) / 255, ((rgb >> 8) & 0xff) / 255, (rgb & 0xff) / 255];
}

export interface GraphTheme extends LabelColors {
  /** Default node fill when the node carries no color of its own. */
  nodeDefault: [number, number, number, number];
  /** Structural edge stroke. */
  edgeDefault: [number, number, number];
  /** Semantic (co-occurrence) edge stroke — the --graph-edge-cooccurrence token. */
  semanticEdge: [number, number, number];
  /**
   * The app's current accent (--md-sys-color-primary) — the hover-neighborhood
   * highlight color (owner ruling 2026-10-13: the hovered node, its incident
   * edges, and its linked nodes highlight in the accent, Obsidian-style).
   */
  accent: [number, number, number];
  /** Minimap node dots — the --graph-minimap-dot token at low alpha. */
  minimapDot: string;
  /** Minimap viewport rectangle stroke — the --graph-minimap-viewport token. */
  minimapViewport: string;
  /** Minimap viewport interior wash (the viewed region, accent-tinted). */
  minimapViewportFill: string;
}

let cache: GraphTheme | null = null;
let observer: MutationObserver | null = null;

export function graphTheme(): GraphTheme {
  if (cache !== null) return cache;
  cache = {
    regular: hexVarToRgba("--md-sys-color-on-surface", 0.85, "rgba(220,220,220,0.85)"),
    emphasis: hexVarToRgba("--md-sys-color-on-surface", 1.0, "rgba(240,240,240,1.0)"),
    shadow: hexVarToRgba("--md-sys-color-surface", 0.9, "rgba(18,18,18,0.9)"),
    nodeDefault: hexVarToRgbaTuple("--graph-node-default", 1.0, [0.62, 0.62, 0.66, 1.0]),
    edgeDefault: hexVarToRgbTriple("--graph-edge-color", [0.83, 0.83, 0.83]),
    semanticEdge: hexVarToRgbTriple("--graph-edge-cooccurrence", [0.54, 0.42, 0.79]),
    accent: hexVarToRgbTriple("--md-sys-color-primary", [0.427, 0.655, 0.537]),
    minimapDot: hexVarToRgba("--graph-minimap-dot", 0.55, "rgba(140,140,140,0.55)"),
    minimapViewport: hexVarToRgba("--graph-minimap-viewport", 0.9, "rgba(92,84,76,0.9)"),
    minimapViewportFill: hexVarToRgba("--graph-minimap-viewport", 0.12, "rgba(92,84,76,0.12)"),
  };
  if (observer === null && typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => {
      cache = null;
    });
    observer.observe(document.documentElement, {
      attributes: true,
      // Accent tints the dark surfaces and OLED flips the ground, so a
      // token re-resolve is needed on those flips too.
      attributeFilter: ["data-theme", "data-accent", "data-oled"],
    });
  }
  return cache;
}
