import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { ColorButton } from '@/components/ui/ColorButton';
import { EmojiPicker } from '@/components/ui/EmojiPicker';
import { getMdiClass } from '@/utils/iconDom';

interface IconColorPickerRowProps {
  currentIcon: string | null;
  currentColor: string | null;
  isFavorited?: boolean;
  onFavoriteToggle?: () => void;
  onIconChange: (icon: string | null) => void;
  onColorChange: (color: string | null) => void;
}

export function IconColorPickerRow({
  currentIcon,
  currentColor,
  isFavorited,
  onFavoriteToggle,
  onIconChange,
  onColorChange,
}: IconColorPickerRowProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [pickerPos, setPickerPos] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const handleIconClick = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPickerPos({
        x: Math.min(rect.left, window.innerWidth - 340),
        y: Math.min(rect.bottom + 4, window.innerHeight - 450),
      });
    }
    setShowPicker((prev) => !prev);
  }, []);

  const handleIconSelect = useCallback(
    (value: string) => {
      onIconChange(value || null);
      setShowPicker(false);
    },
    [onIconChange],
  );

  const renderTriggerValue = () => {
    if (!currentIcon) {
      return <Icon path="mdi-emoticon-happy-outline" size={0.9} />;
    }
    const mdiPath = getMdiClass(currentIcon);
    if (mdiPath) {
      return <Icon path={mdiPath} size={0.9} />;
    }
    if (currentIcon.match(/^mdi[A-Z]/)) {
      return null;
    }
    return <span className="context-menu-icon-emoji">{currentIcon}</span>;
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.currentTarget.click();
        }
      }}
      className="context-menu-icon-color-row"
      onMouseDown={handleMouseDown}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      <button
        ref={triggerRef}
        className="context-menu-icon-btn"
        onClick={handleIconClick}
        type="button"
        title="Change icon"
      >
        {renderTriggerValue()}
      </button>
      {onFavoriteToggle && (
        <Button
          aria-label={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
          variant="ghost"
          size="sm"
          icon={isFavorited ? 'mdi mdi-star' : 'mdi mdi-star-outline'}
          className={`context-menu-favorite-btn ${isFavorited ? 'favorited' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onFavoriteToggle();
          }}
          title={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
        />
      )}
      <ColorButton
        color={currentColor || ''}
        size="sm"
        showPicker
        showNoneOption
        onColorChange={onColorChange}
      />
      {showPicker &&
        createPortal(
          <EmojiPicker
            value={currentIcon || ''}
            onSelect={handleIconSelect}
            onClose={() => setShowPicker(false)}
            position={pickerPos}
          />,
          document.body,
        )}
    </div>
  );
}
