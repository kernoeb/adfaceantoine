/* global Bun */
import { cp, rm } from 'node:fs/promises'
import { $ } from 'bun'

Bun.env.NODE_ENV = Bun.env.NODE_ENV || 'production'

const outdir = './dist'

// Clean the output directory before building
await rm(outdir, { recursive: true, force: true })

// Remove existing zip file if it exists
await rm('./adfaceantoine.zip', { force: true })

await Bun.build({
  entrypoints: ['./index.html'],
  outdir,
  minify: true,
  define: {
    __BUILD__: 'true',
  },
})

// Copy wplace_tiles directory
await cp('./wplace_tiles', `${outdir}/wplace_tiles`, { recursive: true })

console.log('Build completed successfully.')

// Zip the output directory
console.log('Zipping the output directory...')
await $`cd ${outdir} && zip -q -r ../adfaceantoine.zip .`
console.log('Output directory zipped successfully.')
