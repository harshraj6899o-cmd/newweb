<script>
/**
 * PathNER - 3D GIS Operations & Tactical Map Engine
 * Powered by MapLibre GL JS + Real Elevation 3D Terrain + Road-Snapped NER Routes
 */

// ====== 1. CONFIG — put your key here ======
const NER_MAP_CONFIG = {
  // Free OSM-based routing key: https://openrouteservice.org/dev/#/signup
  ORS_API_KEY: 'YOUR_OPENROUTESERVICE_API_KEY_HERE',
  // Force OSRM's free public demo server instead of ORS (no key, but rate-limited)
  USE_OSRM_FALLBACK_ONLY: false,
  ROUTE_PROFILE: 'driving-car',      // ORS profile
  CACHE_KEY_PREFIX: 'ner_route_cache_v1_'
};

// ====== 2. Routing service: turns straight waypoints into real road-following paths ======
class NERRoutingService {
  constructor(config) {
    this.config = config;
    this.memCache = new Map();
  }

  cacheKey(coords, profile) {
    return this.config.CACHE_KEY_PREFIX + profile + '_' + JSON.stringify(coords);
  }

  async getRoadSnappedRoute(coords, profile = this.config.ROUTE_PROFILE) {
    const key = this.cacheKey(coords, profile);
    if (this.memCache.has(key)) return this.memCache.get(key);

    try {
      const cached = localStorage.getItem(key);
      if (cached) {
        const parsed = JSON.parse(cached);
        this.memCache.set(key, parsed);
        return parsed;
      }
    } catch (e) { /* storage unavailable, ignore */ }

    let geometry = null;

    const hasKey = this.config.ORS_API_KEY &&
      this.config.ORS_API_KEY !== 'YOUR_OPENROUTESERVICE_API_KEY_HERE';

    if (hasKey && !this.config.USE_OSRM_FALLBACK_ONLY) {
      geometry = await this.fetchFromORS(coords, profile);
    }
    if (!geometry) {
      geometry = await this.fetchFromOSRM(coords);
    }
    if (!geometry) {
      geometry = coords; // last-resort fallback: original straight waypoints
    }

    this.memCache.set(key, geometry);
    try { localStorage.setItem(key, JSON.stringify(geometry)); } catch (e) {}
    return geometry;
  }

