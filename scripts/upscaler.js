import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import sharp from 'sharp'

const srcFolder = 'wplace_tiles'
const upscaleFactor = 4
const concurrency = 5 // images processed at the same time

async function getAllPngFiles(folder) {
  let files = []
  const entries = await readdir(folder, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(folder, entry.name)
    if (entry.isDirectory()) {
      files = files.concat(await getAllPngFiles(fullPath))
    } else if (
      extname(entry.name).toLowerCase() === '.png'
      && !entry.name.includes('_upscaled')
    ) {
      files.push(fullPath)
    }
  }
  return files
}

async function upscaleFile(file) {
  const outPath = join(dirname(file), `${basename(file, '.png')}_upscaled.png`)
  const img = sharp(file)
  const metadata = await img.metadata()

  await img
    .resize({
      width: metadata.width * upscaleFactor,
      height: metadata.height * upscaleFactor,
      kernel: sharp.kernel.nearest,
    })
    .toFile(outPath)

  return file
}

async function processFilesInChunks(files, chunkSize) {
  let processed = 0
  const total = files.length

  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize)
    await Promise.all(
      chunk.map(async (file) => {
        await upscaleFile(file)
        processed++
        const percent = ((processed / total) * 100).toFixed(1)
        console.log(`Progress: ${percent}% (${processed}/${total})`)
      }),
    )
  }
}

(async () => {
  try {
    const files = await getAllPngFiles(srcFolder)
    console.log(`Found ${files.length} PNGs to upscale.`)
    await processFilesInChunks(files, concurrency)
    console.log('All PNGs upscaled!')
  } catch (err) {
    console.error(err)
  }
})()
