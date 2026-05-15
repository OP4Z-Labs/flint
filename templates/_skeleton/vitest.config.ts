/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Vitest gets its own config without the @tailwindcss/vite plugin and
// the PWA plugin — the production vite.config.ts conflicts with vitest's
// internal resolution.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      exclude: ['src/main.tsx', '**/*.d.ts', '**/*.test.{ts,tsx}'],
    },
  },
})
