<script setup lang="ts">
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
} from 'geojson'
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl'
import { nearestPointOnLine, point, length as turfLength } from '@turf/turf'
import { useLocalStorage, useUrlSearchParams } from '@vueuse/core'
import { Map as MaplibreMap, Popup } from 'maplibre-gl'
import { ofetch } from 'ofetch'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ADCHAPO_GEOJSON_URL, ANTOINE_BASE64_PNG, GEOJSON_URL } from './utils'
import 'maplibre-gl/dist/maplibre-gl.css'

const loading = ref(false)
const error = ref<string | null>(null)
const markerCount = ref<number | null>(null)
const distanceKm = ref<string | null>(null)

// --- State Management with VueUse ---
const params = useUrlSearchParams('history')

// 1. Define default values for all settings.
const DEFAULTS = {
  style: 'liberty' as const,
  filter: 'both' as const,
  wplace: true,
  is3d: false,
}

// 2. Initialize state by prioritizing URL > localStorage > default.
// useLocalStorage will read from storage or use the provided initial value.
// We then immediately overwrite it with the URL param if it exists.
const mapStyle = useLocalStorage('map-style', params.style?.toString() || DEFAULTS.style)
if (params.style) mapStyle.value = params.style as typeof DEFAULTS.style

const datasetFilter = useLocalStorage('dataset-filter', params.filter?.toString() || DEFAULTS.filter)
if (params.filter) datasetFilter.value = params.filter as typeof DEFAULTS.filter

const wplaceTilesEnabled = useLocalStorage('wplace-tiles-enabled', params.wplace ? params.wplace === 'true' : DEFAULTS.wplace)
if (params.wplace) wplaceTilesEnabled.value = params.wplace === 'true'

const is3dMode = useLocalStorage('is-3d-mode', params.mode ? params.mode === '3d' : DEFAULTS.is3d)
if (params.mode) is3dMode.value = params.mode === '3d'

// 3. Watch for user-driven changes and sync them back to the URL.
// useLocalStorage automatically keeps localStorage in sync.
watch(mapStyle, val => (params.style = val))
watch(datasetFilter, val => (params.filter = val))
watch(wplaceTilesEnabled, val => (params.wplace = String(val)))
watch(is3dMode, val => (params.mode = val ? '3d' : '2d'))

const datasetOptions = [
  { value: 'both', label: 'Tous' },
  { value: 'geo1', label: 'Minecraft' },
  { value: 'geo2', label: 'Chapo' },
] as const

let map: MaplibreMap | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

let lastGeo1Data: FeatureCollection = { type: 'FeatureCollection', features: [] }
let lastGeo2Data: FeatureCollection = { type: 'FeatureCollection', features: [] }

const STYLE_IDS = {
  geo1Source: 'geo1-src',
  geo1Layer: 'geo1-layer',
  geo2Source: 'geo2-src',
  geo2Layer: 'geo2-layer',
  wplaceSource: 'wplace-src',
  wplaceLayer: 'wplace-layer',
  markerImage: 'antoine-marker',
} as const

const styleUrl = (name: string) => `https://tiles.openfreemap.org/styles/${name}`

function ensureMarkerImage(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!map) return reject(new Error('map not ready'))
    if (map.hasImage(STYLE_IDS.markerImage)) return resolve()
    const img = new Image()
    img.onload = () => {
      if (!map!.hasImage(STYLE_IDS.markerImage)) {
        map!.addImage(STYLE_IDS.markerImage, img, { pixelRatio: 1 })
      }
      resolve()
    }
    img.onerror = reject
    img.src = ANTOINE_BASE64_PNG
  })
}

function setGeoJson(id: string, data: FeatureCollection) {
  if (!map) return
  const src = map.getSource(id) as GeoJSONSource | undefined
  if (src) src.setData(data)
}

function addOrUpdateSources() {
  if (!map) return

  if (!map.getSource(STYLE_IDS.geo1Source)) {
    map.addSource(STYLE_IDS.geo1Source, { type: 'geojson', data: lastGeo1Data })
  } else {
    setGeoJson(STYLE_IDS.geo1Source, lastGeo1Data)
  }

  if (!map.getSource(STYLE_IDS.geo2Source)) {
    map.addSource(STYLE_IDS.geo2Source, { type: 'geojson', data: lastGeo2Data })
  } else {
    setGeoJson(STYLE_IDS.geo2Source, lastGeo2Data)
  }

  if (!map.getSource(STYLE_IDS.wplaceSource)) {
    map.addSource(STYLE_IDS.wplaceSource, {
      type: 'raster',
      tiles: [`/wplace_tiles/{x}/{y}.png`],
      tileSize: 256,
      minzoom: 11,
      maxzoom: 11,
    })
  }
}

