/**
 * AudioRenderer Component
 * 
 * Renders audio assets with:
 * - Inline HTML5 audio player
 * - Space toggles play when block is selected
 * - Title below player
 */
import { useRef, useState, useCallback, useEffect } from 'react';
import './AudioRenderer.css';

interface AudioRendererProps {
  /** Asset file URL */
  assetUrl: string;
  /** MIME type for audio element */
  mimeType: string;
  /** Block title (editable block name) */
  title: string;
  /** Whether title is editable */
  editable?: boolean;
  /** Callback when title changes */
  onTitleChange?: (newTitle: string) => void;
  /** Whether this block is currently selected (for Space key handling) */
  isSelected?: boolean;
}

export function AudioRenderer({
  assetUrl,
  mimeType,
  title,
  editable = true,
  onTitleChange,
  isSelected = false,
}: AudioRendererProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [titleValue, setTitleValue] = useState(title);
  const [isPlaying, setIsPlaying] = useState(false);
  
  const handleTitleBlur = useCallback(() => {
    if (titleValue !== title && onTitleChange) {
      onTitleChange(titleValue);
    }
  }, [titleValue, title, onTitleChange]);
  
  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  }, []);
  
  const togglePlayback = useCallback(() => {
    if (!audioRef.current) return;
    
    if (audioRef.current.paused) {
      audioRef.current.play();
      setIsPlaying(true);
    } else {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  }, []);
  
  // Handle Space key when block is selected
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isSelected && e.key === ' ' && !e.repeat) {
        e.preventDefault();
        togglePlayback();
      }
    };
    
    if (isSelected) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isSelected, togglePlayback]);
  
  // Update playing state from audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);
    
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    
    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
    };
  }, []);
  
  return (
    <div className="audio-renderer">
      {/* Audio player */}
      <div className="audio-renderer__player">
        <audio
          ref={audioRef}
          src={assetUrl}
          controls
          className="audio-renderer__element"
          preload="metadata"
        >
          <source src={assetUrl} type={mimeType} />
          Your browser does not support the audio element.
        </audio>
      </div>
      
      {/* Title */}
      <div className="audio-renderer__title">
        {editable ? (
          <input
            type="text"
            className="audio-renderer__title-input"
            value={titleValue}
            onChange={(e) => setTitleValue(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            placeholder="Add title..."
          />
        ) : (
          <div className="audio-renderer__title-text">{title || 'Untitled'}</div>
        )}
      </div>
      
      {/* Hint for space key */}
      {isSelected && (
        <div className="audio-renderer__hint">
          Press <kbd>Space</kbd> to {isPlaying ? 'pause' : 'play'}
        </div>
      )}
    </div>
  );
}
