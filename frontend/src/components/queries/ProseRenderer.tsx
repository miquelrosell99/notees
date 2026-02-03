/**
 * ProseRenderer Component
 * 
 * Renders natural language query descriptions with markdown links for node references.
 * Converts markdown link format [node name](uuid) to clickable links.
 */
import React from 'react';
import { useNodesStore } from '@/stores';
import './ProseRenderer.css';

interface ProseRendererProps {
  /** The prose text with markdown links */
  text: string;
}

/**
 * Parse text and render markdown links as clickable elements
 */
export function ProseRenderer({ text }: ProseRendererProps): React.JSX.Element {
  useNodesStore();

  // Parse markdown links: [text](uuid)
  const parts = parseMarkdownLinks(text);

  return (
    <div className="prose-renderer">
      {parts.map((part, index) => {
        if (part.type === 'text') {
          return <span key={index}>{part.content}</span>;
        } else if (part.type === 'link') {
          return (
            <button
              key={index}
              className="prose-renderer__link"
              onClick={(e) => {
                e.preventDefault();
                // Extract node ID from UUID if needed, or use UUID lookup
                // For now, we'll just show the link - may need backend support for UUID -> ID lookup
                console.log('Open node with UUID:', part.uuid);
              }}
              title={`UUID: ${part.uuid}`}
            >
              {part.text}
            </button>
          );
        }
        return null;
      })}
    </div>
  );
}

// ==================== Helper Types ====================

interface TextPart {
  type: 'text';
  content: string;
}

interface LinkPart {
  type: 'link';
  text: string;
  uuid: string;
}

type Part = TextPart | LinkPart;

// ==================== Parser ====================

/**
 * Parse markdown links from text
 * Supports format: [text](uuid)
 */
function parseMarkdownLinks(text: string): Part[] {
  const parts: Part[] = [];
  const regex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Add text before the link
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        content: text.substring(lastIndex, match.index),
      });
    }

    // Add the link
    parts.push({
      type: 'link',
      text: match[1],
      uuid: match[2],
    });

    lastIndex = regex.lastIndex;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({
      type: 'text',
      content: text.substring(lastIndex),
    });
  }

  return parts;
}
