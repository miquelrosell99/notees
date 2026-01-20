/**
 * ImageUploadModal - Modal for uploading images
 * 
 * Supports drag-and-drop or click-to-select file upload.
 * Validates file type (JPEG, PNG only) and size (max 10MB).
 */
import { useState, useRef, useCallback } from 'react';
import './ImageUploadModal.css';
import { uploadAsset, isSupportedAssetType, MAX_ASSET_SIZE, type Asset } from '@/api';
import { ImageIcon } from './icons';
import { ButtonClose } from './core/ButtonClose';
import { Button } from './core/Button';

interface ImageUploadModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal is closed */
  onClose: () => void;
  /** Callback when upload completes successfully */
  onUpload: (asset: Asset) => void;
  /** Optional parent node ID for the asset */
  parentId?: number;
}

export function ImageUploadModal({
  isOpen,
  onClose,
  onUpload,
  parentId,
}: ImageUploadModalProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateFile = (file: File): string | null => {
    if (!isSupportedAssetType(file.type)) {
      return 'Unsupported file type. Only JPEG, PNG, and WebP are allowed.';
    }
    if (file.size > MAX_ASSET_SIZE) {
      return `File too large. Maximum size is ${MAX_ASSET_SIZE / (1024 * 1024)}MB.`;
    }
    return null;
  };

  const handleFile = useCallback((file: File) => {
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setSelectedFile(file);

    // Create preview
    const reader = new FileReader();
    reader.onload = (e) => {
      setPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file) {
      handleFile(file);
    }
  }, [handleFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
  }, [handleFile]);

  const handleUpload = async () => {
    if (!selectedFile) return;

    setIsUploading(true);
    setError(null);

    try {
      const asset = await uploadAsset(selectedFile, parentId);
      onUpload(asset);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload image');
      setIsUploading(false);
    }
  };

  const handleClose = () => {
    setSelectedFile(null);
    setPreview(null);
    setError(null);
    setIsDragging(false);
    setIsUploading(false);
    onClose();
  };

  const handleBrowseClick = () => {
    fileInputRef.current?.click();
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal image-upload-modal" onClick={e => e.stopPropagation()}>
        <div className="modal__header">
          <h2>Upload Image</h2>
          <ButtonClose className="modal__close" onClick={handleClose} size="sm" />
        </div>

        <div className="modal__content">
          {!preview ? (
            <div
              className={`image-upload-modal__dropzone ${isDragging ? 'image-upload-modal__dropzone--dragging' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={handleBrowseClick}
            >
              <ImageIcon size="lg" />
              <p>Drag and drop an image here</p>
              <p className="image-upload-modal__hint">or click to browse</p>
              <p className="image-upload-modal__formats">
                Supported formats: JPEG, PNG (max 10MB)
              </p>
            </div>
          ) : (
            <div className="image-upload-modal__preview">
              <img src={preview} alt="Preview" />
              <p className="image-upload-modal__filename">{selectedFile?.name}</p>
            </div>
          )}

          {error && (
            <div className="image-upload-modal__error">
              {error}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
        </div>

        <div className="modal__footer">
          <Button
            variant="default"
            onClick={handleClose}
            disabled={isUploading}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleUpload}
            disabled={!selectedFile || isUploading}
          >
            {isUploading ? 'Uploading...' : 'Upload'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ImageUploadModal;
