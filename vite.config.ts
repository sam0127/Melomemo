/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      /*
       * 'prompt' rather than 'autoUpdate'. An automatic update can swap the
       * app's JavaScript out from under a recording in progress, or serve code
       * that predates the database it is now talking to. The user is asked
       * instead, and the app suppresses the prompt entirely while recording.
       */
      registerType: 'prompt',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'Melomemo',
        short_name: 'Melomemo',
        description:
          'Record and keep melody memos of your singing and whistling.',
        theme_color: '#9a3412',
        background_color: '#fbfaf8',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            // The artwork sits inside the middle 60%, so it survives masking.
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        /*
         * The app shell only. Recordings live in IndexedDB and never travel
         * over HTTP, so there is nothing for the service worker to cache and
         * no need for a range-request handler.
         */
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
