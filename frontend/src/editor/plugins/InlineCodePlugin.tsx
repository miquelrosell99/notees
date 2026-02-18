/**
 * InlineCodePlugin — Visual styling for inline code wrapped in backticks.
 *
 * Detects backtick-wrapped code patterns like `code` and wraps them in
 * <code> elements for visual styling, while keeping the backticks visible
 * in the text content. The text is stored as-is in the AST (not parsed).
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { TextNode } from 'lexical';

/**
 * This plugin uses Lexical's createDOM override pattern to wrap
 * backtick-wrapped text segments in <code> elements at render time.
 */
export function InlineCodePlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Override TextNode's createDOM to wrap backtick patterns
    const originalCreateDOM = TextNode.prototype.createDOM;
    
    TextNode.prototype.createDOM = function(config) {
      const dom = originalCreateDOM.call(this, config);
      const text = this.__text;
      
      // Check if text contains backtick-wrapped code
      const codePattern = /`[^`\n]+`/g;
      if (codePattern.test(text)) {
        // Create a wrapper span
        const wrapper = document.createElement('span');
        wrapper.className = 'has-inline-code';
        
        // Split text and wrap code segments
        let lastIndex = 0;
        const regex = /(`[^`\n]+`)/g;
        let match;
        
        while ((match = regex.exec(text)) !== null) {
          // Add text before match
          if (match.index > lastIndex) {
            wrapper.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
          }
          
          // Add code segment wrapped in <code>
          const code = document.createElement('code');
          code.className = 'inline-code';
          code.textContent = match[0];
          wrapper.appendChild(code);
          
          lastIndex = regex.lastIndex;
        }
        
        // Add remaining text
        if (lastIndex < text.length) {
          wrapper.appendChild(document.createTextNode(text.substring(lastIndex)));
        }
        
        // Copy format classes from original DOM
        if (dom.className) {
          wrapper.className += ' ' + dom.className;
        }
        
        return wrapper.childNodes.length > 0 ? wrapper : dom;
      }
      
      return dom;
    };

    return () => {
      // Restore original method
      TextNode.prototype.createDOM = originalCreateDOM;
    };
  }, [editor]);

  return null;
}




