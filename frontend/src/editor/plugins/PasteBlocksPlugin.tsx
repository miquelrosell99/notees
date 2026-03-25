/**
 * PasteBlocksPlugin — Intercepts multi-line paste events and creates
 * hierarchical blocks with resolved [[links]] and #hashtags.
 *
 * When the user pastes multi-line text (plain or HTML lists), this plugin:
 * 1. Parses the clipboard content into ParsedBlock[] with depth info
 * 2. For each block's content, resolves [[...]] patterns into AST node_link
 *    nodes (finding existing pages or creating new ones)
 * 3. Resolves #hashtag patterns into inline tags or inline classes based
 *    on the user's hashtagPasteMode setting
 * 4. Creates blocks via runtime create_block intents, preserving hierarchy
 *
 * Priority: COMMAND_PRIORITY_NORMAL — runs after PasteImagePlugin (HIGH)
 * but lets the default text paste handle single-line input.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  PASTE_COMMAND,
  COMMAND_PRIORITY_NORMAL,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $createTextNode,
  $createLineBreakNode,
} from 'lexical';
import { $isBlockNode, type BlockNode } from '../nodes/BlockNode';
import { $isInlineLinkNode } from '../nodes/InlineLinkNode';
import { findParentNodeBlock } from '../utils/selectionUtils';
import { getNodeGraphRuntime } from '../../runtime/NodeGraphRuntime';
import { analyzeClipboard, flattenBlocks } from '../../utils/clipboardManager';
import { searchNodes, createPage, getNodeByUuid } from '../../api/nodes';
import { buildLinkId, paragraph, text as astText, nodeLink } from '../../lib/astBuilder';
import { generateUUID } from '../../utils/uuid';
import type { ASTInlineNode, ASTDocument } from '../../types/ast';
import type { HashtagPasteMode } from '../../stores/settingsStore';
import { useSettingsStore } from '../../stores/settingsStore';

// ─── Types ────────────────────────────────────────────────────────

interface ResolvedNode {
  uuid: string;
  id: number;
}

// ─── Cache for resolved nodes (shared across paste operations) ────

const resolveCache = new Map<string, ResolvedNode>();

// ─── Helpers ──────────────────────────────────────────────────────

/** UUID v4 format check */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a link name to an existing node.
 * If the name is a UUID (e.g. from "Copy link"), fetches the node directly.
 * Otherwise, searches by name and creates a new page if not found.
 * Results are cached for the duration of a paste operation.
 */
async function resolveLink(name: string): Promise<ResolvedNode> {
  const cacheKey = name.toLowerCase().trim();
  if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey)!;

  if (UUID_RE.test(name.trim())) {
    const node = await getNodeByUuid(name.trim());
    const resolved: ResolvedNode = { uuid: node.uuid, id: node.id };
    resolveCache.set(cacheKey, resolved);
    return resolved;
  }

  return resolveOrCreatePage(name);
}

/**
 * Resolve a page name to an existing node or create a new page.
 * Results are cached for the duration of a paste operation.
 */
async function resolveOrCreatePage(name: string): Promise<ResolvedNode> {
  const cacheKey = name.toLowerCase().trim();

  if (resolveCache.has(cacheKey)) {
    return resolveCache.get(cacheKey)!;
  }

  // Search for existing pages matching the name
  const results = await searchNodes(name);

  // Find exact match (case-insensitive, comparing plain text names)
  let match = results.find(n => {
    const plainName = extractPlainText(n.name);
    return plainName.toLowerCase().trim() === cacheKey;
  });

  if (!match) {
    // Create a new page
    match = await createPage(name);
  }

  const resolved: ResolvedNode = { uuid: match.uuid, id: match.id };
  resolveCache.set(cacheKey, resolved);
  return resolved;
}

/**
 * Extract plain text from a node name (which may be AST JSON or plain string).
 */
