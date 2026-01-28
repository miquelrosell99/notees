/**
 * HTML sanitization utilities using DOMPurify
 * 
 * Protects against XSS attacks by sanitizing pasted content and user input.
 */
import DOMPurify from 'dompurify';

/**
 * Sanitize HTML content to prevent XSS attacks.
 * 
 * This function removes dangerous tags and attributes while preserving safe formatting.
 * Used when pasting content from external sources.
 * 
 * @param dirty - The potentially unsafe HTML string
 * @returns Sanitized HTML string safe to render
 */
export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    // Allow common formatting tags
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre',
      'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'span', 'div'
    ],
    // Allow safe attributes
    ALLOWED_ATTR: ['href', 'title', 'class'],
    // Keep whitespace and line breaks
    KEEP_CONTENT: true,
    // Return clean text if all HTML is stripped
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
  });
}

/**
 * Strip all HTML tags and return plain text.
 * 
 * This is more aggressive than sanitizeHtml - it removes ALL formatting.
 * Use when you want to ensure no markup is preserved.
 * 
 * @param html - HTML string to convert to plain text
 * @returns Plain text with all HTML removed
 */
export function stripHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [],
    KEEP_CONTENT: true,
  });
}

/**
 * Sanitize content pasted from clipboard.
 * 
 * Preserves basic formatting but removes scripts, styles, and dangerous attributes.
 * This is the primary function to use in paste event handlers.
 * 
 * @param clipboardData - The DataTransfer object from paste event
 * @returns Sanitized plain text or HTML
 */
export function sanitizeClipboard(clipboardData: DataTransfer): string {
  const html = clipboardData.getData('text/html');
  const text = clipboardData.getData('text/plain');
  
  // If clipboard contains HTML, sanitize it
  if (html) {
    return sanitizeHtml(html);
  }
  
  // Otherwise return plain text (already safe)
  return text;
}