function addLayersIfMissing() {
  if (!map) return

  if (!map.getLayer(STYLE_IDS.wplaceLayer)) {
    map.addLayer({
      id: STYLE_IDS.wplaceLayer,
      type: 'raster',
      source: STYLE_IDS.wplaceSource,
      layout: { visibility: 'visible' },
      paint: {
        'raster-opacity': 1,
        'raster-resampling': 'nearest',
      },
    })
  }

  if (!map.getLayer(STYLE_IDS.geo1Layer)) {
    map.addLayer({
      id: STYLE_IDS.geo1Layer,
      type: 'symbol',
      source: STYLE_IDS.geo1Source,
      layout: {
        'icon-image': STYLE_IDS.markerImage,
        'icon-size': 0.15,
        'icon-allow-overlap': true,
      },
    })
  }

  if (!map.getLayer(STYLE_IDS.geo2Layer)) {
    map.addLayer({
      id: STYLE_IDS.geo2Layer,
      type: 'line',
      source: STYLE_IDS.geo2Source,
      paint: {
        'line-color': ['case', ['has', 'color'], ['get', 'color'], '#ED1C25'],
        'line-width': 3,
      },
    })
  }
}

function applyDatasetFilter() {
  const setVis = (layerId: string, visible: boolean) => {
    if (!map || !map.getLayer(layerId)) return
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
  }

  const showGeo1 = datasetFilter.value === 'both' || datasetFilter.value === 'geo1'
  const showGeo2 = datasetFilter.value === 'both' || datasetFilter.value === 'geo2'
  const showWplace
    = wplaceTilesEnabled.value
      && (datasetFilter.value === 'both' || datasetFilter.value === 'geo2')

  setVis(STYLE_IDS.geo1Layer, showGeo1)
  setVis(STYLE_IDS.geo2Layer, showGeo2)
  setVis(STYLE_IDS.wplaceLayer, showWplace)
}

async function readdOverlays() {
  await ensureMarkerImage()
  addOrUpdateSources()
  addLayersIfMissing()
  applyDatasetFilter()
}

async function safeFetchGeoJson(url: string): Promise<FeatureCollection> {
  try {
    return await ofetch(url, {
      params: { _: Date.now() },
      cache: 'no-store',
      responseType: 'json',
    })
  } catch {
    return { type: 'FeatureCollection', features: [] }
  }
}

async function loadGeoJson() {
  if (!map) return
  loading.value = true
  error.value = null
  try {
    const data1 = await safeFetchGeoJson(GEOJSON_URL)
    lastGeo1Data = data1
    setGeoJson(STYLE_IDS.geo1Source, lastGeo1Data)
    markerCount.value = lastGeo1Data.features.length

    try {
      const data2 = await safeFetchGeoJson(ADCHAPO_GEOJSON_URL)
      lastGeo2Data = data2
      setGeoJson(STYLE_IDS.geo2Source, lastGeo2Data)

      let total = 0
      for (const f of lastGeo2Data.features) {
        if (!f.geometry) continue
        if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
          total += turfLength(f as Feature<LineString | MultiLineString>, { units: 'kilometers' })
        }
      }
      distanceKm.value = total.toFixed(2)
    } catch (chapoErr) {
      console.warn('Non-fatal: adchapo load failed', chapoErr)
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Unknown error'
  } finally {
    loading.value = false
  }
}

