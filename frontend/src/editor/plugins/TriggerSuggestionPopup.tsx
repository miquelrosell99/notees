/**
 * TriggerSuggestionPopup — Wrapper around SuggestionPopup for editor triggers.
 *
 * Provides onCreate for creating new pages, classes, or tags
 * directly from the + / @ / # trigger menus.
 */

import { useCallback, useMemo, type JSX } from 'react';
import type { TriggerType } from './TriggerPlugin';
import { SuggestionPopup, type SuggestionType } from '../../components/nodes/SuggestionPopup';
import type { Node } from '../../types/api';
import { useCreateNode } from '../../hooks/useNodes';
import { usePageClass, useClassClass } from '../../hooks/usePageClass';
import { useClasses } from '../../hooks';
import { nodeNameToText } from '../../hooks/useStringifyAST';

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
  /** True when the user is actively typing a @class query inside the link trigger */
  isTypingClass?: boolean;
  /** The text typed after @ for class filtering */
  classQuery?: string;
  /** Called when a class is selected from the class sub-picker */
  onClassSelect?: (node: Node) => void;
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
  isTypingClass = false,
  classQuery = '',
  onClassSelect,
}: TriggerSuggestionPopupProps): JSX.Element {
  const createNode = useCreateNode();
  const { pageClassId } = usePageClass();
  const { classClassId } = useClassClass();
  const { data: allClasses = [] } = useClasses();

  // Resolve class names for active class filters to show in header
  const activeClassNames = useMemo(() => {
    if (!classFilters || classFilters.length === 0) return '';
    return classFilters
      .map(id => allClasses.find(c => c.id === id))
      .filter(Boolean)
      .map(c => nodeNameToText(c!.name))
      .filter(Boolean)
      .join(', ');
  }, [classFilters, allClasses]);

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

  // When typing @class inside link trigger: show class picker instead of link picker
  const handleClassCreate = useCallback((name: string) => {
    if (!pageClassId || !classClassId) return;
    createNode.mutate({ name, classes: [pageClassId, classClassId] }, {
      onSuccess: (newNode) => onClassSelect?.(newNode),
    });
  }, [createNode, pageClassId, classClassId, onClassSelect]);

  if (isTypingClass && onClassSelect) {
    return (
      <SuggestionPopup
        isOpen={true}
        query={classQuery}
        type="class"
        position={position}
        onSelect={(classNode) => onClassSelect(classNode)}
        onClose={onClose}
        onCreate={handleClassCreate}
        headerText="Filter by class"
      />
    );
  }

  // Build header for link mode: show active class filters if any
  const resolvedHeaderText = headerText ?? (activeClassNames ? `Insert link · ${activeClassNames}` : undefined);

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
      headerText={resolvedHeaderText}
      footerHintText={footerHintText}
    />
  );
}
