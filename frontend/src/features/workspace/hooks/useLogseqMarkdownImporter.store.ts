/**
 * useLogseqMarkdownImporter.store — Logseq Markdown-folder import engine that
 * accepts either the legacy synchronous WorkspaceStore or the async worker
 * client.
 *
 * Keeping the dual-acceptance signature here lets the production hook file
 * remain free of direct `WorkspaceStore` imports while preserving compatibility
 * with legacy/test callers that still hold a synchronous store.
 */

import type { Asset } from '@/features/assets/api/assets';
import { SYSTEM_CLASS_UUIDS } from '@/constants/systemProperties';
import { uuidv7 } from '@/core/uuid';
import type { WorkspaceStore } from '@/core/store';
import type { IWorkspaceStoreClient } from '@/core/worker/workerProtocol';
import {
  paragraph,
  text,
  nodeLink,
  buildLinkId,
  convertMarkdownInAST,
  type ASTDocument,
  type ASTInlineNode,
} from '@/lib/astBuilder';
import type { ASTParagraph } from '@/types/ast';
import {
  parseLogseqFolder,
  countMdBlocks,
  extractAssetFilename,
  type LogseqFolderResult,
  type LogseqMdBlock,
  type LogseqMdPage,
} from '@/plugins/builtin/logseq_importer/utils/logseqMdParser';
import {
  type ImportProgress,
  type LogseqImportReport,
  type LogseqImportOptions,
} from './useLogseqMarkdownImporter';

const ASSET_INLINE_RE = /!\[[^\]]*\]\(\.\.\/assets\/([^)]+)\)/g;

function normalizePageTitle(title: string): string {
  return title.trim().toLowerCase();
}

function countBlocks(pages: LogseqMdPage[]): number {
  return pages.reduce((sum, p) => sum + countMdBlocks(p.blocks), 0);
}

function collectAssetReferences(pages: LogseqMdPage[]): Set<string> {
  const refs = new Set<string>();
  function scanBlock(block: LogseqMdBlock) {
    const pure = extractAssetFilename(block.content);
    if (pure) {
      refs.add(pure);
    }
    let m: RegExpExecArray | null;
    ASSET_INLINE_RE.lastIndex = 0;
    while ((m = ASSET_INLINE_RE.exec(block.content)) !== null) {
      refs.add(m[1]);
    }
    for (const child of block.children) scanBlock(child);
  }
  for (const page of pages) {
    for (const block of page.blocks) scanBlock(block);
  }
  return refs;
}

function countLinks(ast: ASTDocument): number {
  let n = 0;
  function walk(nodes: ASTInlineNode[]) {
    for (const node of nodes) {
      if (node.type === 'node_link') {
        n++;
      } else if ('children' in node && Array.isArray((node as { children: ASTInlineNode[] }).children)) {
        walk((node as { children: ASTInlineNode[] }).children);
      }
    }
  }
  for (const block of ast) {
    if ('children' in block && Array.isArray((block as ASTParagraph).children)) {
      walk((block as ASTParagraph).children);
    }
  }
  return n;
}

function parseInlineContent(
  content: string,
  pageMap: Map<string, string>,
  assetMap: Map<string, Asset>,
): ASTInlineNode[] {
  const nodes: ASTInlineNode[] = [];
  const re = /(\[\[([^\]]+)\]\])|(!\[[^\]]*\]\(\.\.\/assets\/([^)]+)\))/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > pos) {
      nodes.push(text(content.slice(pos, m.index)));
    }
    if (m[2]) {
      const title = m[2];
      const targetId = pageMap.get(normalizePageTitle(title));
      if (targetId) {
        nodes.push(nodeLink(buildLinkId(targetId, uuidv7()), 'node'));
      } else {
        nodes.push(text(m[0]));
      }
    } else if (m[4]) {
      const filename = m[4];
      const asset = assetMap.get(filename);
      if (asset) {
        nodes.push(nodeLink(buildLinkId(asset.node_uuid, uuidv7()), 'node'));
      } else {
        nodes.push(text(m[0]));
      }
    }
    pos = m.index + m[0].length;
  }
  if (pos < content.length) {
    nodes.push(text(content.slice(pos)));
  }
  return nodes;
}

