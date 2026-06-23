/*
 * vite.config.js — settings for "Vite", the tool that runs and builds this app.
 *
 * Vite is what `npm run dev` starts: it serves the app to your browser and
 * instantly updates it as you edit files. This config just turns on React
 * support and source maps (which make errors easier to trace while developing).
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],     // lets Vite understand React (.jsx) files
  css: {
    devSourcemap: true,   // helps pinpoint which CSS line caused something while developing
  },
});
