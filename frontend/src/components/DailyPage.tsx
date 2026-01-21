/**
 * Daily journal page component
 */
import { useTodayPage, useUpdateNode, useCreateNode } from '@/hooks';
import { useBlockSelectionStore } from '@/stores';
import { mdiPlus } from '@mdi/js';
import './DailyPage.css';
import type { NodeUpdate } from '@/types';
import { BlockEditor } from './blocks/BlockEditor';
import { CalendarIcon } from './icons';
import { Button } from './core/Button';

interface DailyPageProps {
  date?: string; // YYYY-MM-DD format, defaults to today
  className?: string;
}

export function DailyPage({ date, className = '' }: DailyPageProps) {
  const today = date || new Date().toISOString().split('T')[0];
  const { data: dailyPage, isLoading, error } = useTodayPage();
  const updateNode = useUpdateNode();
  const createNode = useCreateNode();
  const { enterEditMode } = useBlockSelectionStore();

  const handleBlockChange = (blockId: number, name: string) => {
    const update: NodeUpdate = { name };
    updateNode.mutate({ id: blockId, data: update });
  };

  const handleAddBlock = async () => {
    if (dailyPage) {
      const newNode = await createNode.mutateAsync({
        name: '',
        parent_id: dailyPage.id,
      });
      // Set the new block to edit mode so the user can start typing right away
      enterEditMode(newNode.id);
    }
  };

  if (isLoading) {
    return (
      <div className={`daily-page loading ${className}`}>
        Loading daily page...
      </div>
    );
  }

  if (error) {
    return (
      <div className={`daily-page error ${className}`}>
        Failed to load daily page
      </div>
    );
  }

  if (!dailyPage) {
    return (
      <div className={`daily-page empty ${className}`}>
        <p>No daily page for {today}</p>
      </div>
    );
  }

  const formattedDate = new Date(today).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <article className={`daily-page ${className}`}>
      <header className="daily-page-header">
        <span className="daily-icon"><CalendarIcon size="md" /></span>
        <h1 className="daily-title">{formattedDate}</h1>
      </header>
      
      <div className="daily-content">
        {dailyPage.children && dailyPage.children.length > 0 ? (
          <section className="daily-blocks">
            {dailyPage.children.map((block) => (
              <div key={block.id} className="daily-block">
                <BlockEditor
                  content={block.name || ''}
                  onChange={(name) => handleBlockChange(block.id, name)}
                />
              </div>
            ))}
          </section>
        ) : (
          <div className="daily-empty">
            <Button icon={mdiPlus} onClick={handleAddBlock} className="add-block-btn" variant="ghost">
              Add block
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