function extractPlainText(name: string | undefined | null): string {
  if (!name) return '';
  try {
    const parsed = JSON.parse(name);
    if (Array.isArray(parsed)) {
      return parsed
        .flatMap((block: any) =>
          (block.children || []).map((child: any) => {
            if (child.type === 'text') return child.text || '';
            return '';
          })
        )
        .join('');
    }
  } catch {
    // Not JSON — return as-is
  }
  return name;
}

/**
 * Pattern matching for [[link references]] in text.
 * Also handles #hashtag patterns.
 */
const LINK_PATTERN = /\[\[([^\]]+)\]\]/g;
const HASHTAG_PATTERN = /(?:^|(?<=\s))#([^\s#\[\]]+)/g;

/**
 * Parse a block's text content and resolve [[links]] and #hashtags into AST.
 *
 * Returns an ASTDocument with text nodes, node_link nodes, etc.
 */
async function parseContentToAST(
  content: string,
  hashtagMode: HashtagPasteMode,
): Promise<ASTDocument> {
  if (!content.trim()) {
    return [paragraph(astText(''))];
  }

  // Collect all patterns and their positions for ordered processing
  interface Token {
    type: 'text' | 'link' | 'hashtag';
    value: string;
    start: number;
    end: number;
    /** The name to resolve (without brackets/hash) */
    name?: string;
  }

  const tokens: Token[] = [];

  // Find all [[links]]
  let match: RegExpExecArray | null;
  const linkRe = new RegExp(LINK_PATTERN.source, 'g');
  while ((match = linkRe.exec(content)) !== null) {
    tokens.push({
      type: 'link',
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
      name: match[1],
    });
  }

  // Find all #hashtags
  const hashRe = new RegExp(HASHTAG_PATTERN.source, 'g');
  while ((match = hashRe.exec(content)) !== null) {
    // Make sure this hashtag isn't inside a [[link]]
    const hashStart = match.index + match[0].indexOf('#');
    const isInsideLink = tokens.some(
      t => t.type === 'link' && hashStart >= t.start && hashStart < t.end,
    );
    if (!isInsideLink) {
      tokens.push({
        type: 'hashtag',
        value: match[0].trimStart(), // Remove leading whitespace captured by lookbehind
        start: hashStart,
        end: hashStart + 1 + match[1].length, // #name
        name: match[1],
      });
    }
  }

  // Sort tokens by position
  tokens.sort((a, b) => a.start - b.start);

  // If no special tokens, return plain text
  if (tokens.length === 0) {
    return [paragraph(astText(content))];
  }

  // Resolve all links and hashtags in parallel
  const resolvePromises = tokens
    .filter(t => t.type === 'link' || t.type === 'hashtag')
    .map(async t => {
      try {
        const resolved = t.type === 'link'
          ? await resolveLink(t.name!)
          : await resolveOrCreatePage(t.name!);
        return { token: t, resolved };
      } catch (err) {
        console.error(`[PasteBlocksPlugin] Failed to resolve "${t.name}":`, err);
        return { token: t, resolved: null };
      }
    });

  const resolveResults = await Promise.all(resolvePromises);
  const resolvedMap = new Map(
    resolveResults.map(r => [r.token, r.resolved]),
  );

  // Build the AST inline nodes
  const inlineNodes: ASTInlineNode[] = [];
  let pos = 0;

  for (const token of tokens) {
    // Add text before this token
    if (token.start > pos) {
      inlineNodes.push(astText(content.slice(pos, token.start)));
    }

    const resolved = resolvedMap.get(token);
    if (resolved) {
      const linkUuid = generateUUID();
      const linkId = buildLinkId(resolved.uuid, linkUuid);
      const refType = token.type === 'hashtag' && hashtagMode === 'inline-class'
        ? 'class' as const
        : 'node' as const;
      inlineNodes.push(nodeLink(linkId, refType));
    } else {
      // Fallback: keep original text
      inlineNodes.push(astText(token.value));
    }

    pos = token.end;
  }

  // Add trailing text
  if (pos < content.length) {
    inlineNodes.push(astText(content.slice(pos)));
  }

  return [paragraph(...inlineNodes)];
}

// ─── Plugin ───────────────────────────────────────────────────────

