import { Button } from '@/components/ui/Button';
import { useFlashcardByNodeId, useCreateFlashcard } from '../hooks/useFlashcards';
import './FlashcardEditor.css';

interface FlashcardEditorProps {
  nodeUuid: string;
  readOnly?: boolean;
}

export function FlashcardEditor({ nodeUuid, readOnly = false }: FlashcardEditorProps) {
  const { data: card, isLoading } = useFlashcardByNodeId(nodeUuid);
  const create = useCreateFlashcard();

  if (isLoading) {
    return (
      <div className="flashcard-editor flashcard-editor--loading">
        <div className="flashcard-editor__skeleton" />
        <div className="flashcard-editor__skeleton" />
      </div>
    );
  }

  if (!card) {
    return (
      <div className="flashcard-editor flashcard-editor--empty">
        <p className="flashcard-editor__hint">
          No flashcard data yet. Add <strong>cloze</strong> child blocks to define the back side.
        </p>
        {!readOnly && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => create.mutate({ nodeUuid, frontText: '', backText: '' })}
            disabled={create.isPending}
          >
            Create flashcard
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flashcard-editor">
      <div className="flashcard-editor__section">
        <span className="flashcard-editor__label">Front</span>
        <div className="flashcard-editor__content">
          {card.front_text || <em className="flashcard-editor__placeholder">(empty front)</em>}
        </div>
      </div>

      <div className="flashcard-editor__section">
        <span className="flashcard-editor__label">Back (clozes)</span>
        <div className="flashcard-editor__content">
          {card.back_text ? (
            card.back_text.split('\n\n---\n\n').map((cloze, index) => (
              <div key={index} className="flashcard-editor__cloze">
                {cloze}
              </div>
            ))
          ) : (
            <em className="flashcard-editor__placeholder">
              Add child blocks with the <strong>cloze</strong> class to fill the back side.
            </em>
          )}
        </div>
      </div>
    </div>
  );
}
