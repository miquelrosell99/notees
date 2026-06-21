/**
 * KOReader highlights view placeholder.
 */

import { PageViewHeader } from '@/features/content';

export function KOReaderHighlightsView() {
  return (
    <article className="node-view node-view--page">
      <PageViewHeader title={<h1>KOReader Highlights</h1>} />
      <div className="main-content__empty">
        <p>KOReader integration is installed. Sync is available from the command palette.</p>
      </div>
    </article>
  );
}
