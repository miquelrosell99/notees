/**
 * AssetUploadModal - Modal for uploading assets (images, audio, files)
 * 
 * Supports drag-and-drop or click-to-select file upload.
 * Validates file type and size (max 50MB).
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { mdiClose } from '@mdi/js';
import { uploadAsset, isSupportedAssetType, getAssetCategory, MAX_ASSET_SIZE, type Asset, type AssetCategory } from '@/api/assets';
import { Button } from '../core/Button';
import './AssetUploadModal.css';

interface AssetUploadModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback when modal is closed */
  onClose: () => void;
  /** Callback when upload completes successfully */
  onUpload: (asset: Asset) => void;
  /** Optional parent node ID for the asset */
  parentId?: number;
  /** Optional existing node ID to convert to asset (for empty blocks) */
  existingNodeId?: number;
  /** Optional filter to limit accepted asset types */
  acceptedTypes?: AssetCategory[];
  /** Optional initial file to upload (e.g. from paste) */
  initialFile?: File | null;
}

// Icon components for different asset types
function ImageIconLarge() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/>
      <polyline points="21 15 16 10 5 21"/>
    </svg>
  );
}

function AudioIconLarge() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>
  );
}

function FileIconLarge() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function getAcceptString(acceptedTypes?: AssetCategory[]): string {
  const types: string[] = [];
  
  if (!acceptedTypes || acceptedTypes.includes('image')) {
    types.push('image/jpeg', 'image/png', 'image/webp');
  }
  if (!acceptedTypes || acceptedTypes.includes('audio')) {
    types.push('audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/opus', 'audio/webm');
  }
  
  return types.join(',');
}

function getFormatText(acceptedTypes?: AssetCategory[]): string {
  const formats: string[] = [];
  
  if (!acceptedTypes || acceptedTypes.includes('image')) {
    formats.push('JPEG, PNG, WebP');
  }
  if (!acceptedTypes || acceptedTypes.includes('audio')) {
    formats.push('MP3, WAV, OGG, OPUS, WebM');
  }
  
  return formats.join(', ');
}

export function AssetUploadModal({
  isOpen,
  onClose,
  onUpload,
  parentId,
  existingNodeId,
  acceptedTypes,
  initialFile,
}: AssetUploadModalProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<AssetCategory | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const validateFile = (file: File): string | null => {
    if (!isSupportedAssetType(file.type)) {
      return 'Unsupported file type.';
    }
    
    const category = getAssetCategory(file.type);
    if (acceptedTypes && !acceptedTypes.includes(category)) {
      return `Only ${acceptedTypes.join(' and ')} files are accepted.`;
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
    
    const category = getAssetCategory(file.type);
    setPreviewType(category);

    // Create preview
    const reader = new FileReader();
    reader.onload = (e) => {
      setPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  }, [acceptedTypes]);

  // Handle initial file (e.g. from paste)
  useEffect(() => {
    if (isOpen && initialFile) {
      handleFile(initialFile);
    }
  }, [isOpen, initialFile, handleFile]);

  // Handle paste events
  useEffect(() => {
    if (!isOpen) return;

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.indexOf('image') !== -1) {
          const file = item.getAsFile();
          if (file) {
            handleFile(file);
            e.preventDefault();
            break;
          }
        }
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [isOpen, handleFile]);

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
      const asset = await uploadAsset(selectedFile, parentId, existingNodeId);
      onUpload(asset);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload file');
      setIsUploading(false);
    }
  };

  const handleClose = () => {
    setSelectedFile(null);
    setPreview(null);
    setPreviewType(null);
    setError(null);
    setIsDragging(false);
    setIsUploading(false);
    onClose();
  };

  const handleBrowseClick = () => {
    fileInputRef.current?.click();
  };

  const handleClearSelection = () => {
    setSelectedFile(null);
    setPreview(null);
    setPreviewType(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Determine which icon to show based on accepted types
  const getDropzoneIcon = () => {
    if (acceptedTypes?.length === 1) {
      if (acceptedTypes[0] === 'image') return <ImageIconLarge />;
      if (acceptedTypes[0] === 'audio') return <AudioIconLarge />;
    }
    return <FileIconLarge />;
  };

  const getModalTitle = () => {
    if (acceptedTypes?.length === 1) {
      if (acceptedTypes[0] === 'image') return 'Upload Image';
      if (acceptedTypes[0] === 'audio') return 'Upload Audio';
    }
    return 'Upload Asset';
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal asset-upload-modal" onClick={e => e.stopPropagation()}>
        <div className="modal__header">
          <h2>{getModalTitle()}</h2>
          <Button icon={mdiClose} iconOnly className="modal__close" onClick={handleClose} size="sm" variant="ghost" />
        </div>

        <div className="modal__content">
          {!preview ? (
            <div
              className={`asset-upload-modal__dropzone ${isDragging ? 'asset-upload-modal__dropzone--dragging' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={handleBrowseClick}
            >
              {getDropzoneIcon()}
              <p>Drag and drop a file here</p>
              <p className="asset-upload-modal__hint">or click to browse, or paste from clipboard</p>
              <p className="asset-upload-modal__formats">
                Supported formats: {getFormatText(acceptedTypes)} (max 50MB)
              </p>
            </div>
          ) : (
            <div className="asset-upload-modal__preview">
              {previewType === 'image' && preview && (
                <img src={preview} alt="Preview" className="asset-upload-modal__preview-image" />
              )}
              {previewType === 'audio' && preview && (
                <div className="asset-upload-modal__preview-audio">
                  <AudioIconLarge />
                  <audio ref={audioRef} src={preview} controls />
                </div>
              )}
              {previewType === 'file' && (
                <div className="asset-upload-modal__preview-file">
                  <FileIconLarge />
                </div>
              )}
              <p className="asset-upload-modal__filename">{selectedFile?.name}</p>
              <p className="asset-upload-modal__filesize">
                {selectedFile && `${(selectedFile.size / 1024).toFixed(1)} KB`}
              </p>
              <Button 
                variant="ghost"
                size="sm"
                className="asset-upload-modal__clear"
                onClick={(e) => { e.stopPropagation(); handleClearSelection(); }}
              >
                Choose different file
              </Button>
            </div>
          )}

          {error && (
            <div className="asset-upload-modal__error">
              {error}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept={getAcceptString(acceptedTypes)}
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

export default AssetUploadModal;
