/**
 * SlashCommandMenu — Popup menu for / slash commands in the editor.
 *
 * Shows available commands (link, type, tag, query, table, comment, image, etc.)
 * filtered by the user's query after the / trigger.
 */

import { useState, useRef, useEffect, useMemo, type JSX, type ReactNode } from 'react';
import { CommentIcon, ImageIcon, AttachmentIcon, AudioIcon, LinkIcon, TagIcon, BulletIcon, DatabaseIcon, TableIcon, CodeIcon, PropertiesIcon, PageIcon, Icon } from '../../components/core/icons';
import './SlashCommandMenu.css';

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
    label: 'Insert Page Link',
    description: 'Link to a page',
    icon: <LinkIcon size="sm" />,
  },
  {
    id: 'blocklink',
    label: 'Insert Block Link',
    description: 'Link to a specific block',
    icon: <BulletIcon size="sm" />,
  },
  {
    id: 'embed',
    label: 'Embed Node',
    description: 'Embed the full content of a node as a portal',
    icon: <PageIcon size="sm" />,
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
    description: 'Add a class to this block +',
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
    id: 'code',
    label: 'Code Block',
    description: 'Convert block to code block',
    icon: <CodeIcon size="sm" />,
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
  {
    id: 'template',
    label: 'Add template',
    description: 'Insert content from a template',
    icon: <PageIcon size="sm" />,
  },
  {
    id: 'move',
    label: 'Move to page',
    description: 'Move this block under a different page',
    icon: <PageIcon size="sm" />,
  },
  {
    id: 'warning',
    label: 'Warning callout',
    description: 'Banner block for warnings',
    icon: <Icon path="mdi-alert" size="sm" />,
  },
  {
    id: 'note',
    label: 'Note callout',
    description: 'Banner block for notes',
    icon: <Icon path="mdi-note-outline" size="sm" />,
  },
  {
    id: 'tip',
    label: 'Tip callout',
    description: 'Banner block for tips',
    icon: <Icon path="mdi-lightbulb-outline" size="sm" />,
  },
  {
    id: 'info',
    label: 'Info callout',
    description: 'Banner block for information',
    icon: <Icon path="mdi-information-outline" size="sm" />,
  },
  {
    id: 'danger',
    label: 'Danger callout',
    description: 'Banner block for dangers',
    icon: <Icon path="mdi-alert-circle-outline" size="sm" />,
  },
  {
    id: 'success',
    label: 'Success callout',
    description: 'Banner block for successes',
    icon: <Icon path="mdi-check-circle-outline" size="sm" />,
  },
];

// ─── Props ────────────────────────────────────────────────────────

export interface SlashCommandMenuProps {
  query: string;
  position: { top: number; left: number };
  onSelect: (value: string, metadata?: unknown) => void;
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────

export function SlashCommandMenu({
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
    let mounted = true;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!mounted) return;

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
    return () => {
      mounted = false;
      document.removeEventListener('keydown', handleKeyDown, true);
    };
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
  const { positionStyle, openUpward } = useMemo(() => {
    const popupWidth = 280;
    const popupHeight = 320;
    const padding = 8;
    const gap = 24;

    let { top, left } = position;

    if (left + popupWidth > window.innerWidth - padding) {
      left = window.innerWidth - popupWidth - padding;
    }
    if (left < padding) {
      left = padding;
    }

    const openUpward = top + popupHeight > window.innerHeight - padding;

    return {
      positionStyle: openUpward
        ? { bottom: window.innerHeight - top + gap, left }
        : { top, left },
      openUpward,
    };
  }, [position]);

  return (
    <div
      ref={containerRef}
      className={`slash-command-menu${openUpward ? ' slash-command-menu--upward' : ''}`}
      style={{
        position: 'fixed',
        ...positionStyle,
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
