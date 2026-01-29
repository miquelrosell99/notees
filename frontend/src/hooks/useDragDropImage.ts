/**
 * Hook for handling drag and drop of images from files or URLs
 * 
 * Supports:
 * - Local files from file explorer
 * - Images dragged from websites (extracts from HTML)
 * - Direct image URLs
 */
import { useCallback } from 'react';

export interface ImageDropResult {
  file: File;
  source: 'file' | 'url';
}

export interface UseDragDropImageOptions {
  onDrop?: (result: ImageDropResult) => void;
  onError?: (error: string) => void;
}

/**
 * Extract image file from drag event
 * Handles both local files and images from URLs
 */
export async function extractImageFromDragEvent(e: React.DragEvent): Promise<ImageDropResult | null> {
  // Try to get files first (local drag)
  const files = Array.from(e.dataTransfer.files);
  const imageFile = files.find(file => file.type.startsWith('image/'));
  
  if (imageFile) {
    return { file: imageFile, source: 'file' };
  }
  
  // Try to get image URL (drag from web)
  const html = e.dataTransfer.getData('text/html');
  const urlList = e.dataTransfer.getData('text/uri-list');
  const plainText = e.dataTransfer.getData('text/plain');
  
  let imageUrl: string | null = null;
  
  // Extract image URL from HTML
  if (html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const img = doc.querySelector('img');
    if (img?.src) {
      imageUrl = img.src;
    }
  }
  
  // Try direct URL
  if (!imageUrl) {
    const url = urlList || plainText;
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      imageUrl = url;
    }
  }
  
  // Fetch and convert the image from URL
  if (imageUrl) {
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    const fileName = imageUrl.split('/').pop()?.split('?')[0] || 'image.jpg';
    const file = new File([blob], fileName, { type: blob.type });
    return { file, source: 'url' };
  }
  
  return null;
}

/**
 * Hook that provides drag and drop handlers for images
 */
export function useDragDropImage(options?: UseDragDropImageOptions) {
  const { onDrop, onError } = options ?? {};
  
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!onDrop) return;
    
    try {
      const result = await extractImageFromDragEvent(e);
      if (result) {
        onDrop(result);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to process dropped image';
      if (onError) {
        onError(message);
      }
      console.error('Drag drop error:', error);
    }
  }, [onDrop, onError]);
  
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);
  
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);
  
  return {
    handleDrop,
    handleDragOver,
    handleDragLeave,
  };
}