function blockContentToAst(
  content: string,
  pageMap: Map<string, string>,
  assetMap: Map<string, Asset>,
): ASTDocument {
  const pureAsset = extractAssetFilename(content);
  if (pureAsset) {
    const asset = assetMap.get(pureAsset);
    if (asset) {
      return [paragraph(nodeLink(buildLinkId(asset.node_uuid, uuidv7()), 'node'))];
    }
  }

  const lines = content.split('\n');
  const paragraphs: ASTParagraph[] = [];
  for (const line of lines) {
    const children = parseInlineContent(line, pageMap, assetMap);
    if (children.length === 0) continue;
    paragraphs.push(paragraph(...children));
  }

  const ast = paragraphs.length > 0 ? paragraphs : [paragraph(text(''))];
  return convertMarkdownInAST(ast);
}

async function defaultUploadAsset(file: File, parentUuid?: string): Promise<Asset> {
  const { uploadAsset } = await import('@/features/assets/api/assets');
  return uploadAsset(file, parentUuid);
}

interface StoreOperations {
  createNode: (args: {
    nodeId: string;
    kind: 'page' | 'block';
    parentId: string | null;
    classIds?: string[];
  }) => Promise<void>;
  updateContentAst: (nodeId: string, ast: ASTDocument) => Promise<void>;
  moveNode: (nodeId: string, parentId: string) => Promise<void>;
}

function isWorkspaceStore(storeOrClient: WorkspaceStore | IWorkspaceStoreClient): storeOrClient is WorkspaceStore {
  return !('mutate' in storeOrClient);
}

function createStoreOperations(storeOrClient: WorkspaceStore | IWorkspaceStoreClient): StoreOperations {
  if (isWorkspaceStore(storeOrClient)) {
    return {
      createNode: async (args) => storeOrClient.createNode(args),
      updateContentAst: async (nodeId, ast) => storeOrClient.updateContentAst(nodeId, ast),
      moveNode: async (nodeId, parentId) => storeOrClient.moveNode(nodeId, parentId),
    };
  }
  return {
    createNode: (args) => storeOrClient.mutate<void>('createNode', [args]),
    updateContentAst: (nodeId, ast) => storeOrClient.mutate<void>('updateContentAst', [nodeId, ast]),
    moveNode: (nodeId, parentId) => storeOrClient.mutate<void>('moveNode', [nodeId, parentId]),
  };
}

/**
 * Pure importer entry point. Creates pages/blocks in the provided WorkspaceStore
 * or async worker client.
 */
