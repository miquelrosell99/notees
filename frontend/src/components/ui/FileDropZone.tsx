/**
 * FileDropZone
 *
 * Drag-and-drop + click-to-browse file picker. Matches the visual style of
 * the asset upload dropzone.
 *
 * When no file is selected it renders a dashed zone with icon/text. Once a
 * file is chosen it shows a compact selected-file row with a clear button.
 */
import { useRef, useCallback, type ReactNode } from 'react';
import { Button } from './Button';
import './FileDropZone.css';

interface FileDropZoneProps {
  /** Currently selected file, or null */
  file: File | null;
  /** Passed to the hidden <input type="file"> */
  accept: string;
  /** Called when the user selects or drops a file */
  onSelect: (file: File) => void;
  /** Called when the user clears the selection */
  onClear: () => void;
  /** Icon shown in the empty state */
  icon?: ReactNode;
  /** Primary label in the empty state (default: "Drop a file here") */
  placeholder?: string;
  /** Secondary hint in the empty state (default: "or click to browse") */
  hint?: string;
  disabled?: boolean;
  className?: string;
}

export function FileDropZone({
  file,
  accept,
  onSelect,
  onClear,
  icon,
  placeholder = 'Drop a file here',
  hint = 'or click to browse',
  disabled = false,
  className = '',
}: FileDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isDraggingRef = useRef(false);
  // We use a state-free approach for the dragging class to avoid re-renders
  const zoneRef = useRef<HTMLDivElement>(null);

  const openFilePicker = () => {
    if (!disabled) inputRef.current?.click();
  };

  const setDragging = (val: boolean) => {
    isDraggingRef.current = val;
    zoneRef.current?.classList.toggle('file-drop-zone--dragging', val);
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (disabled) return;
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) onSelect(dropped);
    },
    [disabled, onSelect],
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onSelect(f);
    e.target.value = '';
  };

  const hiddenInput = (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      style={{ display: 'none' }}
      onChange={handleChange}
    />
  );

  if (file) {
    return (
      <div className={`file-drop-zone__selected ${className}`}>
        {hiddenInput}
        <span className="file-drop-zone__selected-name">{file.name}</span>
        <Button aria-label="Change file"
          variant="ghost"
          size="xs"
          icon="mdi mdi-pencil"
          className="file-drop-zone__selected-action"
          onClick={openFilePicker}
          disabled={disabled}
          title="Change file"
        />
        <Button aria-label="Remove file"
          variant="ghost"
          size="xs"
          icon="mdi mdi-close"
          className="file-drop-zone__selected-action file-drop-zone__selected-action--remove"
          onClick={onClear}
          disabled={disabled}
          title="Remove file"
        />
      </div>
    );
  }

  return (
    <>
      <div
        ref={zoneRef}
        className={[
          'file-drop-zone',
          disabled ? 'file-drop-zone--disabled' : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={openFilePicker}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openFilePicker();
          }
        }}
      >
        {icon && <div className="file-drop-zone__icon">{icon}</div>}
        <span className="file-drop-zone__primary">{placeholder}</span>
        {hint && <span className="file-drop-zone__hint">{hint}</span>}
      </div>
      {hiddenInput}
    </>
  );
}

