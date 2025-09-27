/* global Vue, maplibregl, turf, __BUILD__ */
import { ADCHAPO_GEOJSON_URL, ANTOINE_BASE64_PNG, GEOJSON_URL } from './utils'

document.addEventListener('DOMContentLoaded', () => {
  const { createApp, ref, onMounted, onBeforeUnmount, watch } = Vue

  createApp({
    setup() {
      const loading = ref(false)
      const error = ref(null)
      const markerCount = ref(null)
      const distanceKm = ref(null)
      const is3dMode = ref(false)
      const datasetFilter = ref('both')
      const wplaceTilesEnabled = ref(true)
      const mapStyle = ref('liberty')

      let map = null
      let refreshTimer = null

      let lastGeo1Data = { type: 'FeatureCollection', features: [] }
      let lastGeo2Data = { type: 'FeatureCollection', features: [] }

      const STYLE_IDS = {
        geo1Source: 'geo1-src',
        geo1Layer: 'geo1-layer',
        geo2Source: 'geo2-src',
        geo2Layer: 'geo2-layer',
        wplaceSource: 'wplace-src',
        wplaceLayer: 'wplace-layer',
        markerImage: 'antoine-marker',
      }

      const styleUrl = name => `https://tiles.openfreemap.org/styles/${name}`

      const ensureMarkerImage = () =>
        new Promise((resolve, reject) => {
          try {
            if (map.hasImage(STYLE_IDS.markerImage)) return resolve()
            const img = new Image()
            img.onload = () => {
              try {
                if (!map.hasImage(STYLE_IDS.markerImage)) {
                  map.addImage(STYLE_IDS.markerImage, img, { pixelRatio: 1 })
                }
                resolve()
              } catch (e) {
                reject(e)
              }
            }
            img.onerror = reject
            img.src = ANTOINE_BASE64_PNG
          } catch (e) {
            reject(e)
          }
        })

      const addOrUpdateSources = () => {
        if (!map.getSource(STYLE_IDS.geo1Source)) {
          map.addSource(STYLE_IDS.geo1Source, { type: 'geojson', data: lastGeo1Data })
        } else {
          map.getSource(STYLE_IDS.geo1Source).setData(lastGeo1Data)
        }

        if (!map.getSource(STYLE_IDS.geo2Source)) {
          map.addSource(STYLE_IDS.geo2Source, { type: 'geojson', data: lastGeo2Data })
        } else {
          map.getSource(STYLE_IDS.geo2Source).setData(lastGeo2Data)
        }

        if (!map.getSource(STYLE_IDS.wplaceSource)) {
          const isProd = typeof __BUILD__ !== 'undefined' && __BUILD__ === true
          const base = isProd ? '' : 'http://localhost:20000'
          map.addSource(STYLE_IDS.wplaceSource, {
            type: 'raster',
            tiles: [`${base}/wplace_tiles/{x}/{y}.png`],
            tileSize: 256,
            minzoom: 11,
            maxzoom: 11,
          })
        }
      }

      const addLayersIfMissing = () => {
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
              'line-color': [
                'case',
                ['has', 'color'],
                ['get', 'color'],
                '#ED1C25',
              ],
              'line-width': 3,
            },
          })
        }
      }

      const applyDatasetFilter = () => {
        const setVis = (layerId, visible) => {
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

      const readdOverlays = async () => {
        await ensureMarkerImage() // image must exist before symbol layer references it [web:3]
        addOrUpdateSources() // sources are wiped by setStyle and must be recreated [web:5]
        addLayersIfMissing() // re-add layers referencing the recreated sources [web:3]
        applyDatasetFilter() // restore visibility toggles on the fresh layers [web:3]
      }

      const loadGeoJson = async () => {
        if (!map) return
        loading.value = true
        error.value = null
        try {
          const res1 = await fetch(`${GEOJSON_URL}?_=${Date.now()}`, { cache: 'no-store' })
          if (!res1.ok) throw new Error(`HTTP ${res1.status} for GEOJSON_URL`)
          const data1 = await res1.json()
          lastGeo1Data = data1 && data1.type ? data1 : { type: 'FeatureCollection', features: [] }
          if (map.getSource(STYLE_IDS.geo1Source)) map.getSource(STYLE_IDS.geo1Source).setData(lastGeo1Data)
          markerCount.value = Array.isArray(lastGeo1Data.features) ? lastGeo1Data.features.length : 0

          try {
            const res2 = await fetch(`${ADCHAPO_GEOJSON_URL}?_=${Date.now()}`, { cache: 'no-store' })
            if (!res2.ok) throw new Error(`HTTP ${res2.status} for ADCHAPO_GEOJSON_URL`)
            const data2 = await res2.json()
            lastGeo2Data = data2 && data2.type ? data2 : { type: 'FeatureCollection', features: [] }
            if (map.getSource(STYLE_IDS.geo2Source)) map.getSource(STYLE_IDS.geo2Source).setData(lastGeo2Data)

            let total = 0
            const feats2 = Array.isArray(lastGeo2Data.features) ? lastGeo2Data.features : []
            for (const f of feats2) {
              if (!f || !f.geometry) continue
              const t = f.geometry.type
              if (t === 'LineString' || t === 'MultiLineString') {
                total += turf.length(f, { units: 'kilometers' })
              }
            }
            distanceKm.value = total.toFixed(2)
          } catch (chapoErr) {
            console.warn('Non-fatal: adchapo load failed', chapoErr)
          }
        } catch (e) {
          console.error('Échec du chargement du GeoJSON :', e)
          error.value = e.message
        } finally {
          loading.value = false
        }
      }

      const handleMapClick = (e) => {
        if (!map) return
        const layers = [STYLE_IDS.geo1Layer, STYLE_IDS.geo2Layer].filter(id => map.getLayer(id))
        if (!layers.length) return

        const features = map.queryRenderedFeatures(e.point, { layers })
        if (!features || !features.length) return

        const f = features[0]

        let coords = null

        if (f.geometry.type === 'Point') {
          coords = f.geometry.coordinates
        } else if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
          // Use turf to find closest point on the line to click
          const clickPoint = turf.point([e.lngLat.lng, e.lngLat.lat])
          const line = f.geometry.type === 'LineString'
            ? f
            : turf.lineString(f.geometry.coordinates.flat())
          const nearest = turf.nearestPointOnLine(line, clickPoint)
          coords = nearest.geometry.coordinates
        }

        const props = { ...f.properties }
        delete props.color

        let html = '<strong>Propriétés</strong><br><hr>'
        for (const k in props) html += `<strong>${k}:</strong> ${props[k]}<br>`

        if (coords) {
          const wplaceUrl = `https://wplace.live/?lat=${coords[1]}&lng=${coords[0]}&zoom=15`
          html += `<strong>wplace :</strong> <a href="${wplaceUrl}" target="_blank" rel="noopener">${wplaceUrl}</a><br>`
        }

        new maplibregl.Popup({ closeButton: true, closeOnClick: true })
          .setMaxWidth('auto')
          .setLngLat(coords || [e.lngLat.lng, e.lngLat.lat])
          .setHTML(html)
          .addTo(map)
      }

      const changeMapStyle = (name) => {
        if (!map) return
        mapStyle.value = name

        const cam = {
          center: map.getCenter(),
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
        } // save camera to keep view stable across base styles [web:5]

        map.setStyle(styleUrl(name)) // this wipes runtime images/sources/layers by design [web:5]

        // Use idle to ensure the style graph is fully ready before re-adding overlays
        map.once('idle', async () => {
          await readdOverlays() // addImage → addSource → addLayer → visibility [web:3]
          map.jumpTo(cam) // restore camera after overlays are back [web:5]
        })
      }

      const toggleViewMode = () => {
        is3dMode.value = !is3dMode.value
        if (!map) return
        map.easeTo({ pitch: is3dMode.value ? 60 : 0, duration: 500 })
      }

      const toggleWplaceTiles = () => {
        wplaceTilesEnabled.value = !wplaceTilesEnabled.value
        applyDatasetFilter()
      }

      const initializeMap = () => {
        map = new maplibregl.Map({
          container: 'map',
          style: styleUrl(mapStyle.value),
          center: [0, 0],
          zoom: 2,
          pitch: 0,
          bearing: 0,
          attributionControl: true,
        })

        // Simple first-render size fix (no observers needed)
        map.once('render', () => {
          if (map) map.resize()
        }) // recalculates canvas size once [web:6]

        map.on('load', async () => {
          await readdOverlays() // initial add after base style is ready [web:3]
          loadGeoJson() // populate sources with data [web:3]
          refreshTimer = setInterval(loadGeoJson, 10000)
        })

        map.on('click', handleMapClick)
      }

      watch(datasetFilter, applyDatasetFilter)
      watch(wplaceTilesEnabled, applyDatasetFilter)

      onMounted(() => {
        const checkLibraries = () => {
          if (window.maplibregl && window.turf) {
            initializeMap()
          } else {
            setTimeout(checkLibraries, 50)
          }
        }
        checkLibraries()
      })

      onBeforeUnmount(() => {
        if (refreshTimer) clearInterval(refreshTimer)
        if (map) {
          map.off('click', handleMapClick)
          map.remove()
          map = null
        }
      })

      return {
        loading,
        error,
        markerCount,
        distanceKm,
        is3dMode,
        datasetFilter,
        wplaceTilesEnabled,
        mapStyle,
        toggleViewMode,
        toggleWplaceTiles,
        changeMapStyle,
      }
    },
  }).mount('#app')
})
