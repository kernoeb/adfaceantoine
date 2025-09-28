import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import process from 'node:process'
import { fromLonLat } from 'ol/proj'
import { createXYZ } from 'ol/tilegrid'
import { ADCHAPO_GEOJSON_URL as GEOJSON_URL } from '../src/utils'

// Configuration
const WPLACE_BASE_URL = 'https://backend.wplace.live/files/s0/tiles'
const OUTPUT_DIR = 'public/wplace_tiles'
const CACHE_404_FILE = 'wplace_404_cache.json'
const DELAY_MS = 500
const DELAY_RATE_LIMIT_MS = 5000

// WPlace uses ONLY zoom level 11 (confirmed by wplace-scanner GitHub)
const WPLACE_ZOOM = 11

const HEADERS = {
  'accept': 'image/avif,image/webp,image/apng,*/*;q=0.8',
  'user-agent': 'Mozilla/5.0 (compatible; WPlace Line Tile Downloader)',
}

// 404 Cache management
let cache404 = new Set()
let needsSave = false

async function loadCache404() {
  try {
    if (existsSync(CACHE_404_FILE)) {
      const data = await Bun.file(CACHE_404_FILE).json()
      cache404 = new Set(data)
      console.log(`📋 Loaded ${cache404.size} known 404 tiles from cache`)
    }
  } catch (error) {
    console.warn('⚠️ Could not load 404 cache:', error.message)
  }
}

async function saveCache404() {
  if (!needsSave) return
  try {
    await Bun.write(CACHE_404_FILE, JSON.stringify([...cache404], null, 2))
    needsSave = false
    console.log(`💾 Saved ${cache404.size} 404 entries to cache`)
  } catch (error) {
    console.error('❌ Could not save 404 cache:', error.message)
  }
}

function setupGracefulShutdown() {
  const handleShutdown = async (signal) => {
    console.log(`\n🛑 Received ${signal}, saving cache and exiting...`)
    await saveCache404()
    console.log('💾 Cache saved. Goodbye!')
    process.exit(0)
  }
  process.on('SIGINT', handleShutdown)
  process.on('SIGTERM', handleShutdown)
  process.on('SIGHUP', handleShutdown)
}

// Convert lon/lat to XYZ tile coordinates at wplace zoom level
function lonLatToWplaceTile(lon, lat) {
  const webMercatorCoord = fromLonLat([lon, lat])
  const tileGrid = createXYZ({
    extent: [-20037508.342789244, -20037508.342789244, 20037508.342789244, 20037508.342789244],
    minZoom: 0,
    maxZoom: 18,
    tileSize: [256, 256],
  })

  const tileCoord = tileGrid.getTileCoordForCoordAndZ(webMercatorCoord, WPLACE_ZOOM)
  if (tileCoord) {
    const [z, x, y] = tileCoord
    const max = (1 << z) - 1
    if (x >= 0 && x <= max && y >= 0 && y <= max) {
      return { x, y, z }
    }
  }
  return null
}

// Get tiles for a line segment with adaptive sampling
function getTilesForLineSegment(startCoord, endCoord) {
  const tiles = new Set<string>()

  // Calculate distance and determine sampling points
  const dx = Math.abs(endCoord[0] - startCoord[0])
  const dy = Math.abs(endCoord[1] - startCoord[1])
  const maxDelta = Math.max(dx, dy)

  // More points for longer segments (in degrees)
  const numPoints = Math.max(2, Math.ceil(maxDelta * 1000)) // ~1 point per 0.001 degrees

  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints
    const lon = startCoord[0] + t * (endCoord[0] - startCoord[0])
    const lat = startCoord[1] + t * (endCoord[1] - startCoord[1])

    const tile = lonLatToWplaceTile(lon, lat)
    if (tile) {
      // Include the tile and its immediate neighbors (left/right of the line)
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          const x = tile.x + dx
          const y = tile.y + dy
          const max = (1 << WPLACE_ZOOM) - 1
          if (x >= 0 && x <= max && y >= 0 && y <= max) {
            tiles.add(`${x},${y}`)
          }
        }
      }
    }
  }

  return Array.from(tiles).map((s) => {
    const [x, y] = s.split(',').map(Number)
    return { x, y, z: WPLACE_ZOOM }
  })
}

