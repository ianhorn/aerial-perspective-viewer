import type { ImageSource, Map as MapLibreMap } from 'maplibre-gl';
import type { LngLat } from './scene.ts';

export type Corners = [LngLat, LngLat, LngLat, LngLat];

function toBlobUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    // WebP keeps the clear parts (where the picture reaches past the photo) clear; a browser without it gets PNG, which does too.
    canvas.toBlob((blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error('the photo could not be encoded'))), 'image/webp', 0.92);
  });
}

export interface ImageOverlay {
  /**
   * Put a decoded picture on the map at four ground corners (top-left, top-right, bottom-right, bottom-left), under
   * the footprint outline and above any overlay made before this one. `visible` false keeps it ready but hidden.
   * Replacing a picture keeps the old one on screen until the new one has loaded.
   */
  show(map: MapLibreMap, canvas: HTMLCanvasElement, corners: Corners, visible?: boolean): Promise<void>;
  /** Show or hide it without removing it. Does nothing when there is none. */
  setVisible(map: MapLibreMap, visible: boolean): void;
  /** Take it off the map. */
  clear(map: MapLibreMap): void;
}

/** A picture laid on the map at ground corners, as an image source with a raster layer of the same name. */
export function createOverlay(id: string): ImageOverlay {
  let objectUrl: string | undefined;
  // Encoding a picture takes a moment. If the overlay is cleared (or shown again) in that moment, the older
  // `show` must not put its picture on the map afterwards, so each `show` and `clear` takes the next number.
  let version = 0;

  const setVisible = (map: MapLibreMap, visible: boolean): void => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  };

  return {
    async show(map, canvas, corners, visible = true) {
      const mine = ++version;
      const url = await toBlobUrl(canvas);
      if (mine !== version) { URL.revokeObjectURL(url); return; } // cleared, or replaced by a newer one, while encoding
      const previous = objectUrl;
      objectUrl = url;
      const source = map.getSource<ImageSource>(id);
      if (source) {
        source.updateImage({ url, coordinates: corners });
        setVisible(map, visible);
      } else {
        map.addSource(id, { type: 'image', url, coordinates: corners });
        map.addLayer(
          {
            id, type: 'raster', source: id, layout: { visibility: visible ? 'visible' : 'none' },
            paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
          },
          map.getLayer('frame-fill') ? 'frame-fill' : undefined,
        );
      }
      if (previous) setTimeout(() => URL.revokeObjectURL(previous), 5000); // the old picture may still be on screen while the new one loads
    },
    setVisible,
    clear(map) {
      version++;
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
    },
  };
}

/** The whole photo, as the small preview: always there while the scene is on and the photo is shown. */
const drape = createOverlay('drape');
export const showDrape = (map: MapLibreMap, canvas: HTMLCanvasElement, corners: Corners, visible = true): Promise<void> => drape.show(map, canvas, corners, visible);
export const setDrapeVisible = (map: MapLibreMap, visible: boolean): void => drape.setVisible(map, visible);
export const clearDrape = (map: MapLibreMap): void => drape.clear(map);