function handleMapClick(e: MapLayerMouseEvent) {
  if (!map) return
  const layers = [STYLE_IDS.geo1Layer, STYLE_IDS.geo2Layer].filter(id => map!.getLayer(id))
  if (!layers.length) return

  const features = map.queryRenderedFeatures(e.point, { layers })
  if (!features.length) return

  const f = features[0]
  if (!f || !f.geometry) return

  let coords: [number, number] | null = null
  if (f.geometry.type === 'Point' && f.geometry.coordinates.length === 2) {
    coords = [f.geometry.coordinates[0]!, f.geometry.coordinates[1]!]
  } else if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
    const clickPoint = point([e.lngLat.lng, e.lngLat.lat])
    const nearest = nearestPointOnLine(f as Feature<LineString | MultiLineString>, clickPoint)
    coords = [nearest.geometry.coordinates[0]!, nearest.geometry.coordinates[1]!]
  }

  const props = { ...(f.properties ?? {}) }
  delete (props as Record<string, unknown>).color

  const html = `
    <div class="card bg-base-100 shadow-xl p-3 max-w-xs">
      <h2 class="card-title text-sm mb-2">Propriétés</h2>
      <div class="space-y-1 text-sm">
        ${Object.entries(props)
          .map(([k, v]) => `
            <div>
              <span class="font-semibold">${k}:</span> ${String(v.replaceAll('<a ', `<a class="link link-primary" `))}
            </div>
          `)
          .join('')}
      </div>
      ${
        coords
          ? `
          <div class="mt-2">
            <span class="font-semibold">wplace:</span>
            <a href="https://wplace.live/?lat=${coords[1]}&lng=${coords[0]}&zoom=15"
               target="_blank"
               rel="noopener"
               class="link link-primary">
              Ouvrir dans WPlace
            </a>
          </div>
        `
          : ''
      }
    </div>
  `

  new Popup({ closeButton: true, closeOnClick: true })
    .setMaxWidth('auto')
    .setLngLat(coords || [e.lngLat.lng, e.lngLat.lat])
    .setHTML(html)
    .addTo(map!)
}

function changeMapStyle() {
  if (!map) return
  // mapStyle.value is already updated by v-model

  const cam = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  }

  map.setStyle(styleUrl(mapStyle.value))
  map.once('styledata', async () => {
    await readdOverlays()
    map!.jumpTo(cam)
  })
}

function toggleViewMode() {
  is3dMode.value = !is3dMode.value
  if (!map) return
  map.easeTo({ pitch: is3dMode.value ? 60 : 0, duration: 500 })
}

function initializeMap() {
  const initialCenter: [number, number] = [Number(params.lng ?? 0), Number(params.lat ?? 0)]
  const initialZoom = Number(params.zoom ?? 2)
  const initialPitch = Number(params.pitch ?? (is3dMode.value ? 60 : 0))
  const initialBearing = Number(params.bearing ?? 0)

  // Ensure 3D mode ref is consistent with initial pitch from URL
  if (initialPitch > 0 && !is3dMode.value) {
    is3dMode.value = true
  }

  map = new MaplibreMap({
    container: 'map',
    style: styleUrl(mapStyle.value),
    center: initialCenter,
    zoom: initialZoom,
    pitch: initialPitch,
    bearing: initialBearing,
    attributionControl: false,
  })

  const updateUrlParams = () => {
    if (!map) return
    const center = map.getCenter()
    params.lat = center.lat.toFixed(6)
    params.lng = center.lng.toFixed(6)
    params.zoom = map.getZoom().toFixed(2)
    params.pitch = map.getPitch().toFixed(0)
    params.bearing = map.getBearing().toFixed(0)
  }

  map.on('load', async () => {
    await readdOverlays()
    loadGeoJson()
    updateUrlParams() // Set initial map coords in URL
    refreshTimer = setInterval(loadGeoJson, 10000)
  })

  map.on('moveend', updateUrlParams)
  map.on('zoomend', updateUrlParams)
  map.on('pitchend', updateUrlParams)
  map.on('rotateend', updateUrlParams)
  map.on('click', handleMapClick)
}

watch(datasetFilter, applyDatasetFilter)
watch(wplaceTilesEnabled, applyDatasetFilter)

onMounted(initializeMap)
onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  if (map) {
    map.off('click', handleMapClick)
    map.remove()
  }
})
</script>

