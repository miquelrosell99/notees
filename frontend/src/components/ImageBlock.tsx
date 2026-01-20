/**
 * ImageBlock - Component for displaying uploaded images
 * 
 * Renders an image from the assets API with optional caption.
 */
import { useState } from 'react';
import './ImageBlock.css';
import { getAssetUrl, deleteAsset } from '@/api';
import { TrashIcon } from './icons';

interface ImageBlockProps {
  /** The asset UUID */
  assetUuid: string;
  /** Optional alt text */
  alt?: string;
  /** Optional caption */
  caption?: string;
  /** Whether the image can be deleted */
  canDelete?: boolean;
  /** Callback when deleted */
  onDelete?: () => void;
  /** Callback when clicked */
  onClick?: () => void;
}

export function ImageBlock({
  assetUuid,
  alt = 'Uploaded image',
  caption,
  canDelete = false,
  onDelete,
  onClick,
}: ImageBlockProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [hasError, setHasError] = useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onDelete || isDeleting) return;

    if (!confirm('Delete this image?')) return;

    setIsDeleting(true);
    try {
      await deleteAsset(assetUuid);
      onDelete();
    } catch (error) {
      console.error('Failed to delete image:', error);
      setIsDeleting(false);
    }
  };

  if (hasError) {
    return (
      <div className="image-block image-block--error">
        <span>Failed to load image</span>
      </div>
    );
  }

  return (
    <div
      className="image-block"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onClick}
    >
      <img
        src={getAssetUrl(assetUuid)}
        alt={alt}
        className="image-block__image"
        onError={() => setHasError(true)}
      />
      
      {caption && (
        <div className="image-block__caption">{caption}</div>
      )}
      
      {canDelete && isHovered && (
        <button
          className="image-block__delete"
          onClick={handleDelete}
          disabled={isDeleting}
          title="Delete image"
        >
          <TrashIcon size="sm" />
        </button>
      )}
    </div>
  );
}

export default ImageBlock;