export interface PasteBlocksPluginProps {
  /** Called when pasting creates new block content that needs to be persisted */
  onContentChange?: (blockId: string, contentAST: ASTDocument) => void;
}

export function PasteBlocksPlugin({ onContentChange }: PasteBlocksPluginProps): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand<ClipboardEvent>(
      PASTE_COMMAND,
      (event) => {
        // We need to handle this async, but Lexical commands are sync.
        // Return true to prevent other handlers, then process async.
        const clipboardData = event.clipboardData;
        if (!clipboardData) return false;
        if (clipboardData.files.length > 0) return false;

        // ── Code block guard ────────────────────────────────────
        // If the cursor is inside a code-type block, paste the raw plain
        // text as-is (newlines become line-break nodes) rather than
        // splitting it into separate blocks.
        const sel = $getSelection();
        if ($isRangeSelection(sel)) {
          const blockNode = findParentNodeBlock(sel.anchor.getNode());
          if (blockNode && blockNode.getNodeType() === 'code') {
            const plain = clipboardData.getData('text/plain');
            if (plain) {
              event.preventDefault();
              editor.update(() => {
                const s = $getSelection();
                if (!$isRangeSelection(s)) return;
                const lines = plain.split('\n');
                const nodes: import('lexical').LexicalNode[] = [];
                for (let i = 0; i < lines.length; i++) {
                  if (i > 0) nodes.push($createLineBreakNode());
                  nodes.push($createTextNode(lines[i]));
                }
                s.insertNodes(nodes);
              });
              return true;
            }
          }
        }

        const analysis = analyzeClipboard(clipboardData);

        // ── Single-line [[link]] paste ───────────────────────────
        // Intercept plain-text pastes containing [[...]] patterns so they
        // resolve to inline link pills instead of being pasted as raw text.
        // This handles "Copy link" which writes [[uuid]] to the clipboard.
        if (
          analysis.type !== 'plain-multiline' &&
          analysis.type !== 'html-list' &&
          analysis.type !== 'html-text'
        ) {
          const plain = clipboardData.getData('text/plain');
          if (plain && /\[\[/.test(plain)) {
            // Capture block state synchronously inside the command handler,
            // before any await that would lose the editor's synchronous context.
            let pasteBlockId: string | null = null;
            let pasteCursorOffset = 0;
            const captureSel = $getSelection();
            if ($isRangeSelection(captureSel)) {
              const blockNode = findParentNodeBlock(captureSel.anchor.getNode());
              if (blockNode) {
                pasteBlockId = blockNode.getBlockId();
                // Calculate cursor offset (mirrors BlockPlugin logic)
                for (const child of blockNode.getChildren()) {
                  if (child === captureSel.anchor.getNode() || child.getKey() === captureSel.anchor.key) break;
                  if ($isTextNode(child)) {
                    const t = child.getTextContent();
                    if (t !== '\u200B') pasteCursorOffset += t.length;
                  } else if ($isInlineLinkNode(child)) {
                    pasteCursorOffset += 1;
                  }
                }
                // Add offset within the anchor text node
                const anchorNode = captureSel.anchor.getNode();
                if ($isTextNode(anchorNode)) {
                  pasteCursorOffset += captureSel.anchor.offset;
                }
              }
            }
            if (!pasteBlockId) return false;
            event.preventDefault();
            processSingleLineLinkPasteAsync(pasteBlockId, pasteCursorOffset, plain, onContentChange).catch(err => {
              console.error('[PasteBlocksPlugin] Single-line link paste error:', err);
            });
            return true;
          }
          return false;
        }

        // Only intercept multi-block pastes
        if (!analysis.blocks || analysis.blocks.length <= 1) {
          return false;
        }

        // Prevent default and process asynchronously
        event.preventDefault();

        // Process the paste async
        processPasteAsync(editor, analysis, onContentChange).catch(err => {
          console.error('[PasteBlocksPlugin] Async paste error:', err);
        });

        return true;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor, onContentChange]);

  return null;
}

// ─── Async paste processing ───────────────────────────────────────

async function processPasteAsync(
  editor: import('lexical').LexicalEditor,
  analysis: ReturnType<typeof analyzeClipboard>,
  onContentChange?: (blockId: string, contentAST: ASTDocument) => void,
): Promise<void> {
  // Find the current block
  let currentBlockId: string | null = null;
  let currentBlockParentId: string | null = null;

  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;

    const anchorNode = selection.anchor.getNode();
    let current: import('lexical').LexicalNode | null = anchorNode;
    while (current && !$isBlockNode(current)) {
      current = current.getParent();
    }
    if (current && $isBlockNode(current)) {
      currentBlockId = (current as BlockNode).getBlockId();
    }
  });

  if (!currentBlockId) return;

  const runtime = getNodeGraphRuntime();
  const currentGraphNode = runtime.getNode(currentBlockId);
  if (!currentGraphNode) return;

  currentBlockParentId = currentGraphNode.parentId;
  if (!currentBlockParentId) return;

  // Flatten blocks
  const flatBlocks = flattenBlocks(analysis.blocks!);

  // Get settings
  const hashtagMode = useSettingsStore.getState().hashtagPasteMode;

  // Clear resolve cache
  resolveCache.clear();

  // Parse all block contents into AST
  const astResults = await Promise.all(
    flatBlocks.map(block => parseContentToAST(block.content, hashtagMode)),
  );

  // Check if current block is empty
  const currentContentAST = currentGraphNode.contentAST;
  const isCurrentEmpty = !currentContentAST ||
    currentContentAST.length === 0 ||
    (currentContentAST.length === 1 &&
      currentContentAST[0].type === 'paragraph' &&
      currentContentAST[0].children?.length <= 1 &&
      (!currentContentAST[0].children?.[0] ||
        (currentContentAST[0].children[0].type === 'text' &&
          !currentContentAST[0].children[0].text?.trim())));

  const blockIds: string[] = [];
  let startIndex = 0;
  let afterBlockId: string | null = currentBlockId;
  const depthParentMap = new Map<number, string>();

  if (isCurrentEmpty && flatBlocks.length > 0) {
    // Replace current empty block content
    runtime.applyIntent({
      type: 'update_content',
      blockId: currentBlockId!,
      contentAST: astResults[0],
    });
    onContentChange?.(currentBlockId!, astResults[0]);

    depthParentMap.set(0, currentBlockId!);
    afterBlockId = currentBlockId;
    startIndex = 1;
  }

  // Create blocks
  for (let i = startIndex; i < flatBlocks.length; i++) {
    const block = flatBlocks[i];
    const contentAST = astResults[i];
    const depth = block.depth;

    // Determine parent
    let parentId: string;
    if (depth === 0) {
      parentId = currentBlockParentId!;
    } else {
      parentId = currentBlockParentId!; // default
      for (let d = depth - 1; d >= 0; d--) {
        if (depthParentMap.has(d)) {
          parentId = depthParentMap.get(d)!;
          break;
        }
      }
    }

    // Determine after which sibling to insert
    let after: string | null;
    if (depth === 0) {
      after = afterBlockId;
    } else {
      after = null;
      // Find last block at same depth with same parent
      for (let j = i - 1; j >= startIndex; j--) {
        if (flatBlocks[j].depth === depth) {
          after = blockIds[j - startIndex];
          break;
        } else if (flatBlocks[j].depth < depth) {
          break;
        }
      }
    }

    const newBlockId = generateUUID();
    blockIds.push(newBlockId);

    runtime.applyIntent({
      type: 'create_block',
      parentId,
      afterBlockId: after,
      blockId: newBlockId,
      contentAST,
    });

    // Update depth tracking
    depthParentMap.set(depth, newBlockId);
    for (const [d] of depthParentMap) {
      if (d > depth) depthParentMap.delete(d);
    }

    if (depth === 0) {
      afterBlockId = newBlockId;
    }
  }

  // Flush to render
  runtime.flushEvents();

  // Focus last block
  if (blockIds.length > 0) {
    runtime.requestFocus(blockIds[blockIds.length - 1]);
    runtime.flushEvents();
  }
}

