import type { ImageSource, Map as MapLibreMap } from 'maplibre-gl';
import type { LngLat } from './scene.ts';

const SOURCE = 'drape';
const LAYER = 'drape';
let objectUrl: string | undefined;

function toBlobUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error('the photo could not be encoded'))), 'image/jpeg', 0.92);
  });
}

/** Put a decoded photo on the map at the four ground corners (top-left, top-right, bottom-right, bottom-left), under the footprint outline. */
export async function showDrape(map: MapLibreMap, canvas: HTMLCanvasElement, corners: [LngLat, LngLat, LngLat, LngLat]): Promise<void> {
  const url = await toBlobUrl(canvas);
  const previous = objectUrl;
  objectUrl = url;
  const source = map.getSource<ImageSource>(SOURCE);
  if (source) {
    source.updateImage({ url, coordinates: corners });
  } else {
    map.addSource(SOURCE, { type: 'image', url, coordinates: corners });
    map.addLayer(
      { id: LAYER, type: 'raster', source: SOURCE, paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' } },
      map.getLayer('frame-fill') ? 'frame-fill' : undefined,
    );
  }
  if (previous) setTimeout(() => URL.revokeObjectURL(previous), 5000); // the old image may still be on screen while the new one loads
}

export function clearDrape(map: MapLibreMap): void {
  if (map.getLayer(LAYER)) map.removeLayer(LAYER);
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined;
}
