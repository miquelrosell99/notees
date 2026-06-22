/**
 * InlineDateRangeNode — Lexical DecoratorNode for rendering inline date ranges.
 */

import {
  DecoratorNode,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type DOMExportOutput,
  type LexicalEditor,
  type EditorConfig,
  $applyNodeReplacement,
  $getNodeByKey,
  type DOMConversionMap,
} from 'lexical';
import { createElement, type JSX } from 'react';
import { InlineDateRange } from '@/features/editor/editor/components/InlineDateRange';
import type { DateRangeValue } from '@/utils/dateRange';

export interface SerializedInlineDateRangeNode extends SerializedLexicalNode {
  type: 'inline-date-range';
  version: 1;
  start: string;
  end: string;
  granularity: 'day' | 'month' | 'year';
  start_uuid: string;
  end_uuid: string;
  label?: string;
}

export class InlineDateRangeNode extends DecoratorNode<JSX.Element> {
  __start: string;
  __end: string;
  __granularity: 'day' | 'month' | 'year';
  __start_uuid: string;
  __end_uuid: string;
  __label: string;

  static getType(): string {
    return 'inline-date-range';
  }

  static clone(node: InlineDateRangeNode): InlineDateRangeNode {
    return new InlineDateRangeNode(
      node.__start,
      node.__end,
      node.__granularity,
      node.__start_uuid,
      node.__end_uuid,
      node.__key,
      node.__label,
    );
  }

  constructor(
    start: string,
    end: string,
    granularity: 'day' | 'month' | 'year',
    start_uuid: string,
    end_uuid: string,
    key?: NodeKey,
    label = '',
  ) {
    super(key);
    this.__start = start;
    this.__end = end;
    this.__granularity = granularity;
    this.__start_uuid = start_uuid;
    this.__end_uuid = end_uuid;
    this.__label = label;
  }

  getStart(): string { return this.__start; }
  getEnd(): string { return this.__end; }
  getGranularity(): 'day' | 'month' | 'year' { return this.__granularity; }
  getStartUuid(): string { return this.__start_uuid; }
  getEndUuid(): string { return this.__end_uuid; }
  getLabel(): string { return this.__label; }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.classList.add('inline-date-range-wrapper');
    span.dataset.start = this.__start;
    span.dataset.end = this.__end;
    span.dataset.granularity = this.__granularity;
    span.dataset.startUuid = this.__start_uuid;
    span.dataset.endUuid = this.__end_uuid;
    if (this.__label) span.dataset.label = this.__label;
    span.contentEditable = 'false';
    span.setAttribute('tabindex', '-1');
    return span;
  }

  updateDOM(prevNode: InlineDateRangeNode, dom: HTMLElement): boolean {
    if (prevNode.__start !== this.__start) dom.dataset.start = this.__start;
    if (prevNode.__end !== this.__end) dom.dataset.end = this.__end;
    if (prevNode.__granularity !== this.__granularity) dom.dataset.granularity = this.__granularity;
    if (prevNode.__start_uuid !== this.__start_uuid) dom.dataset.startUuid = this.__start_uuid;
    if (prevNode.__end_uuid !== this.__end_uuid) dom.dataset.endUuid = this.__end_uuid;
    if (prevNode.__label !== this.__label) {
      if (this.__label) dom.dataset.label = this.__label;
      else delete dom.dataset.label;
    }
    return false;
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const span = document.createElement('span');
    span.classList.add('inline-date-range');
    span.textContent = this.__label || `${this.__start} – ${this.__end}`;
    return { element: span };
  }

  static importDOM(): DOMConversionMap | null {
    return null;
  }

  exportJSON(): SerializedInlineDateRangeNode {
    const json: SerializedInlineDateRangeNode = {
      type: 'inline-date-range',
      version: 1,
      start: this.__start,
      end: this.__end,
      granularity: this.__granularity,
      start_uuid: this.__start_uuid,
      end_uuid: this.__end_uuid,
    };
    if (this.__label) json.label = this.__label;
    return json;
  }

  static importJSON(json: SerializedInlineDateRangeNode): InlineDateRangeNode {
    return $createInlineDateRangeNode(
      json.start,
      json.end,
      json.granularity,
      json.start_uuid,
      json.end_uuid,
      json.label,
    );
  }

  isInline(): boolean {
    return true;
  }

  isIsolated(): boolean {
    return false;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  decorate(editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return createElement(InlineDateRange, {
      start: this.__start,
      end: this.__end,
      granularity: this.__granularity,
      startUuid: this.__start_uuid,
      endUuid: this.__end_uuid,
      label: this.__label || undefined,
      onChange: (value: DateRangeValue) => {
        editor.update(() => {
          const node = $getNodeByKey(this.__key);
          if (!$isInlineDateRangeNode(node)) return;
          const replacement = $createInlineDateRangeNode(
            value.start,
            value.end,
            value.granularity,
            value.start_uuid,
            value.end_uuid,
          );
          node.replace(replacement);
          replacement.selectStart();
        });
      },
    });
  }
}

export function $createInlineDateRangeNode(
  start: string,
  end: string,
  granularity: 'day' | 'month' | 'year',
  start_uuid: string,
  end_uuid: string,
  label?: string,
): InlineDateRangeNode {
  return $applyNodeReplacement(
    new InlineDateRangeNode(start, end, granularity, start_uuid, end_uuid, undefined, label),
  );
}

export function $isInlineDateRangeNode(
  node: LexicalNode | null | undefined,
): node is InlineDateRangeNode {
  return node instanceof InlineDateRangeNode;
}
