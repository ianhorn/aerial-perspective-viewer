import type { IControl, Map as MapLibreMap } from 'maplibre-gl';

/**
 * The zoom level in the Bing/Google numbering: 256 px tiles, level 0 the whole world in one tile. MapLibre
 * counts with 512 px tiles, so its zoom is one lower (its zoom 15 is level 16). The tile levels requested
 * from the basemap use this numbering too.
 */
export const bingLevel = (mapLibreZoom: number): number => mapLibreZoom + 1;

/**
 * The map scale as the denominator N of 1:N, in the Bing/Google convention: a screen at 96 dpi, and the true
 * ground distance at the given latitude (a Web Mercator pixel covers less ground the further from the equator).
 * At the equator this gives Bing's published 1:282 for level 21; at 38 degrees north the same level is 1:222.
 */
export function mapScale(mapLibreZoom: number, latitude: number, dpi = 96): number {
  const metresPerPixel = (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** bingLevel(mapLibreZoom);
  return (metresPerPixel * dpi) / 0.0254;
}

/**
 * The scale at which the photos are at their native resolution. At 96 dpi 1:256 is 0.222 ft of ground per
 * pixel, against the vendor's average of 0.217 ft. Zooming in further is allowed, but the picture is enlarged.
 */
export const NATIVE_SCALE = 256;

export type NativeState = 'coarser' | 'native' | 'enlarged';

/** How the current scale compares with native resolution: within 5% of it counts as native. */
export function compareToNative(scale: number): { state: NativeState; enlargement: number } {
  const enlargement = NATIVE_SCALE / scale; // 2 means each photo pixel covers 2 by 2 screen pixels
  if (enlargement > 1.05) return { state: 'enlarged', enlargement };
  if (enlargement >= 1 / 1.05) return { state: 'native', enlargement };
  return { state: 'coarser', enlargement };
}

/** "1:256", with thousands separators for the small scales ("1:1,128"). */
export const formatScale = (scale: number): string => `1:${Math.round(scale).toLocaleString('en-US')}`;

/** What the readout says: the level and scale, and, once the photos are at or past native resolution, that. */
export function describeScale(mapLibreZoom: number, latitude: number): { text: string; state: NativeState } {
  const scale = mapScale(mapLibreZoom, latitude);
  const { state, enlargement } = compareToNative(scale);
  const base = `Level ${bingLevel(mapLibreZoom).toFixed(1)} · ${formatScale(scale)}`;
  if (state === 'native') return { text: `${base} · native`, state };
  if (state === 'enlarged') return { text: `${base} · enlarged ${enlargement.toFixed(1)}×`, state };
  return { text: base, state };
}

const EXPLANATION =
  'Zoom level in the Bing/Google numbering (256 px tiles) and the map scale at 96 dpi. The photos are at native ' +
  'resolution at 1:256 (about 0.22 ft per pixel, level 20.8 in Kentucky). You can zoom in further, but the ' +
  'picture is then enlarged and looks soft.';

/** A small readout on the map, beside the scale bar: zoom level, map scale, and how it compares with native resolution. */
export class LevelControl implements IControl {
  private readonly box = document.createElement('div');
  private map?: MapLibreMap;
  private readonly update = (): void => {
    if (!this.map) return;
    const { text, state } = describeScale(this.map.getZoom(), this.map.getCenter().lat);
    this.box.textContent = text;
    this.box.dataset.native = state;
  };

  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map;
    this.box.className = 'maplibregl-ctrl level-control';
    this.box.title = EXPLANATION;
    map.on('move', this.update); // moving north or south changes the scale a little, and a zoom is a move too
    this.update();
    return this.box;
  }

  onRemove(): void {
    this.map?.off('move', this.update);
    this.box.remove();
    this.map = undefined;
  }
}
