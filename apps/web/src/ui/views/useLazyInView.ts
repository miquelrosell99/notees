/**
 * useLazyInView — the image lazy-loading gate.
 *
 * Cards render their imagery placeholder immediately; the EXPENSIVE part
 * (the full-bytes fetch + base64 + decode per cover) starts only when the
 * card nears the viewport. An IntersectionObserver flips `inView` true on
 * the first intersection and it stays true — loaded content never unloads
 * on scroll-away (the session cache keeps the data URL alive either way).
 *
 * jsdom honesty: when IntersectionObserver is unavailable (the test
 * environment), `inView` starts true so surfaces render eagerly — the
 * lazy gate is a viewport concern, not a correctness gate, and tests assert
 * content, not scroll position.
 */

import { useEffect, useRef, useState, type RefCallback } from "react";

/**
 * Returns `[ref, inView]`. Attach `ref` to the element whose visibility
 * gates the expensive work. `rootMargin` preloads slightly below the fold
 * (default one viewport-ish band so scrolling feels instant).
 */
export function useLazyInView<T extends HTMLElement>(
  rootMargin = "600px 0px",
): [RefCallback<T>, boolean] {
  const [inView, setInView] = useState<boolean>(
    typeof IntersectionObserver === "undefined",
  );
  const observerRef = useRef<IntersectionObserver | null>(null);
  const nodeRef = useRef<T | null>(null);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const ref: RefCallback<T> = (node) => {
    nodeRef.current = node;
    if (node === null || inView) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    observerRef.current?.disconnect();
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observerRef.current = observer;
    observer.observe(node);
  };

  // Once true, stay true — never re-observe, never unload.
  return [ref, inView];
}
