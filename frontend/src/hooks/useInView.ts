import { useEffect, useRef, useState, useCallback } from 'react';

interface UseInViewOptions {
  /** Margin around the root to trigger early (default: '200px') */
  rootMargin?: string;
  /** Threshold of visibility needed to trigger (default: 0) */
  threshold?: number;
  /** Whether to keep observing after first intersection (default: false) */
  once?: boolean;
}

/**
 * Hook that reports whether an element is in the viewport.
 * Uses IntersectionObserver for efficient detection.
 */
export function useInView(options: UseInViewOptions = {}) {
  const { rootMargin = '200px', threshold = 0, once = true } = options;
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  const handleIntersection = useCallback(
    (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setInView(true);
          if (once) {
            observer.unobserve(entry.target);
          }
        } else if (!once) {
          setInView(false);
        }
      }
    },
    [once]
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(handleIntersection, {
      rootMargin,
      threshold,
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin, threshold, handleIntersection]);

  return { ref, inView };
}
