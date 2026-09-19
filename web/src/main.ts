import { AttributionControl, Map as MapLibreMap, Marker, NavigationControl, ScaleControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { BASEMAP, KENTUCKY_BOUNDS, MAX_BOUNDS } from './config';

const map = new MapLibreMap({
  container: 'map',
  style: {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [BASEMAP.tiles],
        tileSize: BASEMAP.tileSize,
        minzoom: 0,
        maxzoom: BASEMAP.maxzoom,
        attribution: BASEMAP.attribution,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#1b1f24' } },
      { id: 'basemap', type: 'raster', source: 'basemap' },
    ],
  },
  bounds: KENTUCKY_BOUNDS,
  fitBoundsOptions: { padding: 24 },
  maxBounds: MAX_BOUNDS,
  attributionControl: false,
});

map.addControl(new NavigationControl({ showCompass: true }), 'top-right');
map.addControl(new ScaleControl({ unit: 'imperial' }), 'bottom-left');
map.addControl(new AttributionControl({ compact: true }), 'bottom-right');

const status = document.getElementById('status')!;
let marker: Marker | undefined;

// The point the user picked. Looking up the frames that cover it comes next.
function selectPoint(lng: number, lat: number): void {
  marker ??= new Marker({ color: '#e53935' });
  marker.setLngLat([lng, lat]).addTo(map);
  status.textContent = '';
  const line = document.createElement('span');
  line.className = 'coords';
  line.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  status.append('Selected ', line);
}

map.on('click', (e) => selectPoint(e.lngLat.lng, e.lngLat.lat));
