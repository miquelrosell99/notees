/**
 * TriggerPopup — Popup UI for editor triggers.
 *
 * Renders the appropriate popup based on trigger type:
 * - @   → Link search (TriggerSuggestionPopup)
 * - +   → Type/class search (TriggerSuggestionPopup)
 * - #   → Tag search (TriggerSuggestionPopup)
 * - /   → Slash commands (SlashCommandMenu)
 */

import { useCallback, type JSX } from 'react';
import type { TriggerType } from './TriggerPlugin';
import type { SuggestionType } from '../../components/nodes/SuggestionPopup';
import type { Node } from '../../types/api';
import { TriggerSuggestionPopup } from './TriggerSuggestionPopup';
import { SlashCommandMenu } from './SlashCommandMenu';
import './TriggerPopup.css';

// ─── Props ────────────────────────────────────────────────────────

export interface TriggerPopupProps {
  type: TriggerType;
  query: string;
  position: { top: number; left: number };
  onSelect: (value: string, metadata?: unknown) => void;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────

export function TriggerPopup({
  type,
  query,
  position,
  onSelect,
  onClose,
}: TriggerPopupProps): JSX.Element | null {
  const suggestionType: SuggestionType = type === 'type' ? 'class' : type === 'slash' ? 'type' : type;

  const handleSelect = useCallback((node: Node, _addInline: boolean) => {
    onSelect(node.uuid, { node, type: suggestionType });
  }, [onSelect, suggestionType]);

  const handleSelectDatePage = useCallback((pageId: string, _pageName: string) => {
    onSelect(pageId, { type: 'date' });
  }, [onSelect]);

  // For link/type/tag triggers, use TriggerSuggestionPopup
  if (type === 'link' || type === 'type' || type === 'tag') {
    return (
      <TriggerSuggestionPopup
        suggestionType={suggestionType}
        triggerType={type}
        query={query}
        position={position}
        onSelect={handleSelect}
        onClose={onClose}
        onSelectDatePage={type === 'link' ? handleSelectDatePage : undefined}
      />
    );
  }

  // For slash commands, render SlashCommandMenu
  return (
    <SlashCommandMenu
      query={query}
      position={position}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}
