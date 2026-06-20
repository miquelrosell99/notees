import { PageViewHeader } from '@/features/content';
import { FlashcardStats } from '../components/FlashcardStats';
import { FlashcardStudyView } from '../components/FlashcardStudyView';
import './FlashcardsPage.css';

export function FlashcardsPage() {
  return (
    <article className="node-view node-view--page flashcards-page">
      <PageViewHeader
        className="flashcards-page__header"
        title={<h1>Flashcards</h1>}
        actions={
          <FlashcardStats />
        }
      />
      <div className="flashcards-page__content">
        <FlashcardStudyView />
      </div>
    </article>
  );
}

export default FlashcardsPage;