  async fetchFromORS(coords, profile) {
    try {
      const res = await fetch(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
        method: 'POST',
        headers: {
          'Authorization': this.config.ORS_API_KEY,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ coordinates: coords })
      });
      if (!res.ok) throw new Error('ORS HTTP ' + res.status);
      const data = await res.json();
      return data.features[0].geometry.coordinates;
    } catch (err) {
      console.warn('ORS routing failed, trying OSRM fallback:', err.message);
      return null;
    }
  }

  async fetchFromOSRM(coords) {
    try {
      const coordStr = coords.map(c => c.join(',')).join(';');
      const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`);
      if (!res.ok) throw new Error('OSRM HTTP ' + res.status);
      const data = await res.json();
      if (!data.routes || !data.routes[0]) throw new Error('No OSRM route found');
      return data.routes[0].geometry.coordinates;
    } catch (err) {
      console.warn('OSRM routing failed, using straight-line fallback:', err.message);
      return null;
    }
  }
}

// ====== 3. Map engine ======
class PathNERMapEngine {
  constructor(containerId = 'map') {
    this.containerId = containerId;
    this.map = null;
    this.is3D = true;
    this.isSatellite = true;
    this.isRotating = false;
    this.rotationAnimId = null;
    this.vehicleMarkers = {};
    this.hazardMarkers = [];
    this.animatedFleetTimer = null;
    this.isTerrainLoaded = false;
    this.isInitialized = false;

    // Road-snapping state
    this.routingService = new NERRoutingService(NER_MAP_CONFIG);
    this.roadSnappedCache = {};
    this.isSnappingRoutes = false;
    this.allRoutesSnapped = false;
    this._routeClickBound = false;
  }

  init() {
    if (this.isInitialized) return;
    const container = document.getElementById(this.containerId);
    if (!container) return;

    if (typeof maplibregl === 'undefined') {
      console.warn('MapLibre GL not loaded yet');
      return;
    }

    try {
      this.map = new maplibregl.Map({
        container: this.containerId,
        style: this.getSatelliteStyle(),
        center: [92.8, 25.9],
        zoom: 6.8,
        pitch: 52,
        bearing: -15,
        maxPitch: 85,
        antialias: true
      });

      this.map.addControl(new maplibregl.NavigationControl({
        visualizePitch: true,
        showCompass: true,
        showZoom: true
      }), 'top-right');

      this.map.addControl(new maplibregl.ScaleControl({
        maxWidth: 120,
        unit: 'metric' }), 'bottom-left');

      this.map.on('load', () => {
        this.setup3DTerrain();
        if (this.is3D) this.add3DBuildings();
        this.addRouteLayers();
        this.addLandslideColumns();
        this.setupFleetMarkers();
        this.startFleetAnimation();
        this.isInitialized = true;

        const statusEl = document.getElementById('mapStatusText');
        if (statusEl) statusEl.textContent = '3D Terrain Active — Fetching real road routes...';
      });

      this.map.on('error', (e) => {
        console.warn('Map notice:', e?.error?.message || e);
      });
    } catch (err) {
      console.error('Map init error:', err);
    }
  }

  getSatelliteStyle() {
    return {
      version: 8,
      sources: {
        'esri-satellite': {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          attribution: 'Esri, Maxar, Earthstar Geographics' },
        'carto-labels': {
          type: 'raster',
          tiles: ['https://cartodb-basemaps-a.global.ssl.fastly.net/dark_only_labels/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: 'CARTO' },
        'terrain-dem': {
          type: 'raster-dem',
          tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 14
        }
      },
      layers: [
        { id: 'satellite-layer', type: 'raster', source: 'esri-satellite', minzoom: 0, maxzoom: 19 },
        { id: 'labels-layer', type: 'raster', source: 'carto-labels', minzoom: 4, maxzoom: 19, paint: { 'raster-opacity': 0.85 } }
      ],
      sky: {
        'sky-color': '#0d1612',
        'sky-horizon-blend': 0.7,
        'horizon-color': '#162820',
        'horizon-fog-blend': 0.8,
        'fog-color': '#0a100d',
        'fog-ground-blend': 0.6
      }
    };
  }

  getStreetStyle() {
    return {
      version: 8,
      sources: {
        'carto-dark': {
          type: 'raster',
          tiles: ['https://cartodb-basemaps-a.global.ssl.fastly.net/dark_all/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: 'CARTO, OpenStreetMap' },
        'terrain-dem': {
          type: 'raster-dem',
          tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 14
        }
      },
      layers: [
        { id: 'dark-street-layer', type: 'raster', source: 'carto-dark', minzoom: 0, maxzoom: 19 }
      ]
    };
  }

  setup3DTerrain() {
    if (!this.map || !this.map.getSource('terrain-dem')) return;
    try {
      this.map.setTerrain({ source: 'terrain-dem', exaggeration: 1.65 });
      this.isTerrainLoaded = true;
    } catch (e) {
      console.warn('3D Terrain notice:', e);
    }
  }

  // ---- Google-Maps-style 2D/3D toggle ----
  toggleTerrain(enable) {
    this.setViewMode(enable ? '3d' : '2d');
  }

  setViewMode(mode) {
    if (!this.map) return;
    this.is3D = (mode === '3d');

    if (this.is3D) {
      this.setup3DTerrain();
      this.map.easeTo({ pitch: 55, duration: 900 });
      this.add3DBuildings();
      this.map.dragRotate.enable();
      this.map.touchZoomRotate.enableRotation();
    } else {
      this.map.setTerrain(null);
      this.map.easeTo({ pitch: 0, bearing: 0, duration: 900 });
      this.remove3DBuildings();
      this.map.dragRotate.disable();
      this.map.touchZoomRotate.disableRotation();
    }
  }

  // ---- Real 3D buildings (OSM vector tiles, no key needed) ----
  add3DBuildings() {
    if (!this.map || this.map.getLayer('ner-3d-buildings')) return;
    try {
      if (!this.map.getSource('openfreemap-buildings')) {
        this.map.addSource('openfreemap-buildings', {
          type: 'vector',
          url: 'https://tiles.openfreemap.org/planet' });
      }
      this.map.addLayer({
        id: 'ner-3d-buildings',
        type: 'fill-extrusion',
        source: 'openfreemap-buildings',
        'source-layer': 'building',
        minzoom: 13,
        paint: {
          'fill-extrusion-color': '#3a4750',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 12],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.85
        }
      });
    } catch (e) {
      console.warn('3D buildings layer unavailable:', e);
    }
  }

  remove3DBuildings() {
    if (this.map && this.map.getLayer('ner-3d-buildings')) {
      this.map.removeLayer('ner-3d-buildings');
    }
  }

  setBasemap(type) {
    if (!this.map) return;
    this.isSatellite = (type === 'satellite');
    const currentCenter = this.map.getCenter();
    const currentZoom = this.map.getZoom();
    const currentPitch = this.map.getPitch();
    const currentBearing = this.map.getBearing();

    const newStyle = this.isSatellite ? this.getSatelliteStyle() : this.getStreetStyle();
    this.map.setStyle(newStyle);

    this.map.once('style.load', () => {
      this.map.setCenter(currentCenter);
      this.map.setZoom(currentZoom);
      this.map.setPitch(currentPitch);
      this.map.setBearing(currentBearing);
      if (this.is3D) {
        this.setup3DTerrain();
        this.add3DBuildings();
      }
      this._routeClickBound = false; // layers wiped by setStyle, rebind
      this.addRouteLayers();
      this.addLandslideColumns();
      this.setupFleetMarkers();
    });
  }

  // ---- Routes: draw instantly with straight lines, then swap in real road geometry ----
  addRouteLayers() {
    if (!this.map || typeof PATHNER_DATA === 'undefined') return;

    const primaryFeatures = PATHNER_DATA.routes.map(r => ({
      type: 'Feature',
      properties: {
        id: r.id,
        name: r.name,
        highway: r.highway,
        status: r.status,
        color: r.status === 'normal' ? '#3fe08a' : (r.status === 'restricted' ? '#f59e0b' : '#ef4444'),
        delay: r.delayEstimateMins,
        hazard: r.hazardSummary
      },
      geometry: {
        type: 'LineString',
        coordinates: (this.roadSnappedCache[r.id] && this.roadSnappedCache[r.id].primary) || r.primaryPath
      }
    }));

    const alternateFeatures = PATHNER_DATA.routes.map(r => ({
      type: 'Feature',
      properties: {
        id: r.id + '-alt',
        routeId: r.id,
        name: 'Safe Alternate: ' + r.name,
        highway: 'AI Recommended Bypass',
        color: '#38bdf8' },
      geometry: {
        type: 'LineString',
        coordinates: (this.roadSnappedCache[r.id] && this.roadSnappedCache[r.id].alternate) || r.alternateSafePath
      }
    }));

    if (!this.map.getSource('ner-routes-source')) {
      this.map.addSource('ner-routes-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: primaryFeatures }
      });
      this.map.addLayer({
        id: 'ner-routes-casing', type: 'line', source: 'ner-routes-source',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#000000', 'line-width': 7, 'line-opacity': 0.8 }
      });
      this.map.addLayer({
        id: 'ner-routes-line', type: 'line', source: 'ner-routes-source',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 4.5, 'line-opacity': 0.95 }
      });
    } else {
      this.map.getSource('ner-routes-source').setData({ type: 'FeatureCollection', features: primaryFeatures });
    }

    if (!this.map.getSource('ner-alt-routes-source')) {
      this.map.addSource('ner-alt-routes-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: alternateFeatures }
      });
      this.map.addLayer({
        id: 'ner-alt-routes-line', type: 'line', source: 'ner-alt-routes-source',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#38bdf8', 'line-width': 3, 'line-dasharray': [2, 2], 'line-opacity': 0.85 }
      });
    } else {
      this.map.getSource('ner-alt-routes-source').setData({ type: 'FeatureCollection', features: alternateFeatures });
    }

    if (!this._routeClickBound) {
      this.map.on('click', 'ner-routes-line', (e) => {
        const props = e.features[0].properties;
        new maplibregl.Popup({ className: 'pathner-map-popup', maxWidth: '320px' })
          .setLngLat(e.lngLat)
          .setHTML(`
            <div class="map-pop-card">
              <div class="pop-badge pop-${props.status}">${props.status.toUpperCase()}</div>
              <div class="pop-title">${props.name}</div>
              <div class="pop-meta"><b>Highway:</b> ${props.highway}</div>
              <div class="pop-meta"><b>Est. Delay:</b> +${props.delay} mins</div>
              <div class="pop-desc">${props.hazard}</div>
              <button class="pop-btn" onclick="window.PathNERApp?.selectRoute('${props.id}')">Inspect Route in Optimizer</button>
            </div>
          `)
          .addTo(this.map);
      });
      this.map.on('mouseenter', 'ner-routes-line', () => { this.map.getCanvas().style.cursor = 'pointer'; });
      this.map.on('mouseleave', 'ner-routes-line', () => { this.map.getCanvas().style.cursor = ''; });
      this._routeClickBound = true;
    }

    this.enhanceRoutesWithRoadSnapping();
  }

  async enhanceRoutesWithRoadSnapping() {
    if (this.isSnappingRoutes || this.allRoutesSnapped) return;
    this.isSnappingRoutes = true;

    const statusEl = document.getElementById('mapStatusText');
    if (statusEl) statusEl.textContent = 'Snapping NER routes to real roads (OSM)...';

    await Promise.all(PATHNER_DATA.routes.map(async (r) => {
      if (this.roadSnappedCache[r.id]) return;
      const [primary, alternate] = await Promise.all([
        this.routingService.getRoadSnappedRoute(r.primaryPath),
        this.routingService.getRoadSnappedRoute(r.alternateSafePath)
      ]);
      this.roadSnappedCache[r.id] = { primary, alternate };
    }));

    this.allRoutesSnapped = true;
    this.isSnappingRoutes = false;

    this.addRouteLayers(); // redraw with real geometry (cache hit, no refetch)

    if (statusEl) statusEl.textContent = 'Live Corridors Active — Real Road-Snapped Routes (OpenStreetMap)';
  }

  addLandslideColumns() {
    if (!this.map || typeof PATHNER_DATA === 'undefined') return;

    const features = PATHNER_DATA.landslideZones.map(zone => {
      const [lng, lat] = zone.coordinates;
      const radius = 0.025;
      const coords = [];
      for (let i = 0; i <= 6; i++) {
        const angle = (i * 60 * Math.PI) / 180;
        coords.push([lng + radius * Math.cos(angle), lat + radius * Math.sin(angle) * 0.9]);
      }
      return {
        type: 'Feature',
        properties: {
          id: zone.id, name: zone.name, highway: zone.highway, state: zone.state,
          severity: zone.severity, height: zone.columnHeight, rainfall: zone.currentRainfallMm,
          threshold: zone.rainfallThresholdMm, status: zone.status, geology: zone.geology,
          nearestBRO: zone.nearestBRO,
          color: zone.severity === 'high' ? '#ef4444' : (zone.severity === 'moderate' ? '#f59e0b' : '#3fe08a')
        },
        geometry: { type: 'Polygon', coordinates: [coords] }
      };
    });

    if (!this.map.getSource('landslide-3d-source')) {
      this.map.addSource('landslide-3d-source', { type: 'geojson', data: { type: 'FeatureCollection', features } });
      this.map.addLayer({
        id: 'landslide-3d-extrusion', type: 'fill-extrusion', source: 'landslide-3d-source',
        paint: {
          'fill-extrusion-color': ['get', 'color'],
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.88
        }
      });
      this.map.addLayer({
        id: 'landslide-3d-ground', type: 'line', source: 'landslide-3d-source',
        paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.9 }
      });
    }

    this.map.on('click', 'landslide-3d-extrusion', (e) => {
      const p = e.features[0].properties;
      new maplibregl.Popup({ className: 'pathner-map-popup', maxWidth: '340px' })
        .setLngLat(e.lngLat)
        .setHTML(`
          <div class="map-pop-card">
            <div class="pop-badge pop-high">3D HAZARD COLUMN: ${p.severity.toUpperCase()}</div>
            <div class="pop-title">${p.name}</div>
            <div class="pop-meta"><b>Location:</b> ${p.highway} (${p.state})</div>
            <div class="pop-meta"><b>Precipitation:</b> ${p.rainfall}mm (Threshold: ${p.threshold}mm)</div>
            <div class="pop-meta"><b>Status:</b> ${p.status}</div>
            <div class="pop-desc"><b>Geology:</b> ${p.geology}</div>
            <div class="pop-sub">BRO Post: ${p.nearestBRO}</div>
          </div>
        `)
        .addTo(this.map);
    });
    this.map.on('mouseenter', 'landslide-3d-extrusion', () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', 'landslide-3d-extrusion', () => { this.map.getCanvas().style.cursor = ''; });
  }

  setupFleetMarkers() {
    if (!this.map || typeof PATHNER_DATA === 'undefined') return;
    Object.values(this.vehicleMarkers).forEach(m => m.remove());
    this.vehicleMarkers = {};

    PATHNER_DATA.fleet.forEach(v => {
      const el = document.createElement('div');
      el.className = `fleet-map-pin pin-${v.status} pin-cat-${v.cargoCategory}`;
      el.innerHTML = `
        <div class="pin-pulse"></div>
        <div class="pin-icon">
          ${v.cargoCategory === 'cold_chain' ? '' : (v.cargoCategory === 'fuel' ? '' : (v.cargoCategory === 'food' ? '' : ''))}
        </div>
        <div class="pin-tag">${v.vehicleNumber}</div>
      `;
      el.addEventListener('click', () => { this.inspectVehicle(v.id); });
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(v.coordinates).addTo(this.map);
      this.vehicleMarkers[v.id] = marker;
    });
  }

  inspectVehicle(vehicleId) {
    if (typeof PATHNER_DATA === 'undefined') return;
    const v = PATHNER_DATA.fleet.find(x => x.id === vehicleId);
    if (!v || !this.map) return;

    this.map.flyTo({ center: v.coordinates, zoom: 11.5, pitch: 62, bearing: (v.heading || 0) - 20, duration: 1500 });

    const isColdChain = v.cargoCategory === 'cold_chain';
    const tempHtml = isColdChain ? `
      <div class="pop-temp-box">
        <span class="temp-val">${v.temperatureC}°C</span>
        <span class="temp-status">Cold-Chain Secure (Safe: ${v.tempSafeMin}°C - ${v.tempSafeMax}°C)</span>
      </div>` : '';

    new maplibregl.Popup({ className: 'pathner-map-popup', maxWidth: '340px' })
      .setLngLat(v.coordinates)
      .setHTML(`
        <div class="map-pop-card">
          <div class="pop-badge pop-${v.status}">${v.status.toUpperCase()}</div>
          <div class="pop-title">${v.vehicleNumber} · ${v.carrierName}</div>
          <div class="pop-meta"><b>Cargo:</b> ${v.cargoType} (${v.cargoWeightTons} Tons)</div>
          ${tempHtml}
          <div class="pop-meta"><b>Driver:</b> ${v.driverName} (${v.driverContact})</div>
          <div class="pop-meta"><b>Route:</b> ${v.origin} → ${v.destination}</div>
          <div class="pop-meta"><b>Speed:</b> ${v.currentSpeedKmh} km/h | <b>Fuel:</b> ${v.fuelLevelPct}%</div>
          <div class="pop-desc">${v.hazardAlert}</div>
          <div style="display:flex;gap:6px;margin-top:8px;">
            <button class="pop-btn" onclick="window.PathNERApp?.trackFleet('${v.id}')">View Telemetry</button>
            <button class="pop-btn pop-btn-sos" onclick="window.PathNERApp?.triggerSOS('${v.id}')">Simulate SOS</button>
          </div>
        </div>
      `)
      .addTo(this.map);
  }

  startFleetAnimation() {
    if (this.animatedFleetTimer) clearInterval(this.animatedFleetTimer);
    this.animatedFleetTimer = setInterval(() => {
      if (!this.map || typeof PATHNER_DATA === 'undefined') return;
      PATHNER_DATA.fleet.forEach(v => {
        if (v.status === 'delayed' || v.status === 'halted') return;
        const route = PATHNER_DATA.routes.find(r => r.id === v.routeId);
        if (!route) return;

        v.progressPct = (v.progressPct + 0.35);
        if (v.progressPct > 98) v.progressPct = 5;

        const snapped = this.roadSnappedCache[route.id];
        const path = (v.status === 'rerouted')
          ? ((snapped && snapped.alternate) || route.alternateSafePath)
          : ((snapped && snapped.primary) || route.primaryPath);

        const totalSegments = path.length - 1;
        const globalT = (v.progressPct / 100) * totalSegments;
        const segIndex = Math.min(Math.floor(globalT), totalSegments - 1);
        const t = globalT - segIndex;

        const p1 = path[segIndex];
        const p2 = path[segIndex + 1] || p1;
        const currentLng = p1[0] + (p2[0] - p1[0]) * t;
        const currentLat = p1[1] + (p2[1] - p1[1]) * t;
        v.coordinates = [currentLng, currentLat];

        if (this.vehicleMarkers[v.id]) this.vehicleMarkers[v.id].setLngLat(v.coordinates);
      });
    }, 1800);
  }

  flyToBookmark(presetName) {
    if (!this.map) return;
    const presets = {
      overview: { center: [92.8, 25.9], zoom: 6.8, pitch: 52, bearing: -15 },
      tawang: { center: [91.95, 27.52], zoom: 10.5, pitch: 65, bearing: -30 },
      shillong: { center: [91.92, 25.55], zoom: 10.0, pitch: 60, bearing: 15 },
      kohima: { center: [94.10, 25.68], zoom: 10.2, pitch: 62, bearing: 40 },
      silchar: { center: [92.80, 24.83], zoom: 9.8, pitch: 50, bearing: -10 },
      gangtok: { center: [88.61, 27.33], zoom: 10.4, pitch: 65, bearing: 20 },
      sonapur: { center: [92.492, 25.110], zoom: 12.0, pitch: 70, bearing: -45 }
    };
    const target = presets[presetName] || presets.overview;
    this.map.flyTo({ ...target, duration: 2000, essential: true });
  }

  toggleAutoRotate() {
    if (!this.map) return false;
    this.isRotating = !this.isRotating;
    if (this.isRotating) {
      const rotateCamera = () => {
        if (!this.isRotating || !this.map) return;
        this.map.rotateTo((this.map.getBearing() + 0.25) % 360, { duration: 0 });
        this.rotationAnimId = requestAnimationFrame(rotateCamera);
      };
      rotateCamera();
    } else if (this.rotationAnimId) {
      cancelAnimationFrame(this.rotationAnimId);
    }
    return this.isRotating;
  }

  resize() {
    if (this.map) setTimeout(() => this.map.resize(), 150);
  }
}

window.PathNERMapEngine = PathNERMapEngine;
</script>