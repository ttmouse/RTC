import { defineConfig } from 'vite';

export default defineConfig({
  base: '/meeting-board/',
  build: {
    outDir: '../dist/meeting-board',
    emptyOutDir: true,
  },
});