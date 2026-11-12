import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  build: {
    ssr: 'humo.js',
    outDir: '.humo',
    emptyOutDir: true,
    minify: false,
  },
});
