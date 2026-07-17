import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['notees-icon.svg', 'apple-touch-icon.png'],
      workbox: {
        importScripts: ['/sw-sync.js'],
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Don't precache large on-demand files:
        // - sql-wasm.wasm: loaded only for Logseq import
        // - mdi-sprite.svg: 3MB icon sprite; icons load on-demand via <use href>
        globIgnores: ['**/sql-wasm.wasm', '**/mdi-sprite.svg'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // 4 MB (covers the MDI SVG sprite sheet)
        runtimeCaching: [
          {
            // Never cache the health endpoint: the UI relies on live
            // reachability checks to lock/unlock the overlay.
            urlPattern: /^https?:\/\/.*\/api\/health$/,
            handler: 'NetworkOnly',
          },
          {
            // Cache API responses with network-first strategy
            urlPattern: /^https?:\/\/.*\/api\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: { maxEntries: 100, maxAgeSeconds: 300 },
              networkTimeoutSeconds: 3,
            },
          },
          {
            // Cache the WASM binary
            urlPattern: /sql-wasm\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-cache',
              expiration: { maxEntries: 1, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
          {
            // Cache uploaded asset files (images, PDFs, etc.)
            urlPattern: /\/api\/assets\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'assets-cache',
              expiration: { maxEntries: 200, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
        ],
      },
      manifest: {
        name: 'Notees',
        short_name: 'Notees',
        description: 'A self-hosted knowledge management system',
        theme_color: '#121211',
        background_color: '#f5f3ef',
        display: 'standalone',
        orientation: 'any',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        share_target: {
          action: '/?shared=true',
          method: 'GET',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@/types': path.resolve(__dirname, './src/types'),
      '@/components': path.resolve(__dirname, './src/components'),
      '@/hooks': path.resolve(__dirname, './src/hooks'),
      '@/stores': path.resolve(__dirname, './src/stores'),
      '@/api': path.resolve(__dirname, './src/api'),
      '@/core': path.resolve(__dirname, './src/core'),
      '@/editor': path.resolve(__dirname, './src/editor'),
      '@/runtime': path.resolve(__dirname, './src/runtime'),
    },
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
    // Restrict to known local dev hosts. To expose the dev server to a remote
    // host (e.g., for LAN testing), set the VITE_ALLOWED_HOSTS env variable to
    // a comma-separated list of hostnames, or run with --host <hostname>.
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(',')
      : ['localhost', '127.0.0.1'],
    cors: false,
    // COOP/COEP are disabled in dev because they break module-worker loading
    // in some Firefox configurations. SharedArrayBuffer-dependent features are
    // tested in production builds instead.
    // headers: {
    //   'Cross-Origin-Opener-Policy': 'same-origin',
    //   'Cross-Origin-Embedder-Policy': 'require-corp',
    // },
    // Proxy API requests (including WebSockets) to the FastAPI backend.
    // Docker Compose dev sets VITE_API_PROXY_TARGET to the backend service.
    // For local development outside Docker, the default is localhost:8001.
    proxy: {
      // Proxy API requests (including WebSockets) to the FastAPI backend
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:8001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    // Output to the static folder for production
    outDir: '../app/static/dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // Split heavy vendor libraries into separate cacheable chunks
          if (id.includes('node_modules/@dnd-kit/')) {
            return 'vendor-dnd'
          }
          if (id.includes('node_modules/@tanstack/')) {
            return 'vendor-query'
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react'
          }
          if (id.includes('node_modules/axios')) {
            return 'vendor-http'
          }
          if (id.includes('node_modules/zustand')) {
            return 'vendor-state'
          }
        },
      },
    },
  },
})
