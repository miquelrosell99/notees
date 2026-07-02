/**
 * Core types for the custom inline editor.
 *
 * The custom editor uses the same ContentAST as the rest of the app. Internally
 * it works with a flat "unit" representation that is easier to mutate than the
 * nested AST mark nodes.
 */

import type { ContentAST } from '@/runtime/types';
import type { ASTInlineNode } from '@/types/ast';

export type MarkType = 'strong' | 'em' | 'strikethrough' | 'underline' | 'highlight' | 'code';

export const MARK_ORDER: MarkType[] = ['strong', 'em', 'strikethrough', 'underline', 'highlight'];

export interface TextUnit {
  type: 'text';
  text: string;
  marks: MarkType[];
}

export interface AtomicUnit {
  type: 'atomic';
  node: ASTInlineNode;
}

export type InlineUnit = TextUnit | AtomicUnit;

export type InlineSelection =
  | { type: 'collapsed'; offset: number }
  | { type: 'range'; anchor: number; focus: number }
  | { type: 'node'; nodeIndex: number };

export interface InlineEditorState {
  readonly ast: ContentAST;
  readonly selection: InlineSelection;
}

export interface Position {
  /** Index of the unit the cursor is in, or units.length for the end boundary. */
  unitIndex: number;
  /** Offset inside a text unit. Always 0 for atomic/boundary positions. */
  innerOffset: number;
}
