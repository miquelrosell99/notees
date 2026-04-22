/**
 * useAndroidBridge — two-way bridge between the web app and the Android shell.
 *
 * Native → Web surface: `window.noteesBridge`
 *   The Android WebView calls methods on this object from Kotlin via
 *   webView.evaluateJavascript("window.noteesBridge.onShareReceived(…)").
 *
 * Web → Native surface: `window.Android`
 *   The web app calls window.Android.* which are handled by AndroidBridge.kt.
 *
 * Usage
 *   Call `useAndroidBridge()` once at the MobileLayout root.
 *   It registers the bridge and returns feature-detection helpers.
 */
import { useEffect } from 'react';
import { useNavigationStore } from '@/stores';

// ── Type declarations ─────────────────────────────────────────────────────────

/** Methods callable from JS into the Android layer (window.Android). */
interface AndroidNativeApi {
  isNativeApp(): boolean;
  openDrawer(): void;
  closeDrawer(): void;
  setDrawerOpen(open: boolean): void;
  isDrawerOpen(): boolean;
  shareText(text: string): void;
  openUrl(url: string): void;
  showServerSettings(): void;
}

/** Methods the Android layer calls into the web app (window.noteesBridge). */
interface NoteesWebBridge {
  /** Android received a Share intent — show quick-capture UI. */
  onShareReceived(text: string): void;
  /** Android received a deep link — navigate to that path. */
  onDeepLink(path: string): void;
  /** Android wants to open the quick-note view. */
  openQuickNote(): void;
  /** Android wants to open the sidebar drawer. */
  openDrawer(): void;
  /** Android wants to close the sidebar drawer. */
  closeDrawer(): void;
}

declare global {
  interface Window {
    Android?: AndroidNativeApi;
    noteesBridge?: NoteesWebBridge;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns true when running inside the Notees Android WebView wrapper. */
export function isAndroidApp(): boolean {
  return typeof window !== 'undefined' && window.Android?.isNativeApp() === true;
}

/**
 * Registers `window.noteesBridge` and wires it up to the Zustand navigation
 * store. Call this once at the mobile layout root.
 */
export function useAndroidBridge() {
  const toggleSidebar = useNavigationStore(s => s.toggleSidebar);
  const isSidebarCollapsed = useNavigationStore(s => s.isSidebarCollapsed);
  const openNode = useNavigationStore(s => s.openNode);
  const setMainViewType = useNavigationStore(s => s.setMainViewType);

  useEffect(() => {
    if (!isAndroidApp()) return;

    // Tell CSS that native padding already handles system bar insets so
    // env(safe-area-inset-*) rules should not be applied on top.
    document.documentElement.classList.add('android-app');

    window.noteesBridge = {
      onShareReceived(text: string) {
        // Fire a custom DOM event — the quick-capture UI listens to this
        window.dispatchEvent(
          new CustomEvent('notees:share-received', { detail: { text } }),
        );
      },

      onDeepLink(path: string) {
        // Route to the path — parse node id from /node/42 etc.
        const nodeMatch = path.match(/^\/node\/(\d+)/);
        if (nodeMatch) {
          const id = parseInt(nodeMatch[1], 10);
          if (Number.isFinite(id)) openNode(id);
          return;
        }

        // Map known view routes
        const viewRoutes: Record<string, Parameters<typeof setMainViewType>[0]> = {
          '/journal': 'journals',
          '/graph': 'graph',
          '/pages': 'all-pages',
          '/terrain': 'terrain',
          '/timeline': 'timeline',
          '/archived': 'archived',
          '/trash': 'trash',
          '/assets': 'assets',
        };
        for (const [prefix, viewType] of Object.entries(viewRoutes)) {
          if (path.startsWith(prefix)) {
            setMainViewType(viewType);
            return;
          }
        }

        // Unknown path — fall back to journals
        console.warn('[noteesBridge] unhandled deep link:', path);
        setMainViewType('journals');
      },

      openQuickNote() {
        // Navigate to journals view — the daily note acts as quick capture
        setMainViewType('journals');
      },

      openDrawer() {
        if (isSidebarCollapsed) toggleSidebar();
      },

      closeDrawer() {
        if (!isSidebarCollapsed) toggleSidebar();
      },
    };

    return () => {
      // Don't delete — Android may call into the bridge while this component
      // is unmounting during hot-update. Leave the stale reference harmless.
    };
  }, [toggleSidebar, isSidebarCollapsed, openNode, setMainViewType]);
}

/**
 * Notify the Android shell about the current drawer state so that
 * the native back-button handler stays in sync.
 */
export function reportDrawerStateToAndroid(open: boolean) {
  if (!isAndroidApp()) return;
  // Keep Android's `drawerOpen` flag in sync
  window.Android?.setDrawerOpen(open);
}
