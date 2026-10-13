/**
 * FindInPageBar — the Capacities-parity find-in-page bar (Cmd/Ctrl+F).
 *
 * Searches the OPEN page's whole block tree over the DATA (see
 * findInPage.ts), so collapsed/hidden blocks are found like rendered ones;
 * only the navigation flash needs a DOM row. Docked by the host at the top
 * of the page content column (sticky in the nodeview's scroll box).
 *
 * Controls: the find input (autofocused; Enter = next, Shift+Enter =
 * previous), a match counter (n/total, "No results" at zero), prev/next
 * chevrons, a case-sensitive toggle (Aa), a whole-word toggle, a replace
 * toggle revealing the replace input + "Replace"/"Replace all" buttons, and
 * a close button (Escape also closes, from anywhere — the
 * FindReplaceWidget precedent).
 *
 * v1 scope (documented in findInPage.ts): replace writes one object.update
 * per affected block, swapping the matched span inside its single text
 * token; matches spanning tokens (mention boundaries etc.) are navigable
 * but skipped by replace with a console-free no-op. Every write re-runs the
 * search (the client's change notification bumps this bar's snapshot).
 * There is deliberately NO CSS Custom Highlight API painting of all matches
 * — cross-browser churn; flash-on-navigate only.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { WorkerClient } from "@/core/worker-client.js";
import type { WorkspaceClient } from "@/core/workspace-client.js";

import { Icon } from "../Icon.js";
import {
  applyReplace,
  collectSubtreeBlocks,
  findMatchesInBlocks,
  planReplace,
  type FindInPageMatch,
} from "./findInPage.js";
import "./FindInPageBar.css";

interface FindInPageBarProps {
  client: WorkspaceClient | WorkerClient;
  /** The open page's id — the subtree walk roots here. */
  pageId: string;
  /** The page root: the current match's row is scrolled/flashed inside it. */
  scopeRef: RefObject<HTMLElement | null>;
  /** The host's ref to the find input (Cmd/Ctrl+F while open focuses it). */
  inputRef?: RefObject<HTMLInputElement | null> | undefined;
  onClose: () => void;
}

