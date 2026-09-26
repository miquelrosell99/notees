/**
 * PageView — a page: header with the derived display name and the recursive
 * block tree of its children. Reads from a WorkspaceClient and re-renders on
 * its (naive) notifications.
 */

import { useEffect, useState } from "react";

import { deriveDisplayName } from "@notees/domain";

import type { WorkspaceClient } from "@/core/workspace-client.js";

import { BlockRow } from "./BlockRow.js";

export function PageView({ client, pageId }: { client: WorkspaceClient; pageId: string }) {
  const [, setVersion] = useState(0);
  useEffect(() => client.subscribe(() => setVersion((v) => v + 1)), [client]);

  const page = client.getPage(pageId);
  if (!page) {
    return <div className="nt-page-missing">Page not found.</div>;
  }
  const title = deriveDisplayName(page) || page.id;
  const tree = client.getBlockTree(pageId);

  return (
    <div className="nt-page">
      <header className="nt-page-header">
        <h1 className="nt-page-title">{title}</h1>
      </header>
      <div className="nt-block-tree">
        {tree.map((child) => (
          <BlockRow key={child.node.id} tree={child} resolveName={(id) => client.getDisplayName(id)} />
        ))}
      </div>
    </div>
  );
}
