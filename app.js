/* global Vue, ol, olcs, Cesium */

document.addEventListener('DOMContentLoaded', () => {
  const { createApp, ref, onMounted, onBeforeUnmount } = Vue

  createApp({
    setup() {
      const loading = ref(false)
      const error = ref(null)
      const markerCount = ref(0)
      const is3dMode = ref(false)

      const GEOJSON_URL = 'https://gist.githubusercontent.com/kernoeb/95db7d5949f8c558fab754ba18214dc6/raw/mapdata.geojson'
      const antoinePngBase64 = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHAAAABwCAIAAABJgmMcAAAFaklEQVR4nOycS2slRRTH69VtcjMxMTOJMg4DIoyMoC4dHAQd/BCCoMxeBB8g+AFcuBAXs1cZ8Qu4GhBciSuXA9m5Cmpek3tv0p3c7q4jtwtRwXSd1n/RSTi/bSr1+N3urkefPo4efKIEHGboDlw0RCgYEQpGhIIRoWBEKBgRCkaEghGhYEQoGBEKRoSCEaFgRCgYEQpGhIIRoWBEKBgRCkaEghGhYEQoGBEKRoSCcSkqJaJ4GaW0UlrrQVoPpGg9iVCd2XgZpRWRajy6baWda38vBjW69RRCPandg8KT6v75PVFu7eVRjmxb66pu9iZl9NIjUkarK0sLBn2NIoUSkc7s3ri88+H9nYPCGH3a3WeNrhr/8nNXv/v0TVX7cPv/T7wns5Bt/rL9xsffdvvUWntP66ujHz5/e31lkaoGeO+nuELp1/3D/UkZLbkzLsBta1XVfvvgiFO29t6zn7Z8kjxDc2d1S8cV2njKXPxR2xet41NN6FieoPWEs3xQeZpQor/KpGidUyZR67IOBSNCwYhQMCIUjAgFI0LBiFAwSdahxmhrwsL+3wvYdgtt4BvpdgtrY9WGjqVoPYlQIjUtZs18g37qyrn9qzoqK3jrjadQeXcflZp3MsXSHi2UVO7May9d358ez7eAp3TZGF039OIz68xjNi6elkf5K89fi2w+263n2vJC7gy4A0rpJF/SWRM/PgojgZ+HMlsPHUjQepJnaBJN56T1NIcjvGJJJgV264k6kOYVSIpKz0nrsg4FI0LBiFAwIhSMCAUjQsGIUDA91qHs14QpQoaSEN7MMgr2GBFbqFbasl9kD7v1ZKMd7wYlpTx3RFyhTUPTacGIGSKj9fLosbN/kRKp6aT0RN2DIiJnzaVFbgxWXKj3ZBbzh5tbr35w3+iuOyTEDG2sjn68d3djZYSNGQISYrB2xsXtd7/cjsVg1Q3dunn1wWdvMWOwuFdo3dCkOOGUzJxJE5MBhkg9OjzmDGpSzPjVcoW2MUORk4f21YLPmA+mM0DmTDsu0xmD5Z3tcZ/1muXjc2IbtMSvcmD+7O2pcU6hQK8RnZur6bwgQsGIUDAiFIwIBSNCwYhQMEneenpP3hN5ikVwKMPem/p4gA2X+daz7SGqwr+DF6q1WlrMzShXsyby8ReRmtXMag37eCIOkcrt0kmd4qQBL7Sq/c+bW2vLC03tOw5HiOjSYn7j2hrnQLLx9HBzq/YEMUBE1pn96XF1xj9NDBu4vUl556NvOOVv3Xz6p3t3u09x5rens4dH5e33vz5MEK3X62NbDsNMSiGEMxrI+c9/MefiZYDM8mBEKBgRCkaEghGhYEQoGBEKRoSCEaFgemw9+bsU/maOQm6HaIE+u0PgbqrN89GvQq7Q2MD/C/PeZra7v5pIOdsrPwiwn3VD7XFPw/8XnlBSmTMbq0vdoTjh7M57tTsuOAlnZnXz+0HBORyZTEumpMyZy4+PUE7bUBy/vjLi/wvvS7qQYKo4icZVmczujMvX3/tq5+CoIytOIHd2bXkhOnTdpi7aHZfdP5Ix2nt64dknv//iHTqpIkexbPom7GJeoZQ589QTlyKRI0Qqs65N2sVhVje/PWLlWOKTObuxuqROZiihqmdKOfakRIqqyOn6/PZsNXHrTDDRzeevqlZV7GVBT/j9BM/yIf8Vv84UyZPCxIwVykfWoWBEKBgRCkaEghGhYEQoGBEKZpi8TYka1WlyQfVimLxNKQjpmg7LHp/ApGCYvE0p0Eb7hm5cvzLsdyjD5W1KQbpcUGwuYt6mQRkyb1MKBo8lu4B5m4ZF1qFgRCgYEQpGhIIRoWBEKBgRCkaEghGhYEQomD8CAAD//3KPROZbXCAOAAAAAElFTSuQmCC`

      let mapInstance = null
      let olCesiumInstance = null
      let vectorSource = null
      let refreshTimer = null

      const loadGeoJson = async () => {
        loading.value = true
        error.value = null
        try {
          const response = await fetch(
            `${GEOJSON_URL}?_=${Date.now()}`,
            { cache: 'no-store' },
          )
          if (!response.ok) {
            throw new Error(
              `HTTP error! Status: ${response.status}`,
            )
          }
          const data = await response.json()

          const features = new ol.format.GeoJSON().readFeatures(data, {
            featureProjection: 'EPSG:3857',
          })

          vectorSource.clear()
          vectorSource.addFeatures(features)
          markerCount.value = vectorSource.getFeatures().length
        } catch (e) {
          console.error(
            'Échec du chargement du GeoJSON :',
            e,
          )
          error.value = e.message
        } finally {
          loading.value = false
        }
      }

      const initializeMap = () => {
        Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI3YmYzMzYyOS0zOTA3LTRjZmEtYmZlMS1kMTZjMWI1Nzc3ZDAiLCJpZCI6MzMyNzYyLCJpYXQiOjE3NTU0NTg3MTN9.8XfWl4gVoUCTZ1yMYHcHvmH_hSI4SJG_tPn6CSpg3pw'

        const popupContainer = document.getElementById('popup')
        const popupContent = document.getElementById('popup-content')
        const popupCloser = document.getElementById('popup-closer')

        const overlay = new ol.Overlay({
          element: popupContainer,
          autoPan: { animation: { duration: 250 } },
        })

        popupCloser.onclick = () => {
          overlay.setPosition(undefined)
          popupCloser.blur()
          return false
        }

        vectorSource = new ol.source.Vector()
        const vectorLayer = new ol.layer.Vector({
          source: vectorSource,
          style: new ol.style.Style({
            image: new ol.style.Icon({
              anchor: [0.5, 1],
              anchorXUnits: 'fraction',
              anchorYUnits: 'fraction',
              src: antoinePngBase64,
              scale: 0.15,
            }),
          }),
        })

        mapInstance = new ol.Map({
          target: 'map',
          layers: [
            new ol.layer.Tile({
              source: new ol.source.OSM(),
            }),
            vectorLayer,
          ],
          overlays: [overlay],
          view: new ol.View({ center: [0, 0], zoom: 2 }),
        })

        mapInstance.on('click', (evt) => {
          overlay.setPosition(undefined)
          const feature = mapInstance.forEachFeatureAtPixel(evt.pixel, f => f)
          if (feature) {
            const coordinates = feature
              .getGeometry()
              .getCoordinates()

            let content = '<strong>Propriétés</strong><br><hr>'
            const properties = feature.getProperties()
            for (const key in properties) {
              if (key !== 'geometry') {
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

        loadGeoJson()
        refreshTimer = setInterval(loadGeoJson, 10000)
      }

      const toggleViewMode = () => {
        is3dMode.value = !is3dMode.value
        if (olCesiumInstance) {
          olCesiumInstance.setEnabled(is3dMode.value)
        }
      }

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
        is3dMode,
        toggleViewMode,
      }
    },
  }).mount('#app')
})
