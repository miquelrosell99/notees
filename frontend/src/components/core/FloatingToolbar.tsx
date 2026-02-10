/**
 * FloatingToolbar Component
 * 
 * A floating toolbar that appears on text selection in edit mode.
 * Similar to CKEditor's inline toolbar - allows toggling bold, italic, strikethrough, code, and links.
 * Uses Card for styling and Button for actions.
 */
import { forwardRef, useCallback, useState, useRef, useEffect, useImperativeHandle, type ReactNode } from 'react';
import { mdiFormatBold, mdiFormatItalic, mdiFormatStrikethrough, mdiFormatUnderline, mdiCodeTags, mdiLinkVariant } from '@mdi/js';
import { Card } from './Card';
import { Button } from './Button';
import { TextField } from './TextField';
import './FloatingToolbar.css';

export interface FloatingToolbarHandle {
  focusFirstButton: () => void;
}

export interface FloatingToolbarAction {
  /** Unique key for the action */
  key: string;
  /** MDI icon path */
  icon: string;
  /** Tooltip/title text */
  title: string;
  /** Whether this action is currently active (e.g., text is bold) */
  active?: boolean;
  /** Handler when clicked */
  onClick: () => void;
}

export interface FloatingToolbarProps {
  /** Position of the toolbar */
  position: { top: number; left: number };
  /** Whether the toolbar is visible */
  visible: boolean;
  /** Custom actions to display */
  actions?: FloatingToolbarAction[];
  /** Default formatting actions (bold, italic, underline, strikethrough, code, link) */
  onBold?: () => void;
  onItalic?: () => void;
  onUnderline?: () => void;
  onStrikethrough?: () => void;
  onCode?: () => void;
  onLink?: (url: string) => void;
  /** Active state for default actions */
  boldActive?: boolean;
  italicActive?: boolean;
  underlineActive?: boolean;
  strikethroughActive?: boolean;
  codeActive?: boolean;
  linkActive?: boolean;
  /** Additional content to render */
  children?: ReactNode;
  /** Additional class name */
  className?: string;
  /** Callback when ArrowUp is pressed to close toolbar and return focus to editor */
  onClose?: () => void;
}

/**
 * FloatingToolbar - appears on text selection for inline formatting.
 * Positioned absolutely based on the selection coordinates.
 */