// ─── Single-line [[link]] paste ───────────────────────────────────

/**
 * Handle a single-line paste that contains [[...]] link patterns.
 *
 * Rather than inserting Lexical nodes directly (which breaks after async awaits
 * due to node-registry mismatches), this builds a merged ContentAST and writes
 * it via update_content + onContentChange so BlockPlugin's sync loop does the
 * Lexical tree update safely inside its own editor context.
 */
async function processSingleLineLinkPasteAsync(
  currentBlockId: string,
  cursorOffset: number,
  pastedText: string,
  onContentChange?: (blockId: string, contentAST: ASTDocument) => void,
): Promise<void> {
  interface Token {
    start: number;
    end: number;
    value: string;
    name: string;
  }

  const tokens: Token[] = [];
  const linkRe = new RegExp(LINK_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(pastedText)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length, value: m[0], name: m[1] });
  }
  if (tokens.length === 0) return;

  resolveCache.clear();

  // Resolve all links in parallel
  const resolved = await Promise.all(
    tokens.map(async t => {
      try { return await resolveLink(t.name); }
      catch { return null; }
    }),
  );

  // Build pasted inline nodes from the resolved text/links
  const pastedInlines: ASTInlineNode[] = [];
  let pos = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.start > pos) pastedInlines.push(astText(pastedText.slice(pos, token.start)));
    const r = resolved[i];
    if (r) {
      pastedInlines.push(nodeLink(buildLinkId(r.uuid, generateUUID()), 'node'));
    } else {
      pastedInlines.push(astText(token.value));
    }
    pos = token.end;
  }
  if (pos < pastedText.length) pastedInlines.push(astText(pastedText.slice(pos)));

  // Merge into the current block's contentAST at the cursor position
  const runtime = getNodeGraphRuntime();
  const graphNode = runtime.getNode(currentBlockId);
  if (!graphNode) return;

  const existing = graphNode.contentAST ?? [paragraph(astText(''))];
  // Flatten all inlines from the existing block (single-paragraph assumed for editable blocks)
  const existingInlines: ASTInlineNode[] = existing.flatMap(p => ('children' in p ? p.children : []));

  // Split existing inlines at the cursor offset
  let remaining = cursorOffset;
  let splitIdx = existingInlines.length; // default: paste at end
  let splitTextOffset = 0;
  for (let i = 0; i < existingInlines.length; i++) {
    const node = existingInlines[i];
    const len = node.type === 'text' ? node.text.length
      : node.type === 'node_link' || node.type === 'external_link' ? 1
      : 0;
    if (remaining <= len) {
      splitIdx = i;
      splitTextOffset = remaining;
      break;
    }
    remaining -= len;
  }

  // Build before/after arrays
  const before: ASTInlineNode[] = [];
  const after: ASTInlineNode[] = [];
  for (let i = 0; i < existingInlines.length; i++) {
    if (i < splitIdx) {
      before.push(existingInlines[i]);
    } else if (i === splitIdx && splitTextOffset > 0 && existingInlines[i].type === 'text') {
      const t = existingInlines[i] as { type: 'text'; text: string };
      before.push(astText(t.text.slice(0, splitTextOffset)));
      after.push(astText(t.text.slice(splitTextOffset)));
    } else {
      after.push(existingInlines[i]);
    }
  }

  const mergedInlines = [...before, ...pastedInlines, ...after];
  const newContentAST: ASTDocument = [paragraph(...mergedInlines)];

  runtime.applyIntent({ type: 'update_content', blockId: currentBlockId, contentAST: newContentAST });
  onContentChange?.(currentBlockId, newContentAST);

  // Ask the runtime to move the cursor after the inserted content
  const newCursorOffset = cursorOffset + pastedInlines.reduce((acc, n) =>
    acc + (n.type === 'text' ? n.text.length : 1), 0);
  runtime.requestFocus(currentBlockId, newCursorOffset);
  runtime.flushEvents();
}
