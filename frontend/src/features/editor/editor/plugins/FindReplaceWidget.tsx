/**
 * FindReplaceWidget — Floating find & replace toolbar.
 *
 * Searches and replaces across all registered per-block custom inline editors.
 * Replace section is collapsed by default. Click the chevron
 * or press Ctrl/Cmd+H to expand it (traditional behaviour).
 */

import { useCallback, useEffect, useRef, type JSX } from 'react';
import { useFindReplaceStore } from '@/stores/findReplaceStore';
import { Button } from '@/components/ui/Button';
import {
  executeBlockSearch,
  selectBlockMatch,
  replaceBlockMatch,
  replaceAllBlockMatches,
} from './blockFindReplace';
import { ChevronRightIcon, ChevronDownIcon } from '@/components/ui/icons';
import './FindReplaceWidget.css';

export function FindReplaceWidget(): JSX.Element {
  const query = useFindReplaceStore((s) => s.query);
  const replaceText = useFindReplaceStore((s) => s.replaceText);
  const matchIndex = useFindReplaceStore((s) => s.matchIndex);
  const totalMatches = useFindReplaceStore((s) => s.totalMatches);
  const caseSensitive = useFindReplaceStore((s) => s.caseSensitive);
  const replaceExpanded = useFindReplaceStore((s) => s.replaceExpanded);
  const matches = useFindReplaceStore((s) => s.matches);
  const setQuery = useFindReplaceStore((s) => s.setQuery);
  const setReplaceText = useFindReplaceStore((s) => s.setReplaceText);
  const setMatchIndex = useFindReplaceStore((s) => s.setMatchIndex);
  const setTotalMatches = useFindReplaceStore((s) => s.setTotalMatches);
  const setMatches = useFindReplaceStore((s) => s.setMatches);
  const close = useFindReplaceStore((s) => s.close);
  const toggleCaseSensitive = useFindReplaceStore((s) => s.toggleCaseSensitive);
  const toggleReplaceExpanded = useFindReplaceStore((s) => s.toggleReplaceExpanded);

  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    findInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (replaceExpanded) {
      replaceInputRef.current?.focus();
    }
  }, [replaceExpanded]);

  const runSearch = useCallback(() => {
    const result = executeBlockSearch(query, caseSensitive);
    setMatches(result);
    setTotalMatches(result.length);
    setMatchIndex(result.length > 0 ? 0 : 0);
    if (result.length > 0) {
      selectBlockMatch(result[0]);
    }
  }, [query, caseSensitive, setMatches, setTotalMatches, setMatchIndex]);

  useEffect(() => {
    runSearch();
  }, [query, caseSensitive, runSearch]);

  const goNext = useCallback(() => {
    if (matches.length === 0) return;
    const next = (matchIndex + 1) % matches.length;
    setMatchIndex(next);
    selectBlockMatch(matches[next]);
  }, [matches, matchIndex, setMatchIndex]);

  const goPrev = useCallback(() => {
    if (matches.length === 0) return;
    const prev = (matchIndex - 1 + matches.length) % matches.length;
    setMatchIndex(prev);
    selectBlockMatch(matches[prev]);
  }, [matches, matchIndex, setMatchIndex]);

  const handleReplace = useCallback(() => {
    if (matches.length === 0 || !replaceText) return;
    const match = matches[matchIndex];

    replaceBlockMatch(match, replaceText);

    // Re-run search after replacement
    const remaining = matches.filter(
      (m, i) =>
        i !== matchIndex &&
        (m.blockId !== match.blockId || m.offset < match.offset),
    );
    // Adjust indices for same-block matches after this offset
    const adjusted = remaining.map((m) =>
      m.blockId === match.blockId && m.offset > match.offset
        ? { ...m, offset: m.offset + replaceText.length - match.length }
        : m,
    );
    setMatches(adjusted);
    setTotalMatches(adjusted.length);
    if (adjusted.length > 0) {
      const next = Math.min(matchIndex, adjusted.length - 1);
      setMatchIndex(next);
      selectBlockMatch(adjusted[next]);
    }
  }, [matches, matchIndex, replaceText, setMatches, setTotalMatches, setMatchIndex]);

  const handleReplaceAll = useCallback(() => {
    if (matches.length === 0 || !replaceText) return;
    replaceAllBlockMatches(matches, replaceText);
    setMatches([]);
    setTotalMatches(0);
    setMatchIndex(0);
  }, [matches, replaceText, setMatches, setTotalMatches, setMatchIndex]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goNext();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="find-replace-widget" data-editor-companion onKeyDown={onKeyDown} role="toolbar" aria-label="Find and replace" tabIndex={0}>
      <div className="find-replace-row">
        <button
          className="find-replace-btn find-replace-expand"
          onClick={toggleReplaceExpanded}
          title={replaceExpanded ? 'Hide replace' : 'Show replace'}
          aria-label={replaceExpanded ? 'Hide replace' : 'Show replace'}
        >
          {replaceExpanded ? (
            <ChevronDownIcon size="sm" />
          ) : (
            <ChevronRightIcon size="sm" />
          )}
        </button>
        <input
          ref={findInputRef}
          type="text"
          className="find-replace-input"
          placeholder="Find..."
          aria-label="Find"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="find-replace-count">
          {totalMatches > 0 ? `${matchIndex + 1}/${totalMatches}` : '0/0'}
        </span>
        <Button variant="ghost" size="xs" icon="mdi mdi-chevron-up" aria-label="Previous match" className="find-replace-btn" onClick={goPrev} disabled={totalMatches === 0} />
        <Button variant="ghost" size="xs" icon="mdi mdi-chevron-up" aria-label="Next match" className="find-replace-btn" onClick={goNext} disabled={totalMatches === 0} />
        <button
          className={`find-replace-btn ${caseSensitive ? 'active' : ''}`}
          onClick={toggleCaseSensitive}
          title="Match case"
          aria-label="Match case"
          aria-pressed={caseSensitive}
        >
          Aa
        </button>
        <Button variant="ghost" size="xs" icon="mdi mdi-close" aria-label="Close find and replace" className="find-replace-btn find-replace-close" onClick={close} />
      </div>
      {replaceExpanded && (
        <div className="find-replace-row">
          <span className="find-replace-spacer" />
          <input
            ref={replaceInputRef}
            type="text"
            className="find-replace-input"
            placeholder="Replace..."
            aria-label="Replace"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
          />
          <button className="find-replace-btn" onClick={handleReplace} disabled={totalMatches === 0}>
            Replace
          </button>
          <button className="find-replace-btn" onClick={handleReplaceAll} disabled={totalMatches === 0}>
            Replace All
          </button>
        </div>
      )}
    </div>
  );
}
