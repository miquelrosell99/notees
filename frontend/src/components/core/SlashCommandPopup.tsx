/**
 * SlashCommandPopup - Floating popup for slash commands
 * 
 * Shows available commands when user types / in the editor.
 * Commands include: Add comment, Insert image, Insert audio, Insert file, Page Link, Block Link, etc.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import './SlashCommandPopup.css';
import { CommentIcon, ImageIcon, AttachmentIcon, AudioIcon, LinkIcon } from '../icons';

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'link',
    label: 'Insert Link',
    description: 'Link to a page or block [[]]',
    icon: <LinkIcon size="sm" />,
  },
  {
    id: 'comment',
    label: 'Add comment',
    description: 'Add a comment to this block',
    icon: <CommentIcon size="sm" />,
  },
  {
    id: 'image',
    label: 'Insert image',
    description: 'Upload an image (JPEG, PNG)',
    icon: <ImageIcon size="sm" />,
  },
  {
    id: 'audio',
    label: 'Insert audio',
    description: 'Upload an audio file (MP3, WAV, OGG)',
    icon: <AudioIcon size="sm" />,
  },
  {
    id: 'file',
    label: 'Insert file',
    description: 'Upload any supported file',
    icon: <AttachmentIcon size="sm" />,
  },
  // Future commands can be added here:
  // { id: 'task', label: 'Task', description: 'Create a task', icon: <TaskIcon /> },
  // { id: 'quote', label: 'Quote', description: 'Insert a quote block', icon: <QuoteIcon /> },
];

export interface SlashCommandPopupProps {
  /** Whether the popup is visible */
  isOpen: boolean;
  /** The search query (text after /) */
  query: string;
  /** Position to render the popup */
  position: { top: number; left: number };
  /** Callback when a command is selected */
  onSelect: (commandId: string) => void;
  /** Callback to close the popup */
  onClose: () => void;
}

export function SlashCommandPopup({
  isOpen,
  query,
  position,
  onSelect,
  onClose,
}: SlashCommandPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Filter commands based on query
  const filteredCommands = useMemo(() => {
    if (!query) return SLASH_COMMANDS;
    
    const lowerQuery = query.toLowerCase();
    return SLASH_COMMANDS.filter(cmd => 
      cmd.label.toLowerCase().includes(lowerQuery) ||
      cmd.description.toLowerCase().includes(lowerQuery)
    );
  }, [query]);
  
  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredCommands.length, query]);
  
  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isOpen) return;
    
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(i => Math.min(i + 1, filteredCommands.length - 1));
        break;
        
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex(i => Math.max(i - 1, 0));
        break;
        
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        if (filteredCommands[selectedIndex]) {
          onSelect(filteredCommands[selectedIndex].id);
        }
        break;
        
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
        
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
    }
  }, [isOpen, selectedIndex, filteredCommands, onSelect, onClose]);
  
  // Attach keyboard listener
  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown, true);
      return () => document.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [isOpen, handleKeyDown]);
  
  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        onClose();
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);
  
  // Calculate adjusted position to keep popup within viewport
  const adjustedPosition = useMemo(() => {
    const popupWidth = 300; // max-width from CSS
    const popupHeight = 320; // max-height from CSS
    const padding = 8;
    
    let top = position.top;
    let left = position.left;
    
    // Adjust horizontal position
    if (left + popupWidth > window.innerWidth - padding) {
      left = window.innerWidth - popupWidth - padding;
    }
    if (left < padding) {
      left = padding;
    }
    
    // Adjust vertical position - show above if not enough space below
    const spaceBelow = window.innerHeight - position.top;
    if (spaceBelow < popupHeight + padding && position.top > popupHeight + padding) {
      // Show above the cursor
      top = position.top - popupHeight - 24; // 24px for line height
    }
    
    return { top, left };
  }, [position]);
  
  if (!isOpen) return null;
  
  return (
    <div
      ref={containerRef}
      className="slash-command-popup"
      style={{
        position: 'fixed',
        top: adjustedPosition.top,
        left: adjustedPosition.left,
        zIndex: 1000,
      }}
    >
      <div className="slash-command-popup__header">
        <span className="slash-command-popup__icon">/</span>
        <span>Commands</span>
      </div>
      
      <div className="slash-command-popup__list">
        {filteredCommands.length === 0 ? (
          <div className="slash-command-popup__empty">
            No matching commands
          </div>
        ) : (
          filteredCommands.map((cmd, index) => (
            <button
              key={cmd.id}
              className={`slash-command-popup__item ${index === selectedIndex ? 'slash-command-popup__item--selected' : ''}`}
              onClick={() => onSelect(cmd.id)}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span className="slash-command-popup__item-icon">
                {cmd.icon}
              </span>
              <div className="slash-command-popup__item-content">
                <span className="slash-command-popup__item-label">
                  {cmd.label}
                </span>
                <span className="slash-command-popup__item-description">
                  {cmd.description}
                </span>
              </div>
            </button>
          ))
        )}
      </div>
      
      <div className="slash-command-popup__footer">
        <span className="slash-command-popup__hint">
          <kbd>Enter</kbd> to select
        </span>
      </div>
    </div>
  );
}

export default SlashCommandPopup;
