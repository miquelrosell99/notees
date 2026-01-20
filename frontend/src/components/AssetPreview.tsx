/**
 * AssetPreview component.
 * 
 * Renders different preview elements based on asset type (image, audio, etc).
 */
import { useState, useRef, useEffect } from 'react';
import { getAssetUrl, type Asset, type AssetCategory } from '../api/assets';
import { Button } from './core/Button';
import { getLogger } from '../utils/logger';
import './AssetPreview.css';

const log = getLogger('asset-preview');

interface AssetPreviewProps {
  /** Asset data or UUID */
  asset: Asset | string;
  /** Asset category (required if passing UUID string) */
  category?: AssetCategory;
  /** Content type (required if passing UUID string) */
  contentType?: string;
  /** Optional alt text for images */
  alt?: string;
  /** Whether to show controls (for audio) */
  controls?: boolean;
  /** Whether the asset can be resized */
  resizable?: boolean;
  /** Current width (for resizable assets) */
  width?: number;
  /** Current height (for resizable assets) */
  height?: number;
  /** Callback when asset is resized */
  onResize?: (width: number, height: number) => void;
  /** Callback when asset is clicked */
  onClick?: () => void;
  /** Whether the asset is selected */
  selected?: boolean;
}

/**
 * ImagePreview sub-component.
 */
function ImagePreview({
  src,
  alt,
  resizable,
  width,
  height,
  onResize,
  onClick,
  selected,
}: {
  src: string;
  alt: string;
  resizable?: boolean;
  width?: number;
  height?: number;
  onResize?: (width: number, height: number) => void;
  onClick?: () => void;
  selected?: boolean;
}) {
  const [isResizing, setIsResizing] = useState(false);
  const [currentWidth, setCurrentWidth] = useState(width);
  const [currentHeight, setCurrentHeight] = useState(height);
  const imageRef = useRef<HTMLImageElement>(null);
  const startPos = useRef({ x: 0, y: 0, width: 0, height: 0 });

  useEffect(() => {
    setCurrentWidth(width);
    setCurrentHeight(height);
  }, [width, height]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!resizable) return;
    e.preventDefault();
    e.stopPropagation();
    
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect) return;

    setIsResizing(true);
    startPos.current = {
      x: e.clientX,
      y: e.clientY,
      width: rect.width,
      height: rect.height,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startPos.current.x;
      const aspectRatio = startPos.current.height / startPos.current.width;
      const newWidth = Math.max(100, startPos.current.width + deltaX);
      const newHeight = newWidth * aspectRatio;
      
      setCurrentWidth(newWidth);
      setCurrentHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      
      if (onResize && currentWidth && currentHeight) {
        onResize(currentWidth, currentHeight);
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div 
      className={`asset-preview-image ${selected ? 'selected' : ''} ${isResizing ? 'resizing' : ''}`}
      onClick={onClick}
    >
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        style={{
          width: currentWidth ? `${currentWidth}px` : undefined,
          height: currentHeight ? `${currentHeight}px` : undefined,
        }}
      />
      {resizable && (
        <div 
          className="resize-handle"
          onMouseDown={handleMouseDown}
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M10 2L2 10M10 6L6 10M10 10L10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
      )}
    </div>
  );
}

/**
 * AudioPreview sub-component.
 */
function AudioPreview({
  src,
  controls = true,
  onClick,
  selected,
}: {
  src: string;
  controls?: boolean;
  onClick?: () => void;
  selected?: boolean;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div 
      className={`asset-preview-audio ${selected ? 'selected' : ''}`}
      onClick={onClick}
    >
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
      />
      {controls && (
        <div className="audio-controls">
          <Button 
            variant="ghost"
            size="xs"
            className="audio-play-btn"
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1"/>
                <rect x="14" y="4" width="4" height="16" rx="1"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
            )}
          </Button>
          <span className="audio-time">{formatTime(currentTime)}</span>
          <input
            type="range"
            className="audio-progress"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            onChange={handleSeek}
          />
          <span className="audio-time">{formatTime(duration)}</span>
        </div>
      )}
    </div>
  );
}

/**
 * FilePreview sub-component (for unsupported types).
 */
function FilePreview({
  src,
  filename,
  onClick,
  selected,
}: {
  src: string;
  filename?: string;
  onClick?: () => void;
  selected?: boolean;
}) {
  return (
    <div 
      className={`asset-preview-file ${selected ? 'selected' : ''}`}
      onClick={onClick}
    >
      <div className="file-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      <span className="file-name">{filename || 'File'}</span>
      <a 
        href={src} 
        download 
        className="file-download"
        onClick={(e) => e.stopPropagation()}
      >
        Download
      </a>
    </div>
  );
}

/**
 * Main AssetPreview component.
 */
export function AssetPreview({
  asset,
  category: propCategory,
  contentType: _propContentType,
  alt,
  controls = true,
  resizable = false,
  width,
  height,
  onResize,
  onClick,
  selected = false,
}: AssetPreviewProps) {
  // Determine UUID and properties from asset
  const uuid = typeof asset === 'string' ? asset : asset.uuid;
  const category = propCategory ?? (typeof asset === 'object' ? asset.category : 'file');
  const filename = typeof asset === 'object' ? asset.filename : undefined;
  
  const src = getAssetUrl(uuid);

  log.debug(`Rendering asset preview: ${uuid} (${category})`);

  switch (category) {
    case 'image':
      return (
        <ImagePreview
          src={src}
          alt={alt || filename || 'Image'}
          resizable={resizable}
          width={width}
          height={height}
          onResize={onResize}
          onClick={onClick}
          selected={selected}
        />
      );
    
    case 'audio':
      return (
        <AudioPreview
          src={src}
          controls={controls}
          onClick={onClick}
          selected={selected}
        />
      );
    
    default:
      return (
        <FilePreview
          src={src}
          filename={filename}
          onClick={onClick}
          selected={selected}
        />
      );
  }
}

export default AssetPreview;
