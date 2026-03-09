import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@/types': path.resolve(__dirname, './src/types'),
      '@/components': path.resolve(__dirname, './src/components'),
      '@/hooks': path.resolve(__dirname, './src/hooks'),
      '@/stores': path.resolve(__dirname, './src/stores'),
      '@/api': path.resolve(__dirname, './src/api'),
      '@/editor': path.resolve(__dirname, './src/editor'),
      '@/runtime': path.resolve(__dirname, './src/runtime'),
    },
  },
  server: {
    port: 5173,
    allowedHosts: ['atlas'],
    // Required for SharedArrayBuffer (crossOriginIsolated = true)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Enable polling for Docker on Windows
    watch: {
      usePolling: true,
      interval: 1000,
    },
    proxy: {
      // Proxy API requests to the FastAPI backend
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Output to the static folder for production
    outDir: '../app/static/dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Split heavy vendor libraries into separate cacheable chunks
          if (id.includes('node_modules/lexical') || id.includes('node_modules/@lexical/')) {
            return 'vendor-lexical';
          }
          if (id.includes('node_modules/@dnd-kit/')) {
            return 'vendor-dnd';
          }
          if (id.includes('node_modules/@tanstack/')) {
            return 'vendor-query';
          }
          if (id.includes('node_modules/@mdi/')) {
            return 'vendor-icons';
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react';
          }
        },
      },
    },
  },
})
