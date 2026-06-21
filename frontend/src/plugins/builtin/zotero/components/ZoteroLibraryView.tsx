/**
 * Zotero library view placeholder.
 */

import { PageViewHeader } from '@/features/content';

export function ZoteroLibraryView() {
  return (
    <article className="node-view node-view--page">
      <PageViewHeader title={<h1>Zotero Library</h1>} />
      <div className="main-content__empty">
        <p>Zotero integration is installed. Sync is available from the command palette.</p>
      </div>
    </article>
  );
}
