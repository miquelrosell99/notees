/**
 * LazyImage Component
 * 
 * A performance-optimized image component that:
 * - Loads images only when visible in the viewport (IntersectionObserver)
 * - Shows a skeleton placeholder until loaded
 * - Prevents layout shifts with explicit dimensions
 * - Supports native lazy loading as a fallback
 * - Caches loaded state to prevent re-triggering
 * 
 * Performance Benefits:
 * - Reduces initial page load time by deferring off-screen images
 * - Decreases memory usage by not loading images until needed
 * - Prevents layout shifts with proper placeholder sizing
 * 
 * Usage:
 * ```tsx
 * <LazyImage
 *   src={getAssetUrl(uuid)}
 *   alt="Description"
 *   width={400}
 *   height={300}
 *   className="my-image"
 * />
 * ```
 */
import { useState, useRef, useEffect, useCallback, memo } from 'react';
import './LazyImage.css';

export interface LazyImageProps {
  /** Image source URL */
  src: string;
  /** Alt text for accessibility */
  alt: string;
  /** Expected width (for placeholder sizing and aspect ratio) */
  width?: number;
  /** Expected height (for placeholder sizing and aspect ratio) */
  height?: number;
  /** Aspect ratio (alternative to explicit width/height, e.g., "16/9") */
  aspectRatio?: string;
  /** Additional CSS class */
  className?: string;
  /** Object-fit CSS property */
  objectFit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  /** Object-position CSS property */
  objectPosition?: string;
  /** Callback when image loads successfully */
  onLoad?: () => void;
  /** Callback when image fails to load */
  onError?: () => void;
  /** Click handler */
  onClick?: () => void;
  /** Root margin for IntersectionObserver (how early to start loading) */
  rootMargin?: string;
  /** Whether to use blur-up effect on load */
  blurUp?: boolean;
  /** Low-quality placeholder image URL for blur-up effect */
  placeholderSrc?: string;
  /** Priority loading - bypasses lazy loading for above-the-fold images */
  priority?: boolean;
}

// Cache of loaded image URLs to prevent re-triggering observers
const loadedImages = new Set<string>();

/**
 * LazyImage - Performance-optimized image with lazy loading and placeholders
 */
export const LazyImage = memo(function LazyImage({
  src,
  alt,
  width,
  height,
  aspectRatio,
  className = '',
  objectFit = 'cover',
  objectPosition = 'center',
  onLoad,
  onError,
  onClick,
  rootMargin = '100px', // Start loading 100px before visible
  blurUp = false,
  placeholderSrc,
  priority = false,
}: LazyImageProps) {
  // Skip lazy loading if already loaded or marked as priority
  const [isLoaded, setIsLoaded] = useState(() => priority || loadedImages.has(src));
  const [isVisible, setIsVisible] = useState(() => priority || loadedImages.has(src));
  const [hasError, setHasError] = useState(false);
  const [showPlaceholder, setShowPlaceholder] = useState(blurUp && !!placeholderSrc);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Set up IntersectionObserver to detect when image enters viewport
  useEffect(() => {
    // Skip if already visible or priority
    if (isVisible || priority || loadedImages.has(src)) {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      {
        rootMargin,
        threshold: 0,
      }
    );

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, [src, rootMargin, isVisible, priority]);

  // Handle successful image load
  const handleLoad = useCallback(() => {
    setIsLoaded(true);
    setShowPlaceholder(false);
    loadedImages.add(src);
    onLoad?.();
  }, [src, onLoad]);

  // Handle image load error
  const handleError = useCallback(() => {
    setHasError(true);
    setShowPlaceholder(false);
    onError?.();
  }, [onError]);

  // Compute container styles for placeholder sizing
  const containerStyle: React.CSSProperties = {};
  
  if (aspectRatio) {
    containerStyle.aspectRatio = aspectRatio;
  } else if (width && height) {
    containerStyle.aspectRatio = `${width} / ${height}`;
  }
  
  if (width) {
    containerStyle.maxWidth = width;
  }

  // Image styles
  const imageStyle: React.CSSProperties = {
    objectFit,
    objectPosition,
  };

  // Error state
  if (hasError) {
    return (
      <div
        ref={containerRef}
        className={`lazy-image lazy-image--error ${className}`}
        style={containerStyle}
        role="img"
        aria-label={alt}
      >
        <span className="lazy-image__error-text">Failed to load</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`lazy-image ${isLoaded ? 'lazy-image--loaded' : 'lazy-image--loading'} ${className}`}
      style={containerStyle}
      onClick={onClick}
    >
      {/* Skeleton placeholder - shown until image is loaded */}
      {!isLoaded && (
        <div className="lazy-image__skeleton" aria-hidden="true">
          <div className="lazy-image__skeleton-shimmer" />
        </div>
      )}

      {/* Blur-up placeholder image */}
      {showPlaceholder && placeholderSrc && (
        <img
          src={placeholderSrc}
          alt=""
          className="lazy-image__placeholder"
          aria-hidden="true"
          style={imageStyle}
        />
      )}

      {/* Actual image - only rendered when visible in viewport */}
      {isVisible && (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          className={`lazy-image__img ${isLoaded ? 'lazy-image__img--visible' : ''}`}
          style={imageStyle}
          onLoad={handleLoad}
          onError={handleError}
          // Native lazy loading as additional optimization
          loading={priority ? 'eager' : 'lazy'}
          // Decode async to avoid blocking main thread
          decoding="async"
        />
      )}
    </div>
  );
});

/**
 * Hook to preload an image into browser cache
 * Useful for prefetching images on hover
 */
export function useImagePreload() {
  const preloadedRef = useRef(new Set<string>());

  const preload = useCallback((src: string) => {
    if (preloadedRef.current.has(src) || loadedImages.has(src)) {
      return;
    }

    const img = new Image();
    img.src = src;
    preloadedRef.current.add(src);
    
    img.onload = () => {
      loadedImages.add(src);
    };
  }, []);

  return { preload };
}

export default LazyImage;
