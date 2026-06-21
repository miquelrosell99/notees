import type { PageInfo } from './useLogseqFolderImporter.types';
import type { LogseqMdBlock } from '../utils/logseqMdParser';
import { text as astText, nodeLink, paragraph, buildLinkId } from '@/lib/astBuilder';
import type { ASTInlineNode } from '@/lib/astBuilder';
import { generateUUID } from '@/utils/uuid';
import { batchCreateNodes } from '@/api/nodes';

export const BATCH_SIZE = 50;

export const BULK_HEADERS = { 'X-Bulk-Import': 'true' };

const LINK_OR_ASSET_RE = /\[([^\]]+)\]\(\[\[([^\]]+)\]\]\)|!\[[^\]]*\]\(\.\.\/assets\/([^)]+)\)(\{[^}]*\})?|\[\[([^\]]+)\]\]/g;

export function parseDateLink(link: string): string | null {
  const m = link.match(/^(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})$/);
  if (!m) return null;

  const [, a, b, c] = m;
  const candidates: [number, number, number][] = [];
  if (a.length === 4) candidates.push([+a, +b, +c]);
  if (c.length === 4) {
    candidates.push([+c, +b, +a]);
    candidates.push([+c, +a, +b]);
  }

  for (const [y, mo, d] of candidates) {
    if (y >= 1970 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return null;
}

export function registerDateVariants(isoDate: string, info: PageInfo, titleMap: Map<string, PageInfo>) {
  const [y, m, d] = isoDate.split('-');
  const variants = [
    `${y}/${m}/${d}`, `${y}-${m}-${d}`,
    `${d}/${m}/${y}`, `${d}-${m}-${y}`,
    `${m}/${d}/${y}`, `${m}-${d}-${y}`,
  ];
  for (const v of variants) {
    if (!titleMap.has(v)) titleMap.set(v, info);
  }
}

export function collectBlockAssetRefs(blocks: LogseqMdBlock[]): Set<string> {
  const refs = new Set<string>();
  const ASSET_RE = /!\[[^\]]*\]\(\.\.\/assets\/([^)]+)\)(\{[^}]*\})?/g;
  function walk(block: LogseqMdBlock) {
    for (const m of block.content.matchAll(ASSET_RE)) {
      refs.add(m[1]);
    }
    for (const child of block.children) walk(child);
  }
  for (const b of blocks) walk(b);
  return refs;
}

export function buildBlockAst(
  content: string,
  titleMap: Map<string, PageInfo>,
  assetMap: Map<string, PageInfo>,
): string {
  const children: ASTInlineNode[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(LINK_OR_ASSET_RE)) {
    const matchStart = match.index ?? 0;
    if (matchStart > lastIndex) {
      children.push(astText(content.slice(lastIndex, matchStart)));
    }

    if (match[1] !== undefined) {
      const label = match[1];
      const pageName = match[2];
      const target = titleMap.get(pageName) ?? titleMap.get(pageName.toLowerCase());
      if (target) {
        const linkUuid = generateUUID();
        children.push(nodeLink(buildLinkId(target.uuid, linkUuid), 'node', label));
      } else {
        children.push(astText(match[0]));
      }
    } else if (match[3] !== undefined) {
      const filename = match[3];
      const asset = assetMap.get(filename);
      if (asset) {
        const linkUuid = generateUUID();
        children.push(nodeLink(buildLinkId(asset.uuid, linkUuid), 'node'));
      } else {
        children.push(astText(match[0]));
      }
    } else if (match[5] !== undefined) {
      const pageName = match[5];
      const target = titleMap.get(pageName) ?? titleMap.get(pageName.toLowerCase());
      if (target) {
        const linkUuid = generateUUID();
        children.push(nodeLink(buildLinkId(target.uuid, linkUuid), 'node'));
      } else {
        children.push(astText(match[0]));
      }
    }

    lastIndex = matchStart + match[0].length;
  }

  if (lastIndex < content.length) {
    children.push(astText(content.slice(lastIndex)));
  }

  if (children.length === 0) return '';
  return JSON.stringify([paragraph(...children)]);
}

export function cleanBlockContent(content: string): string {
  return content
    .replace(/\n?\s*collapsed:: (true|false)/g, '')
    .replace(/\n?\s*id:: [0-9a-f-]+/g, '')
    .replace(/\n?\s*background-color:: \w+/g, '')
    .trim();
}

export async function createBlocksRecursively(
  blocks: LogseqMdBlock[],
  parentId: number,
  startSeq: number,
  titleMap: Map<string, PageInfo>,
  assetMap: Map<string, PageInfo>,
  onProgress: (count: number) => void,
): Promise<void> {
  if (blocks.length === 0) return;

  const createItems = blocks.map((block, i) => {
    const cleaned = cleanBlockContent(block.content);
    if (!cleaned) return { name: '', sequence: startSeq + i };
    const name = buildBlockAst(cleaned, titleMap, assetMap);
    return { name, parent_id: parentId, sequence: startSeq + i };
  });

  const resp = await batchCreateNodes({
    nodes: createItems,
    uuid_conflict_mode: 'return_existing',
  }, { headers: BULK_HEADERS });

  onProgress(blocks.length);

  for (let i = 0; i < resp.results.length; i++) {
    const item = resp.results[i];
    if (item.success && item.node && blocks[i].children.length > 0) {
      await createBlocksRecursively(
        blocks[i].children,
        item.node.id,
        0,
        titleMap,
        assetMap,
        onProgress,
      );
    }
  }
}