<template>
  <div class="h-screen flex flex-col">
    <!-- Navbar with fixed height -->
    <div class="navbar bg-base-100 border-b border-base-300 min-h-12 h-12">
      <div class="navbar-start">
        <div class="dropdown">
          <div class="btn btn-ghost lg:hidden" role="button" tabindex="0">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 6h16M4 12h8m-8 6h16" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" /></svg>
          </div>
          <div
            class="dropdown-content bg-base-100 rounded-box z-[1] mt-3 w-72 p-4 shadow space-y-4"
            tabindex="0"
          >
            <!-- Mobile Menu Controls -->
            <div class="flex items-center justify-between gap-2">
              <label class="font-medium">Style</label>
              <select
                v-model="mapStyle"
                class="select select-bordered select-sm"
                @change="changeMapStyle"
              >
                <option value="liberty">
                  Liberty
                </option>
                <option value="bright">
                  Bright
                </option>
                <option value="positron">
                  Positron
                </option>
              </select>
            </div>
            <div class="flex items-center justify-between">
              <label class="font-medium whitespace-nowrap">Tuiles WPlace</label>
              <input v-model="wplaceTilesEnabled" class="toggle toggle-primary toggle-sm" type="checkbox">
            </div>
            <div>
              <label class="font-medium block mb-2">Données</label>
              <div class="flex flex-wrap gap-1">
                <button
                  v-for="option in datasetOptions"
                  :key="option.value"
                  class="btn join-item btn-sm flex-grow"
                  :class="{ 'btn-primary': datasetFilter === option.value }"
                  @click="datasetFilter = option.value"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
            <button class="btn btn-primary btn-sm w-full" @click="toggleViewMode">
              {{ is3dMode ? 'Voir la carte 2D' : 'Voir la carte 3D' }}
            </button>
          </div>
        </div>
        <span class="text-lg font-semibold normal-case ml-2 text-nowrap">AdFaceAntoine Viewer</span>
      </div>

      <div class="navbar-end">
        <div class="hidden lg:flex items-center gap-4">
          <select
            v-model="mapStyle"
            class="select select-bordered select-sm"
            @change="changeMapStyle"
          >
            <option value="liberty">
              Liberty
            </option>
            <option value="bright">
              Bright
            </option>
            <option value="positron">
              Positron
            </option>
          </select>

          <label class="flex items-center gap-2 cursor-pointer">
            <span class="text-sm whitespace-nowrap">Tuiles WPlace</span>
            <input v-model="wplaceTilesEnabled" class="toggle toggle-primary toggle-sm" type="checkbox">
          </label>

          <div class="join">
            <button
              v-for="option in datasetOptions"
              :key="option.value"
              class="btn join-item btn-sm"
              :class="{ 'btn-primary': datasetFilter === option.value }"
              @click="datasetFilter = option.value"
            >
              {{ option.label }}
            </button>
          </div>

          <button class="btn btn-primary btn-sm" @click="toggleViewMode">
            {{ is3dMode ? 'Voir 2D' : 'Voir 3D' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Map -->
    <div class="relative flex-1">
      <div id="map" class="h-full w-full" />

      <Transition>
        <div
          v-if="loading"
          class="absolute top-2 left-1/2 -translate-x-1/2 bg-base-100 border border-base-300 shadow px-3 py-1 rounded"
        >
          Chargement des données...
        </div>
      </Transition>

      <Transition>
        <div
          v-if="error"
          class="absolute top-2 left-1/2 -translate-x-1/2 bg-error text-error-content border border-error-content shadow px-3 py-1 rounded"
        >
          Erreur : {{ error }}
        </div>
      </Transition>

      <Transition>
        <div
          v-if="markerCount != null && distanceKm != null"
          class="absolute bottom-2 right-2 bg-base-100 border border-base-300 shadow p-3 rounded flex flex-col gap-2 text-sm"
        >
          <div class="flex items-center gap-2">
            <img alt="adfaceantoine" class="w-4 h-4" src="/antoine.png">
            <span>{{ markerCount }} AdFaceAntoine{{ markerCount !== 1 ? 's' : '' }}</span>
          </div>
          <div class="flex items-center gap-2">
            <img alt="adfacechapo" class="w-4 h-4" src="/chapo.png" style="transform: scale(1.4)">
            <span>Distance : {{ distanceKm }} km</span>
          </div>
        </div>
      </Transition>
      <div class="absolute bottom-2 left-2 bg-base-100 border border-base-300 shadow px-2 py-1 rounded text-xs">
        <a class="link link-neutral" href="https://github.com/kernoeb" rel="noopener" target="_blank">© kernoeb</a>
      </div>
    </div>
  </div>
</template>

<style>
.maplibregl-popup-content {
  background: transparent !important;
  box-shadow: none !important;
  padding: 0 !important;
  border-radius: 0 !important;
  padding-top: 0 !important;
}

.maplibregl-popup-close-button {
  top: 0.5rem !important;
  right: 0.5rem !important;
  font-size: 1.25rem;
  color: hsl(var(--bc));
}

.maplibregl-popup-close-button:hover {
  color: hsl(var(--p));
}

.v-enter-active,
.v-leave-active {
  transition: opacity 0.5s ease;
}

.v-enter-from,
.v-leave-to {
  opacity: 0;
}
</style>
