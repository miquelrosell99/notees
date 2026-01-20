/**
 * Scratchpad Component
 * 
 * A floating pseudo-page that is emptied each day.
 * Provides a quick note-taking space that resets daily.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { mdiClose, mdiTrashCanOutline, mdiPin, mdiPinOff } from '@mdi/js';
import Icon from '@mdi/react';
import './Scratchpad.css';

interface ScratchpadProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ScratchpadEntry {
  id: string;
  content: string;
  timestamp: string;
}

interface ScratchpadData {
  date: string;
  entries: ScratchpadEntry[];
}

const STORAGE_KEY = 'notees-scratchpad';

function getTodayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function Scratchpad({ isOpen, onClose }: ScratchpadProps) {
  const [entries, setEntries] = useState<ScratchpadEntry[]>([]);
  const [newEntry, setNewEntry] = useState('');
  const [isPinned, setIsPinned] = useState(false);
  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load scratchpad data on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const data: ScratchpadData = JSON.parse(stored);
        const today = getTodayDateString();
        
        // Only load entries if they're from today
        if (data.date === today) {
          setEntries(data.entries);
        } else {
          // Clear old entries
          setEntries([]);
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: today, entries: [] }));
        }
      } catch (e) {
        console.error('Failed to load scratchpad data:', e);
        setEntries([]);
      }
    }
    
    // Load pinned state
    const pinnedState = localStorage.getItem('notees-scratchpad-pinned');
    if (pinnedState === 'true') {
      setIsPinned(true);
    }
    
    // Load position
    const savedPos = localStorage.getItem('notees-scratchpad-position');
    if (savedPos) {
      try {
        setPosition(JSON.parse(savedPos));
      } catch (e) {
        // Use default position
      }
    }
  }, []);

  // Save entries when they change
  useEffect(() => {
    const data: ScratchpadData = {
      date: getTodayDateString(),
      entries,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [entries]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const handleAddEntry = useCallback(() => {
    if (!newEntry.trim()) return;
    
    const entry: ScratchpadEntry = {
      id: generateId(),
      content: newEntry.trim(),
      timestamp: new Date().toLocaleTimeString(),
    };
    
    setEntries(prev => [...prev, entry]);
    setNewEntry('');
  }, [newEntry]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAddEntry();
    }
  }, [handleAddEntry]);

  const handleDeleteEntry = useCallback((id: string) => {
    setEntries(prev => prev.filter(entry => entry.id !== id));
  }, []);

  const handleClearAll = useCallback(() => {
    setEntries([]);
  }, []);

  const handleTogglePin = useCallback(() => {
    setIsPinned(prev => {
      localStorage.setItem('notees-scratchpad-pinned', String(!prev));
      return !prev;
    });
  }, []);

  // Dragging handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    setIsDragging(true);
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
  }, [position]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newPos = {
        x: Math.max(0, Math.min(window.innerWidth - 320, e.clientX - dragOffset.current.x)),
        y: Math.max(0, Math.min(window.innerHeight - 200, e.clientY - dragOffset.current.y)),
      };
      setPosition(newPos);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      localStorage.setItem('notees-scratchpad-position', JSON.stringify(position));
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, position]);

  if (!isOpen && !isPinned) return null;

  return (
    <div
      ref={containerRef}
      className={`scratchpad ${isDragging ? 'dragging' : ''} ${isPinned ? 'pinned' : ''}`}
      style={{ left: position.x, top: position.y }}
    >
      <div className="scratchpad-header" onMouseDown={handleMouseDown}>
        <span className="scratchpad-title">📝 Scratchpad</span>
        <span className="scratchpad-date">{getTodayDateString()}</span>
        <div className="scratchpad-actions">
          <button
            className={`scratchpad-btn ${isPinned ? 'active' : ''}`}
            onClick={handleTogglePin}
            title={isPinned ? 'Unpin' : 'Pin'}
          >
            <Icon path={isPinned ? mdiPin : mdiPinOff} size={0.7} />
          </button>
          <button
            className="scratchpad-btn"
            onClick={handleClearAll}
            title="Clear all"
            disabled={entries.length === 0}
          >
            <Icon path={mdiTrashCanOutline} size={0.7} />
          </button>
          <button className="scratchpad-btn" onClick={onClose} title="Close">
            <Icon path={mdiClose} size={0.7} />
          </button>
        </div>
      </div>
      
      <div className="scratchpad-entries">
        {entries.length === 0 ? (
          <div className="scratchpad-empty">
            No notes yet. Start typing below!
          </div>
        ) : (
          entries.map(entry => (
            <div key={entry.id} className="scratchpad-entry">
              <span className="scratchpad-entry-time">{entry.timestamp}</span>
              <span className="scratchpad-entry-content">{entry.content}</span>
              <button
                className="scratchpad-entry-delete"
                onClick={() => handleDeleteEntry(entry.id)}
                title="Delete"
              >
                <Icon path={mdiClose} size={0.5} />
              </button>
            </div>
          ))
        )}
      </div>
      
      <div className="scratchpad-input-area">
        <textarea
          ref={inputRef}
          className="scratchpad-input"
          value={newEntry}
          onChange={(e) => setNewEntry(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a quick note... (Enter to add)"
          rows={2}
        />
      </div>
    </div>
  );
}

export default Scratchpad;
