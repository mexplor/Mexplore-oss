import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: `bun run start -- --config …` serves the API on 43190; `bun run dev:web` proxies /api to it.
// Prod: `bun run build` writes dist/, which the Bun server serves itself.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5190,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:43190', changeOrigin: false } },
  },
})
