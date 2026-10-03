import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },
  build: {
    // Split large vendor libs for caching
    chunkSizeWarningLimit: 1100,
    rollupOptions: { output: { manualChunks: { maplibre: ['maplibre-gl'], react: ['react', 'react-dom'] } } },
  },
});