export async function importLogseqFolderToStore(
  storeOrClient: WorkspaceStore | IWorkspaceStoreClient,
  files: FileList,
  options: LogseqImportOptions = {},
): Promise<LogseqImportReport> {
  const ops = createStoreOperations(storeOrClient);
  const { onProgress, uploadAsset: doUpload = defaultUploadAsset } = options;
  const report: LogseqImportReport = {
    pagesCreated: 0,
    blocksCreated: 0,
    assetsUploaded: 0,
    linksCreated: 0,
    errors: [],
  };

  const notify = (progress: ImportProgress) => onProgress?.(progress);

  notify({ phase: 'parsing', current: 0, total: 1, message: 'Parsing Logseq folder...' });
  let parsed: LogseqFolderResult;
  try {
    parsed = await parseLogseqFolder(files);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`Failed to parse folder: ${msg}`);
    throw new Error(`Failed to parse folder: ${msg}`);
  }
  const allPages = [...parsed.pages, ...parsed.journals];
  notify({
    phase: 'parsing',
    current: 1,
    total: 1,
    message: `Parsed ${allPages.length} page${allPages.length !== 1 ? 's' : ''}.`,
  });

  // Build a normalized title -> UUID map for explicit pages first, then wiki-link stubs.
  const pageMap = new Map<string, string>();
  const pageTitles = new Map<string, string>(); // UUID -> original title

  for (const page of allPages) {
    const key = normalizePageTitle(page.title);
    if (!pageMap.has(key)) {
      const pageId = uuidv7();
      pageMap.set(key, pageId);
      pageTitles.set(pageId, page.title);
    }
  }

  for (const title of parsed.allLinks) {
    const key = normalizePageTitle(title);
    if (!pageMap.has(key)) {
      const pageId = uuidv7();
      pageMap.set(key, pageId);
      pageTitles.set(pageId, title);
    }
  }

  // Upload referenced assets.
  const assetRefs = collectAssetReferences(allPages);
  const assetMap = new Map<string, Asset>();
  const totalAssets = assetRefs.size;
  notify({ phase: 'uploading-assets', current: 0, total: totalAssets, message: 'Uploading assets...' });
  let uploadedAssets = 0;
  for (const filename of assetRefs) {
    const file = parsed.assetFiles.get(filename);
    if (!file) {
      report.errors.push(`Asset file not found: ${filename}`);
      continue;
    }
    try {
      const asset = await doUpload(file);
      assetMap.set(filename, asset);
      report.assetsUploaded++;
      uploadedAssets++;
      notify({
        phase: 'uploading-assets',
        current: uploadedAssets,
        total: totalAssets,
        message: `Uploaded ${filename}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`Failed to upload asset ${filename}: ${msg}`);
    }
  }

  // Create all pages.
  const totalPages = pageTitles.size;
  notify({ phase: 'creating-pages', current: 0, total: totalPages, message: 'Creating pages...' });
  let createdPages = 0;
  for (const [pageId, title] of pageTitles) {
    try {
      await ops.createNode({
        nodeId: pageId,
        kind: 'page',
        parentId: null,
        classIds: [SYSTEM_CLASS_UUIDS.page],
      });
      await ops.updateContentAst(pageId, [paragraph(text(title))]);
      report.pagesCreated++;
      createdPages++;
      notify({
        phase: 'creating-pages',
        current: createdPages,
        total: totalPages,
        message: `Created page: ${title}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(`Failed to create page "${title}": ${msg}`);
    }
  }

  // Create blocks recursively. Blocks are created with no parent and then moved
  // so the tree CRDT records insertion order.
  const totalBlocks = countBlocks(allPages);
  notify({ phase: 'creating-blocks', current: 0, total: totalBlocks, message: 'Creating blocks...' });
  let createdBlocks = 0;

  const createBlocksRecursively = async (blocks: LogseqMdBlock[], parentId: string) => {
    for (const block of blocks) {
      const blockId = uuidv7();
      try {
        await ops.createNode({ nodeId: blockId, kind: 'block', parentId: null });
        const ast = blockContentToAst(block.content, pageMap, assetMap);
        await ops.updateContentAst(blockId, ast);
        await ops.moveNode(blockId, parentId);
        report.blocksCreated++;
        report.linksCreated += countLinks(ast);
        createdBlocks++;
        notify({
          phase: 'creating-blocks',
          current: createdBlocks,
          total: totalBlocks,
          message: `Created block ${createdBlocks}/${totalBlocks}`,
        });
        if (block.children.length > 0) {
          await createBlocksRecursively(block.children, blockId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report.errors.push(`Failed to create block: ${msg}`);
      }
    }
  };

  for (const page of allPages) {
    const pageId = pageMap.get(normalizePageTitle(page.title));
    if (!pageId) continue;
    await createBlocksRecursively(page.blocks, pageId);
  }

  notify({
    phase: 'done',
    current: totalBlocks,
    total: totalBlocks,
    message: `Import complete: ${report.pagesCreated} pages, ${report.blocksCreated} blocks, ${report.assetsUploaded} assets.`,
  });

  return report;
}