export function FindInPageBar({ client, pageId, scopeRef, inputRef, onClose }: FindInPageBarProps) {
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);

  /** The client-notification bump: every op (a replace write included)
   *  re-collects the subtree, so the search re-runs after a replace. */
  const [version, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const internalInputRef = useRef<HTMLInputElement>(null);
  const findInputRef = inputRef ?? internalInputRef;

  const blocks = useMemo(
    () => collectSubtreeBlocks(client, pageId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the snapshot stamp.
    [client, pageId, version],
  );
  const matches = useMemo(
    () => findMatchesInBlocks(blocks, query, { caseSensitive, wholeWord }),
    [blocks, query, caseSensitive, wholeWord],
  );

  const total = matches.length;
  const index = total === 0 ? 0 : Math.min(matchIndex, total - 1);
  const current = total === 0 ? undefined : matches[index];
  const replaceableCount = useMemo(
    () => matches.filter((m) => m.replaceable).length,
    [matches],
  );

  // A new query (or toggle) restarts the walk at the first match.
  useEffect(() => {
    setMatchIndex(0);
  }, [query, caseSensitive, wholeWord]);

  useEffect(() => {
    findInputRef.current?.focus();
  }, [findInputRef]);

  // Navigation: scroll the current match's block row into view (block-center)
  // and flash it. Rows inside collapsed subtrees have no DOM element — the
  // match still counts (the DATA walk); the flash/scroll simply skips.
  useEffect(() => {
    const root = scopeRef.current;
    const match: FindInPageMatch | undefined = matches[index];
    if (root === null || match === undefined) return;
    const el = root.querySelector(`[data-block-id="${CSS.escape(match.blockId)}"]`);
    if (!(el instanceof HTMLElement)) return;
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    el.classList.remove("nt-block--flash");
    // Restart the flash animation when the same row is hit twice.
    void el.offsetWidth;
    el.classList.add("nt-block--flash");
    const timer = window.setTimeout(() => el.classList.remove("nt-block--flash"), 1400);
    return () => {
      window.clearTimeout(timer);
      // Only the current match flashes: navigating away removes the class
      // (the timer alone would leave it lingering on the previous row).
      el.classList.remove("nt-block--flash");
    };
  }, [matches, index, scopeRef]);

  // Escape closes from anywhere while the bar is open (the FindReplaceWidget
  // precedent); Enter inside the bar navigates.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const goNext = () => {
    if (total === 0) return;
    setMatchIndex((Math.min(matchIndex, total - 1) + 1) % total);
  };
  const goPrev = () => {
    if (total === 0) return;
    setMatchIndex((Math.min(matchIndex, total - 1) - 1 + total) % total);
  };

  /** One replace write through the workspace client; the v1 scope's
   *  non-replaceable matches (planReplace === null) are a console-free
   *  no-op. */
  const runReplace = (match: FindInPageMatch) => {
    const block = blocks.find((b) => b.blockId === match.blockId);
    if (block === undefined || replaceText === "") return;
    const plan = planReplace(block, match);
    if (plan === null) return;
    void client.updateObject(match.blockId, {
      contentAst: applyReplace(block.ast, plan, replaceText),
    });
    // The search re-runs off the write's change notification.
  };

  const handleReplace = () => {
    if (current === undefined || !current.replaceable) return;
    runReplace(current);
  };

  const handleReplaceAll = () => {
    if (replaceableCount === 0 || replaceText === "") return;
    // Group by block; one object.update per affected block. Plans share one
    // snapshot per block, so apply last-to-first (token, offset) and the
    // earlier spans stay valid.
    const byBlock = new Map<string, FindInPageMatch[]>();
    for (const match of matches) {
      if (!match.replaceable) continue;
      const list = byBlock.get(match.blockId);
      if (list === undefined) byBlock.set(match.blockId, [match]);
      else list.push(match);
    }
    for (const [blockId, blockMatches] of byBlock) {
      const block = blocks.find((b) => b.blockId === blockId);
      if (block === undefined) continue;
      const plans = blockMatches
        .map((m) => planReplace(block, m))
        .filter((p) => p !== null)
        .sort((a, b) => b.tokenIndex - a.tokenIndex || b.start - a.start);
      let ast = block.ast;
      for (const plan of plans) ast = applyReplace(ast, plan, replaceText);
      void client.updateObject(blockId, { contentAst: ast });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="find-in-page"
      data-find-in-page
      role="toolbar"
      aria-label="Find in page"
      onKeyDown={onKeyDown}
    >
      <div className="find-in-page__row">
        <input
          ref={findInputRef}
          type="text"
          className="find-in-page__input"
          placeholder="Find in page…"
          aria-label="Find in page"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="find-in-page__count" aria-live="polite">
          {query === "" ? "0/0" : total > 0 ? `${index + 1}/${total}` : "No results"}
        </span>
        <button
          type="button"
          aria-label="Previous match"
          title="Previous match"
          className="find-in-page__btn find-in-page__btn--icon"
          onClick={goPrev}
          disabled={total === 0}
        >
          <Icon path="mdi-chevron-up" size="sm" />
        </button>
        <button
          type="button"
          aria-label="Next match"
          title="Next match"
          className="find-in-page__btn find-in-page__btn--icon"
          onClick={goNext}
          disabled={total === 0}
        >
          <Icon path="mdi-chevron-down" size="sm" />
        </button>
        <button
          type="button"
          className={`find-in-page__btn ${caseSensitive ? "find-in-page__btn--active" : ""}`}
          onClick={() => setCaseSensitive((v) => !v)}
          title="Match case"
          aria-label="Match case"
          aria-pressed={caseSensitive}
        >
          Aa
        </button>
        <button
          type="button"
          className={`find-in-page__btn ${wholeWord ? "find-in-page__btn--active" : ""}`}
          onClick={() => setWholeWord((v) => !v)}
          title="Match whole word"
          aria-label="Match whole word"
          aria-pressed={wholeWord}
        >
          ab
        </button>
        <button
          type="button"
          className={`find-in-page__btn ${replaceOpen ? "find-in-page__btn--active" : ""}`}
          onClick={() => setReplaceOpen((v) => !v)}
          title={replaceOpen ? "Hide replace" : "Show replace"}
          aria-label={replaceOpen ? "Hide replace" : "Show replace"}
          aria-pressed={replaceOpen}
        >
          {replaceOpen ? <Icon path="mdi-chevron-down" size="sm" /> : <Icon path="mdi-chevron-right" size="sm" />}
        </button>
        <button
          type="button"
          aria-label="Close find in page"
          title="Close find in page"
          className="find-in-page__btn find-in-page__btn--icon"
          onClick={onClose}
        >
          <Icon path="mdi-close" size="sm" />
        </button>
      </div>
      {replaceOpen && (
        <div className="find-in-page__row">
          <input
            type="text"
            className="find-in-page__input"
            placeholder="Replace…"
            aria-label="Replace"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
          />
          <button
            type="button"
            className="find-in-page__btn"
            onClick={handleReplace}
            disabled={replaceText === "" || current === undefined || !current.replaceable}
            title="Replace"
          >
            Replace
          </button>
          <button
            type="button"
            className="find-in-page__btn"
            onClick={handleReplaceAll}
            disabled={replaceText === "" || replaceableCount === 0}
            title="Replace all"
          >
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}
