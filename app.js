/* global Vue, ol, olcs, Cesium, turf */

import { ADCHAPO_GEOJSON_URL, ANTOINE_BASE64_PNG, CESIUM_TOKEN, GEOJSON_URL } from './utils'

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

      let mapInstance = null
      let olCesiumInstance = null
      let vectorSource = null
      let vectorLayer = null
      let vectorSource2 = null
      let vectorLayer2 = null
      let wplaceTileLayer = null
      let refreshTimer = null

      /**
       * Creates the wplace tile layer using OpenLayers native XYZ with custom URL template
       */
      const createWplaceTileLayer = (minZoom = 11, wplaceMaxZoom = 11) => {
        return new ol.layer.Tile({
          source: new ol.source.XYZ({
            url: `${import.meta?.env?.NODE_ENV === 'production' ? '' : 'http://localhost:20000'}/wplace_tiles/{x}/{y}.png`,
            minZoom,
            maxZoom: wplaceMaxZoom,
            crossOrigin: 'anonymous',
            zDirection: 1,
            tileGrid: ol.tilegrid.createXYZ({
              minZoom,
              maxZoom: wplaceMaxZoom,
              tileSize: [256, 256],
            }),
          }),
          minZoom,
          opacity: 1,
          visible: wplaceTilesEnabled.value,
        })
      }

      /**
       * Calculates the length of a LineString or MultiLineString feature in kilometers.
       * @param {object} line - A GeoJSON LineString or MultiLineString feature.
       * @returns {number} The length in kilometers.
       */
      const calculateLengthInKm = (line) => {
        return turf.length(line, { units: 'kilometers' })
      }

      const loadGeoJson = async () => {
        loading.value = true
        error.value = null
        try {
          // Load primary GeoJSON (Antoine markers)
          const response = await fetch(
            `${GEOJSON_URL}?_=${Date.now()}`,
            { cache: 'no-store' },
          )
          if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`)
          }
          const data = await response.json()

          const features = new ol.format.GeoJSON().readFeatures(data, {
            featureProjection: 'EPSG:3857',
          })

          vectorSource.clear()
          vectorSource.addFeatures(features)
          markerCount.value = vectorSource.getFeatures().length

          // Load adchapo GeoJSON dataset (red lines)
          try {
            const chapoResponse = await fetch(`${ADCHAPO_GEOJSON_URL}?_=${Date.now()}`, { cache: 'no-store' })
            if (!chapoResponse.ok) {
              throw new Error(`HTTP error! Status: ${chapoResponse.status} for adchapo`)
            }
            const chapoData = await chapoResponse.json()
            const chapoFeatures = new ol.format.GeoJSON().readFeatures(chapoData, {
              featureProjection: 'EPSG:3857',
            })

            if (vectorSource2) {
              vectorSource2.clear()
              vectorSource2.addFeatures(chapoFeatures)
            }

            // Calculate and log the length of each LineString feature
            const features = new ol.format.GeoJSON().readFeatures(chapoData)
            let totalLength = 0
            features.forEach((feature) => {
              const geom = feature.getGeometry()
              if (geom) {
                const geojsonGeom = new ol.format.GeoJSON().writeGeometryObject(geom)
                if (geojsonGeom.type === 'LineString' || geojsonGeom.type === 'MultiLineString') {
                  const length = calculateLengthInKm(geojsonGeom)
                  totalLength += length
                }
              }
            })
            distanceKm.value = totalLength.toFixed(2)
          } catch (chapoError) {
            console.warn('Non-fatal: failed to load/process adchapo GeoJSON', chapoError)
          }
        } catch (e) {
          console.error('Échec du chargement du GeoJSON :', e)
          error.value = e.message
        } finally {
          loading.value = false
        }
      }

      const applyDatasetFilter = () => {
        if (vectorLayer) {
          vectorLayer.setVisible(datasetFilter.value === 'both' || datasetFilter.value === 'geo1')
        }
        if (vectorLayer2) {
          vectorLayer2.setVisible(datasetFilter.value === 'both' || datasetFilter.value === 'geo2')
        }
        if (wplaceTileLayer) {
          wplaceTileLayer.setVisible(
            wplaceTilesEnabled.value && (datasetFilter.value === 'both' || datasetFilter.value === 'geo2'),
          )
        }
      }

      const toggleWplaceTiles = () => {
        wplaceTilesEnabled.value = !wplaceTilesEnabled.value
        applyDatasetFilter()
      }

      const initializeMap = () => {
        Cesium.Ion.defaultAccessToken = CESIUM_TOKEN

        const popupContainer = document.getElementById('popup')
        const popupContent = document.getElementById('popup-content')
        const popupCloser = document.getElementById('popup-closer')

        const overlay = new ol.Overlay({
          element: popupContainer,
          autoPan: { animation: { duration: 250 } },
        })

        // Second dataset: red trace/line
        vectorSource2 = new ol.source.Vector()
        vectorLayer2 = new ol.layer.Vector({
          source: vectorSource2,
          style: (feature) => {
            const color = feature.get('color') || '#ED1C25' // fallback si pas défini
            return new ol.style.Style({
              stroke: new ol.style.Stroke({
                color,
                width: 3,
              }),
            })
          },
        })

        popupCloser.onclick = () => {
          overlay.setPosition(undefined)
          popupCloser.blur()
          return false
        }

        vectorSource = new ol.source.Vector()
        vectorLayer = new ol.layer.Vector({
          source: vectorSource,
          style: new ol.style.Style({
            image: new ol.style.Icon({
              anchor: [0.5, 1],
              anchorXUnits: 'fraction',
              anchorYUnits: 'fraction',
              src: ANTOINE_BASE64_PNG,
              scale: 0.15,
            }),
          }),
        })

        // Create wplace tile layer using simple XYZ approach
        wplaceTileLayer = createWplaceTileLayer()

        mapInstance = new ol.Map({
          target: 'map',
          layers: [
            new ol.layer.Tile({
              source: new ol.source.OSM(),
            }),
            wplaceTileLayer,
            vectorLayer,
            vectorLayer2,
          ],
          overlays: [overlay],
          view: new ol.View({ center: [0, 0], zoom: 2 }),
        })

        mapInstance.on('click', (evt) => {
          overlay.setPosition(undefined)
          const feature = mapInstance.forEachFeatureAtPixel(evt.pixel, f => f)
          if (feature) {
            const geom = feature.getGeometry()
            const coordinates
              = geom.getType() === 'LineString' || geom.getType() === 'MultiLineString'
                ? geom.getClosestPoint(evt.coordinate)
                : geom.getCoordinates()

            let content = '<strong>Propriétés</strong><br><hr>'
            const properties = feature.getProperties()
            for (const key in properties) {
              if (key !== 'geometry' && key !== 'color') {
                content += `<strong>${key}:</strong> ${properties[key]}<br>`
              }
            }
            const [lon, lat] = ol.proj.toLonLat(coordinates)
            const wplaceUrl = `https://wplace.live/?lat=${lat}&lng=${lon}&zoom=15`
            content += `<strong>wplace :</strong> <a href="${wplaceUrl}" target="_blank" rel="noopener">${wplaceUrl}</a><br>`

            popupContent.innerHTML = content
            overlay.setPosition(coordinates)
          }
        })

        olCesiumInstance = new olcs.OLCesium({
          map: mapInstance,
        })
        const scene = olCesiumInstance.getCesiumScene()
        scene.screenSpaceCameraController.enableTranslate = false
        scene.screenSpaceCameraController.enableTilt = false

        applyDatasetFilter()
        loadGeoJson()
        refreshTimer = setInterval(loadGeoJson, 10000)
      }

      const toggleViewMode = () => {
        is3dMode.value = !is3dMode.value
        if (olCesiumInstance) {
          olCesiumInstance.setEnabled(is3dMode.value)
        }
      }

      // React to filter changes
      watch(datasetFilter, applyDatasetFilter)
      watch(wplaceTilesEnabled, applyDatasetFilter)

      onMounted(() => {
        const checkLibraries = () => {
          if (window.ol && window.Cesium && window.olcs) {
            initializeMap()
          } else {
            setTimeout(checkLibraries, 100)
          }
        }
        checkLibraries()
      })

      onBeforeUnmount(() => {
        if (refreshTimer) clearInterval(refreshTimer)
      })

      return {
        loading,
        error,
        markerCount,
        distanceKm,
        is3dMode,
        datasetFilter,
        wplaceTilesEnabled,
        toggleViewMode,
        toggleWplaceTiles,
      }
    },
  }).mount('#app')
})
