import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/jsqr/')) return 'qr-reader';
          if (id.includes('/qrcode/')) return 'qr-generator';
          if (
            id.includes('/@codemirror/') ||
            id.includes('/y-codemirror') ||
            id.includes('/yjs/') ||
            id.includes('/y-protocols/') ||
            id.includes('/lib0/')
          )
            return 'editor';
        },
      },
    },
  },
});
