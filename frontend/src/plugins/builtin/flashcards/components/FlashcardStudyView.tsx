import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { DataStateView } from '@/components/ui/DataStateView';
import { useDueFlashcards, useReviewFlashcard } from '../hooks/useFlashcards';
import './FlashcardStudyView.css';

const GRADE_BUTTONS = [
  { grade: 0, label: 'Again', variant: 'danger' as const },
  { grade: 2, label: 'Hard', variant: 'default' as const },
  { grade: 3, label: 'Good', variant: 'primary' as const },
  { grade: 5, label: 'Easy', variant: 'primary' as const },
];

export function FlashcardStudyView() {
  const { data, isLoading, error, refetch } = useDueFlashcards();
  const review = useReviewFlashcard();
  const [showBack, setShowBack] = useState(false);

  const cards = data?.cards ?? [];
  const currentCard = cards[0] ?? null;

  const handleGrade = useCallback(async (grade: number) => {
    if (!currentCard) return;
    await review.mutateAsync({ nodeId: currentCard.node_id, grade });
    setShowBack(false);
  }, [currentCard, review]);

  return (
    <div className="flashcard-study">
      <DataStateView
        isLoading={isLoading}
        error={error}
        isEmpty={cards.length === 0}
        onRetry={refetch}
        errorTitle="Failed to load flashcards"
        emptyTitle="No cards due"
        emptyDescription="You're all caught up! New cards or cards due for review will appear here."
      >
        {currentCard && (
          <>
            <button
              type="button"
              className={`flashcard-study__card ${showBack ? 'flashcard-study__card--flipped' : ''}`}
              onClick={() => setShowBack(prev => !prev)}
              onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') setShowBack(prev => !prev); }}
              aria-label="Flashcard, click to flip"
            >
              <div className="flashcard-study__side flashcard-study__side--front">
                <p className="flashcard-study__text">{currentCard.front_text}</p>
                <span className="flashcard-study__hint">Click to reveal answer</span>
              </div>
              <div className="flashcard-study__side flashcard-study__side--back">
                {currentCard.back_text ? (
                  currentCard.back_text.split('\n\n---\n\n').map((cloze, index) => (
                    <p key={index} className="flashcard-study__text flashcard-study__cloze">
                      {cloze}
                    </p>
                  ))
                ) : (
                  <p className="flashcard-study__text flashcard-study__text--empty">
                    No cloze deletions found. Add child blocks with the cloze class.
                  </p>
                )}
              </div>
            </button>

            <div className="flashcard-study__actions">
              {GRADE_BUTTONS.map(({ grade, label, variant }) => (
                <Button
                  key={grade}
                  variant={variant}
                  size="md"
                  onClick={() => handleGrade(grade)}
                  disabled={review.isPending}
                >
                  {label}
                </Button>
              ))}
            </div>

            <p className="flashcard-study__remaining">
              {cards.length} card{cards.length !== 1 ? 's' : ''} remaining
            </p>
          </>
        )}
      </DataStateView>
    </div>
  );
}
