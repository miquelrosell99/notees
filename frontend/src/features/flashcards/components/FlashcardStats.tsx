import { useFlashcardStats } from '../hooks/useFlashcards';
import './FlashcardStats.css';

export function FlashcardStats() {
  const { data: stats, isLoading } = useFlashcardStats();

  if (isLoading || !stats) {
    return <div className="flashcard-stats flashcard-stats--loading">Loading stats…</div>;
  }

  return (
    <div className="flashcard-stats">
      <div className="flashcard-stats__item">
        <span className="flashcard-stats__value">{stats.total_cards}</span>
        <span className="flashcard-stats__label">Total</span>
      </div>
      <div className="flashcard-stats__item">
        <span className="flashcard-stats__value">{stats.due_now}</span>
        <span className="flashcard-stats__label">Due</span>
      </div>
      <div className="flashcard-stats__item">
        <span className="flashcard-stats__value">{stats.new_cards}</span>
        <span className="flashcard-stats__label">New</span>
      </div>
      <div className="flashcard-stats__item">
        <span className="flashcard-stats__value">{stats.mature_cards}</span>
        <span className="flashcard-stats__label">Mature</span>
      </div>
    </div>
  );
}