async function extractTilesFromGeoJSON() {
  console.log('📡 Fetching GeoJSON from:', GEOJSON_URL)
  const response = await fetch(GEOJSON_URL)
  if (!response.ok) throw new Error(`Failed to fetch GeoJSON: ${response.statusText}`)

  const geojson = await response.json()
  console.log(`✅ GeoJSON loaded: ${geojson.features.length} features`)

  const allTiles = new Set<string>()
  let totalSegments = 0

  for (const feature of geojson.features) {
    const geom = feature.geometry
    if (!geom) continue

    let lineStrings: number[][][] = []
    if (geom.type === 'LineString') {
      lineStrings = [geom.coordinates]
    } else if (geom.type === 'MultiLineString') {
      lineStrings = geom.coordinates
    } else {
      continue // Skip non-line geometries
    }

    // Process each line string
    for (const coords of lineStrings) {
      if (coords.length < 2) continue

      // Process each segment of the line
      for (let i = 0; i < coords.length - 1; i++) {
        const startCoord = coords[i]
        const endCoord = coords[i + 1]
        totalSegments++

        const segmentTiles = getTilesForLineSegment(startCoord, endCoord)
        segmentTiles.forEach((tile) => {
          allTiles.add(`${tile.x},${tile.y}`)
        })
      }
    }
  }

  const uniqueTiles = Array.from(allTiles).map((s) => {
    const [x, y] = s.split(',').map(Number)
    return { x, y, z: WPLACE_ZOOM }
  })

  console.log(`📊 Processed ${totalSegments} line segments`)
  console.log(`📊 Found ${uniqueTiles.length} unique tiles at zoom ${WPLACE_ZOOM}`)

  // Filter out already downloaded and known 404s
  return uniqueTiles.filter((tile) => {
    const tileKey = `${tile.x}/${tile.y}`
    const outputPath = `${OUTPUT_DIR}/${tile.x}/${tile.y}.png`
    return !cache404.has(tileKey) && !existsSync(outputPath)
  })
}

async function downloadWplaceTile(x, y, retryCount = 0) {
  const url = `${WPLACE_BASE_URL}/${x}/${y}.png` // WPlace server ignores zoom in URL
  const outputPath = `${OUTPUT_DIR}/${x}/${y}.png`
  const tileKey = `${x}/${y}`

  // Check caches first
  if (cache404.has(tileKey)) {
    return { success: false, reason: 'cached_404', cached: true }
  }
  if (existsSync(outputPath)) {
    return { success: true, reason: 'already_exists', cached: true }
  }

  try {
    const response = await fetch(url, { headers: HEADERS })

    if (!response.ok) {
      if (response.status === 404) {
        cache404.add(tileKey)
        needsSave = true
        return { success: false, reason: '404' }
      } else if (response.status === 429 && retryCount < 3) {
        console.log(`\n⏸️ Rate limited, waiting ${DELAY_RATE_LIMIT_MS / 1000}s...`)
        await new Promise(r => setTimeout(r, DELAY_RATE_LIMIT_MS))
        return await downloadWplaceTile(x, y, retryCount + 1)
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const blob = await response.blob()
    await mkdir(`${OUTPUT_DIR}/${x}`, { recursive: true })
    await Bun.write(outputPath, blob)

    return { success: true }
  } catch (err) {
    if (retryCount < 2) {
      console.log(`\n🔄 Retrying ${x}/${y} (attempt ${retryCount + 2})...`)
      await new Promise(r => setTimeout(r, 1000))
      return await downloadWplaceTile(x, y, retryCount + 1)
    }
    console.error(`\n❌ Failed ${x}/${y}:`, err.message)
    return { success: false, reason: err.message }
  }
}

async function downloadWplaceLineTiles() {
  console.log(`🚀 Starting WPlace Line Tile Downloader (zoom ${WPLACE_ZOOM} only)`)
  setupGracefulShutdown()

  try {
    await loadCache404()
    const tiles = await extractTilesFromGeoJSON()

    if (!tiles.length) {
      console.log('🎉 All required tiles already downloaded!')
      return
    }

    console.log(`📦 Need to download ${tiles.length} tiles`)

    let downloaded = 0
    let skipped = 0
    let missing = 0
    let failed = 0

    for (let i = 0; i < tiles.length; i++) {
      const { x, y } = tiles[i]
      process.stdout.write(`⏳ [${i + 1}/${tiles.length}] ${x}/${y} ...`)

      const result = await downloadWplaceTile(x, y)

      if (result.success) {
        if (result.cached) {
          skipped++
          console.log(' 📄 (cached)')
        } else {
          downloaded++
          console.log(' ✅')
        }
      } else if (result.reason === '404') {
        missing++
        console.log(' ⚠️  (404)')
      } else {
        failed++
        console.log(' ❌')
      }

      // Rate limiting and cache management
      if (!result.cached && i < tiles.length - 1) {
        await new Promise(r => setTimeout(r, DELAY_MS))
      }
      if (needsSave && (i % 20 === 0)) {
        await saveCache404()
      }
    }

    await saveCache404()
    console.log(`\n🎉 Completed! Downloaded: ${downloaded}, Skipped: ${skipped}, Missing: ${missing}, Failed: ${failed}`)
  } catch (error) {
    console.error('💥 Fatal error:', error)
    await saveCache404()
    process.exit(1)
  }
}

// Run the downloader
await downloadWplaceLineTiles()
