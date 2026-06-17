import { text as astText, nodeLink, externalLink, paragraph, buildLinkId } from '@/lib/astBuilder';
import type { ASTInlineNode } from '@/lib/astBuilder';
import { generateUUID } from '@/utils/uuid';
import type { NodeInfo } from './useLogseqImporter.types';

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NODE_LINK_RE = new RegExp(
  `#\\[\\[(${UUID_RE})\\]\\]|\\[([^\\]]+)\\]\\(\\[\\[(${UUID_RE})\\]\\]\\)|\\[\\[(${UUID_RE})\\]\\]|\\(\\((${UUID_RE})\\)\\)|\\[\\[([^\\]]+)\\]\\]`,
  'gi'
);
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

function textSegmentToNodes(
  segment: string,
  uuidMap: Map<string, NodeInfo>,
): ASTInlineNode[] {
  if (!segment) return [];
  const nodes: ASTInlineNode[] = [];
  let last = 0;
  const regex = new RegExp(MD_LINK_RE.source, MD_LINK_RE.flags);
  for (const match of segment.matchAll(regex)) {
    const matchStart = match.index ?? 0;
    if (matchStart > last) nodes.push(astText(segment.slice(last, matchStart)));
    const label = match[1];
    const url = match[2];
    const noteesUuid = url.startsWith('notees:') ? url.slice('notees:'.length) : null;
    if (noteesUuid) {
      const target = uuidMap.get(noteesUuid);
      if (target) {
        const linkInstanceUuid = generateUUID();
        nodes.push(nodeLink(buildLinkId(target.uuid, linkInstanceUuid), 'node', label));
      } else {
        nodes.push(externalLink(url, astText(label)));
      }
    } else {
      nodes.push(externalLink(url, astText(label)));
    }
    last = matchStart + match[0].length;
  }
  if (last < segment.length) nodes.push(astText(segment.slice(last)));
  return nodes;
}

export function buildAstFromLogseqText(
  rawText: string,
  uuidMap: Map<string, NodeInfo>,
  titleToNodeInfo?: Map<string, NodeInfo>,
): Array<{ type: string; children: ASTInlineNode[] }> {
  if (!rawText) return [];
  const children: ASTInlineNode[] = [];
  let lastIndex = 0;

  for (const match of rawText.matchAll(NODE_LINK_RE)) {
    const inlineClassUuid = match[1];
    const labeledLink_label = match[2];
    const labeledLink_uuid = match[3];
    const bareUuid = match[4];
    const blockRefUuid = match[5];
    const linkName = match[6];
    const logseqUuid = labeledLink_uuid ?? bareUuid ?? blockRefUuid;
    const matchStart = match.index ?? 0;

    if (matchStart > lastIndex) {
      children.push(...textSegmentToNodes(rawText.slice(lastIndex, matchStart), uuidMap));
    }

    if (inlineClassUuid) {
      const target = uuidMap.get(inlineClassUuid);
      if (target) {
        const linkInstanceUuid = generateUUID();
        children.push(nodeLink(buildLinkId(target.uuid, linkInstanceUuid), 'class'));
      } else {
        children.push(astText(match[0]));
      }
    } else {
      let target: NodeInfo | undefined;
      if (logseqUuid) {
        target = uuidMap.get(logseqUuid);
      } else if (linkName && titleToNodeInfo) {
        target = titleToNodeInfo.get(linkName);
      }
      if (target) {
        const linkInstanceUuid = generateUUID();
        const linkId = buildLinkId(target.uuid, linkInstanceUuid);
        const label = labeledLink_label ?? null;
        children.push(nodeLink(linkId, 'node', label));
      } else if (linkName) {
        children.push(astText(linkName));
      } else {
        children.push(astText(match[0]));
      }
    }

    lastIndex = matchStart + match[0].length;
  }

  if (lastIndex < rawText.length) {
    children.push(...textSegmentToNodes(rawText.slice(lastIndex), uuidMap));
  }

  if (children.length === 0) return [];
  return [paragraph(...children)];
}
