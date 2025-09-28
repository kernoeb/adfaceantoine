import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import zipPack from 'vite-plugin-zip-pack'

export default defineConfig({
  plugins: [
    tailwindcss(),
    vue(),
    zipPack({
      outDir: '.',
      outFileName: 'adfaceantoine.zip',
    }),
  ],
})
