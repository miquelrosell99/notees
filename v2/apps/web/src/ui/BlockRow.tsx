/**
 * BlockRow — one block: bullet dot + inline token content + nested children
 * (recursive, indented). Pure renderer over a BlockTreeNode; data comes from
 * the WorkspaceClient read API.
 */

import type { BlockTreeNode } from "@/core/workspace-client.js";

import { InlineTokens } from "./InlineTokens.js";

interface BlockRowProps {
  tree: BlockTreeNode;
  resolveName?: ((nodeId: string) => string | null) | undefined;
}

export function BlockRow({ tree, resolveName }: BlockRowProps) {
  const { node, children } = tree;
  return (
    <div className="nt-block">
      <div className="nt-block-row">
        <span className="nt-bullet" aria-hidden="true">
          •
        </span>
        <div className="nt-block-content">
          <InlineTokens tokens={node.contentAst} resolveName={resolveName} />
        </div>
      </div>
      {children.length > 0 && (
        <div className="nt-block-children">
          {children.map((child) => (
            <BlockRow key={child.node.id} tree={child} resolveName={resolveName} />
          ))}
        </div>
      )}
    </div>
  );
}
