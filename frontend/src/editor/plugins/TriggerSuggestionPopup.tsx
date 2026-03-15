/**
 * TriggerSuggestionPopup — Wrapper around SuggestionPopup for editor triggers.
 *
 * Provides onCreate for creating new pages, classes, or tags
 * directly from the + / @ / # trigger menus.
 */

import { useCallback, type JSX } from 'react';
import type { TriggerType } from './TriggerPlugin';
import { SuggestionPopup, type SuggestionType } from '../../components/nodes/SuggestionPopup';
import type { Node } from '../../types/api';
import { useCreateNode } from '../../hooks/useNodes';
import { usePageClass, useClassClass } from '../../hooks/usePageClass';

export interface TriggerSuggestionPopupProps {
  suggestionType: SuggestionType;
  triggerType: TriggerType;
  query: string;
  position: { top: number; left: number };
  onSelect: (node: Node, addInline: boolean) => void;
  onClose: () => void;
  onSelectDatePage?: (pageId: string, pageName: string) => void;
  onSelectEmbed?: (node: Node) => void;
  /** Class IDs to restrict results to (passed through to SuggestionPopup) */
  classFilters?: number[];
  /** Header text override */
  headerText?: string;
  /** Footer hint text override */
  footerHintText?: string;
  /** Hide the "create new" option */
  hideCreate?: boolean;
}

export function TriggerSuggestionPopup({
  suggestionType,
  triggerType,
  query,
  position,
  onSelect,
  onClose,
  onSelectDatePage,
  onSelectEmbed,
  classFilters,
  headerText,
  footerHintText,
  hideCreate,
}: TriggerSuggestionPopupProps): JSX.Element {
  const createNode = useCreateNode();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();

  const handleCreate = useCallback((name: string, addInline: boolean) => {
    if (!pageClassId) return;

    // Determine classes based on trigger type
    const classes: number[] = [pageClassId];
    if (triggerType === 'type' && classClassId) {
      classes.push(classClassId);
    }

    createNode.mutate({ name, classes }, {
      onSuccess: (newNode) => {
        onSelect(newNode, addInline);
      },
    });
  }, [createNode, pageClassId, classClassId, triggerType, onSelect]);

  return (
    <SuggestionPopup
      isOpen={true}
      query={query}
      type={suggestionType}
      position={position}
      onSelect={onSelect}
      onClose={onClose}
      onCreate={hideCreate ? undefined : handleCreate}
      onSelectDatePage={onSelectDatePage}
      onSelectEmbed={onSelectEmbed}
      showInlineOption={suggestionType === 'class'}
      classFilters={classFilters}
      headerText={headerText}
      footerHintText={footerHintText}
    />
  );
}
