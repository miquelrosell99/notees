/**
 * TriggerPopup — Popup UI for editor triggers.
 *
 * Renders the appropriate popup based on trigger type:
 * - [[  → Link search (SuggestionPopup type='link')
 * - @   → Type/class search (SuggestionPopup type='type')
 * - #   → Tag search (SuggestionPopup type='tag')
 * - /   → Slash commands (link, type, tag, query, table, comment, image, etc.)
 */

import { useState, useCallback, useRef, useEffect, useMemo, type JSX, type ReactNode } from 'react';
import type { TriggerType } from './TriggerPlugin';
import { SuggestionPopup, type SuggestionType } from '../../components/SuggestionPopup';
import type { Node } from '../../types/api';
import { CommentIcon, ImageIcon, AttachmentIcon, AudioIcon, LinkIcon, TagIcon, BulletIcon, DatabaseIcon, TableIcon, PropertiesIcon } from '../../components/icons';
import './TriggerPopup.css';

// ─── Slash Command Definitions ───────────────────────────────────

interface SlashCommand {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'link',
    label: 'Insert Link',
    description: 'Link to a page or block [[]]',
    icon: <LinkIcon size="sm" />,
  },
  {
    id: 'url',
    label: 'Add URL',
    description: 'Add a URL link to external website',
    icon: <LinkIcon size="sm" />,
  },
  {
    id: 'type',
    label: 'Add Class',
    description: 'Add a class to this block @',
    icon: <BulletIcon size="sm" />,
  },
  {
    id: 'tag',
    label: 'Add Tag',
    description: 'Add a tag to this block #',
    icon: <TagIcon size="sm" />,
  },
  {
    id: 'property',
    label: 'Add property',
    description: 'Add a property to this block',
    icon: <PropertiesIcon size="sm" />,
  },
  {
    id: 'query',
    label: 'Query',
    description: 'Assign query class to this block',
    icon: <DatabaseIcon size="sm" />,
  },
  {
    id: 'table',
    label: 'Table',
    description: 'Convert block to table',
    icon: <TableIcon size="sm" />,
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
];

// ─── Props ────────────────────────────────────────────────────────

export interface TriggerPopupProps {
  type: TriggerType;
  query: string;
  position: { top: number; left: number };
  onSelect: (value: string, metadata?: unknown) => void;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────

export function TriggerPopup({
  type,
  query,
  position,
  onSelect,
  onClose,
}: TriggerPopupProps): JSX.Element | null {
  // For link/type/tag triggers, use SuggestionPopup
  if (type === 'link' || type === 'type' || type === 'tag') {
    const suggestionType: SuggestionType = type === 'type' ? 'class' : type;

    const handleSelect = useCallback((node: Node, _keepInline: boolean) => {
      onSelect(node.uuid, { node, type: suggestionType });
    }, [onSelect, suggestionType]);

    const handleSelectDatePage = useCallback((pageId: string, _pageName: string) => {
      onSelect(pageId, { type: 'date' });
    }, [onSelect]);

    return (
      <SuggestionPopup
        isOpen={true}
        query={query}
        type={suggestionType}
        position={position}
        onSelect={handleSelect}
        onClose={onClose}
        onSelectDatePage={type === 'link' ? handleSelectDatePage : undefined}
      />
    );
  }

  // For slash commands, render our own menu
  return (
    <SlashCommandMenu
      query={query}
      position={position}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}

// ─── Slash Command Menu ───────────────────────────────────────────

interface SlashCommandMenuProps {
  query: string;
  position: { top: number; left: number };
  onSelect: (value: string, metadata?: unknown) => void;
  onClose: () => void;
}

function SlashCommandMenu({
  query,
  position,
  onSelect,
  onClose,
}: SlashCommandMenuProps): JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

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

  // Scroll selected item into view
  useEffect(() => {
    const selectedElement = itemRefs.current[selectedIndex];
    if (selectedElement) {
      selectedElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [selectedIndex]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
            onSelect(filteredCommands[selectedIndex].id, { command: filteredCommands[selectedIndex] });
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
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [selectedIndex, filteredCommands, onSelect, onClose]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Adjust position to stay within viewport
  const adjustedPosition = useMemo(() => {
    const popupWidth = 280;
    const popupHeight = 320;
    const padding = 8;

    let { top, left } = position;

    if (left + popupWidth > window.innerWidth - padding) {
      left = window.innerWidth - popupWidth - padding;
    }
    if (left < padding) {
      left = padding;
    }

    if (top + popupHeight > window.innerHeight - padding) {
      top = position.top - popupHeight - 24;
    }

    return { top, left };
  }, [position]);

  return (
    <div
      ref={containerRef}
      className="slash-command-menu"
      style={{
        position: 'fixed',
        top: adjustedPosition.top,
        left: adjustedPosition.left,
        zIndex: 1000,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="slash-command-menu__header">
        <span className="slash-command-menu__icon">/</span>
        <span>Commands</span>
      </div>

      <div className="slash-command-menu__list">
        {filteredCommands.length === 0 ? (
          <div className="slash-command-menu__empty">No matching commands</div>
        ) : (
          filteredCommands.map((cmd, index) => (
            <button
              key={cmd.id}
              ref={(el) => { itemRefs.current[index] = el; }}
              className={`slash-command-menu__item ${index === selectedIndex ? 'slash-command-menu__item--selected' : ''}`}
              onClick={() => onSelect(cmd.id, { command: cmd })}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span className="slash-command-menu__item-icon">
                {cmd.icon}
              </span>
              <div className="slash-command-menu__item-text">
                <span className="slash-command-menu__item-label">{cmd.label}</span>
                <span className="slash-command-menu__item-description">{cmd.description}</span>
              </div>
            </button>
          ))
        )}
      </div>

      <div className="slash-command-menu__footer">
        <span className="slash-command-menu__hint">
          <kbd>Enter</kbd> to select
        </span>
      </div>
    </div>
  );
}