export const FloatingToolbar = forwardRef<FloatingToolbarHandle, FloatingToolbarProps>(
  function FloatingToolbar(
    {
      position,
      visible,
      actions,
      onBold,
      onItalic,
      onUnderline,
      onStrikethrough,
      onCode,
      onLink,
      boldActive = false,
      italicActive = false,
      underlineActive = false,
      strikethroughActive = false,
      codeActive = false,
      linkActive = false,
      children,
      className = '',
      onClose,
    },
    ref
  ) {
    // State for link URL input
    const [showLinkInput, setShowLinkInput] = useState(false);
    const [linkUrl, setLinkUrl] = useState('');
    
    // State for keyboard navigation
    const [focusedButtonIndex, setFocusedButtonIndex] = useState(-1);
    
    // Refs for buttons
    const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const containerRef = useRef<HTMLDivElement>(null);
    
    // Expose focusFirstButton method to parent
    useImperativeHandle(ref, () => ({
      focusFirstButton: () => {
        setFocusedButtonIndex(0);
        buttonRefs.current[0]?.focus();
      },
    }), []);
    
    // Reset focus when toolbar becomes invisible
    useEffect(() => {
      if (!visible) {
        setFocusedButtonIndex(-1);
      }
    }, [visible]);

    // Prevent mousedown from stealing focus from the editor
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
    }, []);

    const handleLinkClick = useCallback(() => {
      setShowLinkInput(true);
      setLinkUrl('');
    }, []);

    const handleLinkSubmit = useCallback(() => {
      if (linkUrl.trim() && onLink) {
        // Add https:// if no protocol specified
        let finalUrl = linkUrl.trim();
        if (!/^https?:\/\//i.test(finalUrl)) {
          finalUrl = 'https://' + finalUrl;
        }
        onLink(finalUrl);
      }
      setShowLinkInput(false);
      setLinkUrl('');
    }, [linkUrl, onLink]);

    const handleLinkKeyDown = useCallback((e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleLinkSubmit();
      } else if (e.key === 'Escape') {
        setShowLinkInput(false);
        setLinkUrl('');
      }
    }, [handleLinkSubmit]);

  // Handle keyboard navigation within the toolbar
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setFocusedButtonIndex(-1);
      onClose?.();
      return;
    }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      
      const buttonCount = buttonRefs.current.filter(Boolean).length;
      if (buttonCount === 0) return;
      
      let newIndex = focusedButtonIndex;
      if (e.key === 'ArrowLeft') {
        newIndex = focusedButtonIndex <= 0 ? buttonCount - 1 : focusedButtonIndex - 1;
      } else {
        newIndex = focusedButtonIndex >= buttonCount - 1 ? 0 : focusedButtonIndex + 1;
      }
      
      setFocusedButtonIndex(newIndex);
      buttonRefs.current[newIndex]?.focus();
      return;
    }
    
    if (e.key === 'Enter' && focusedButtonIndex >= 0) {
      e.preventDefault();
      e.stopPropagation();
      buttonRefs.current[focusedButtonIndex]?.click();
      return;
    }
  }, [focusedButtonIndex, onClose]);

  if (!visible) return null;

  // Build default actions if handlers are provided
  const defaultActions: FloatingToolbarAction[] = [];
    
    if (onBold) {
      defaultActions.push({
        key: 'bold',
        icon: mdiFormatBold,
        title: 'Bold (Ctrl+B)',
        active: boldActive,
        onClick: onBold,
      });
    }
    
    if (onItalic) {
      defaultActions.push({
        key: 'italic',
        icon: mdiFormatItalic,
        title: 'Italic (Ctrl+I)',
        active: italicActive,
        onClick: onItalic,
      });
    }
    
    if (onUnderline) {
      defaultActions.push({
        key: 'underline',
        icon: mdiFormatUnderline,
        title: 'Underline (Ctrl+U)',
        active: underlineActive,
        onClick: onUnderline,
      });
    }
    
    if (onStrikethrough) {
      defaultActions.push({
        key: 'strikethrough',
        icon: mdiFormatStrikethrough,
        title: 'Strikethrough (Ctrl+Shift+S)',
        active: strikethroughActive,
        onClick: onStrikethrough,
      });
    }
    
    if (onCode) {
      defaultActions.push({
        key: 'code',
        icon: mdiCodeTags,
        title: 'Code (Ctrl+`)',
        active: codeActive,
        onClick: onCode,
      });
    }
    
    if (onLink) {
      defaultActions.push({
        key: 'link',
        icon: mdiLinkVariant,
        title: 'Link (Ctrl+K)',
        active: linkActive || showLinkInput,
        onClick: handleLinkClick,
      });
    }

    const allActions = [...defaultActions, ...(actions || [])];

    return (
      <div
        ref={containerRef}
        className={`floating-toolbar ${className}`}
        style={{
          position: 'absolute',
          top: position.top,
          left: position.left,
          zIndex: 1000,
        }}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
      >
        <Card
          elevation="high"
          variant="default"
          padding={true}
          paddingSize="sm"
          radius="md"
          className="floating-toolbar__card"
        >
          <div className="floating-toolbar__actions">
            {allActions.map((action, index) => (
              <Button
                key={action.key}
                ref={(el) => { buttonRefs.current[index] = el; }}
                icon={action.icon}
                variant="ghost"
                size="sm"
                title={action.title}
                active={action.active}
                onClick={action.onClick}
                className="floating-toolbar__button"
              />
            ))}
            {showLinkInput && (
              <div className="floating-toolbar__link-input">
                <TextField
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="Enter URL..."
                  autoFocus
                  onKeyDown={handleLinkKeyDown}
                  onBlur={() => {
                    // Small delay to allow button click to register
                    setTimeout(() => {
                      setShowLinkInput(false);
                      setLinkUrl('');
                    }, 150);
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleLinkSubmit}
                >
                  Add
                </Button>
              </div>
            )}
            {children}
          </div>
        </Card>
      </div>
    );
  }
);

export default FloatingToolbar;
