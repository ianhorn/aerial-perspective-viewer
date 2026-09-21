// The point cloud feature, put together: the session, the area picker, the map layers and the card. It is loaded on first use (the
// first time the Point cloud button is pressed), so the page does not carry the point cloud libraries until then.

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { LonLat } from './pc-aoi.ts';
import { makeBrowserPool } from './pc-browser.ts';
import { PointCloudMap } from './pc-layer.ts';
import { AreaPicker } from './pc-pick.ts';
import { PcSession } from './pc-session.ts';
import { createPointCloudBar } from './pc-ui.ts';

export interface PointCloudFeature {
  /** Show or hide the card. Points already loaded stay on the map. */
  setOpen(open: boolean): void;
  /** Whether a click on the map is choosing a corner of an area. */
  readonly picking: boolean;
  click(at: { x: number; y: number }): void;
  move(at: { x: number; y: number }): void;
  /** Escape: stop choosing an area. Returns whether it did anything. */
  cancel(): boolean;
}

export function installPointCloud(map: MapLibreMap, stage: HTMLElement, before: string): PointCloudFeature {
  const layers = new PointCloudMap();
  layers.init(map, before);
  const session = new PcSession({ fetchFn: (url, init) => fetch(url, init), makePool: makeBrowserPool, sink: layers });
  session.subscribe(() => layers.layer.setRange(session.range));

  let ui: ReturnType<typeof createPointCloudBar>;
  const view = {
    project: (c: LonLat) => { const p = map.project(c); return { x: p.x, y: p.y }; },
    unproject: (p: { x: number; y: number }): LonLat => { const c = map.unproject([p.x, p.y]); return [c.lng, c.lat]; },
  };
  const picker = new AreaPicker(view, (ring) => { map.getCanvas().style.cursor = ''; void session.load(ring); }, () => {
    layers.setPreview(picker.preview());
    map.getCanvas().style.cursor = picker.active ? 'crosshair' : '';
    ui?.render();
  });
  const useView = (): void => {
    const { clientWidth: w, clientHeight: h } = map.getCanvas();
    void session.load([[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => view.unproject({ x: x!, y: y! })));
  };
  const look = {
    threeD: true,
    exaggeration: 1,
    tilted: () => map.getPitch() > 1,
    set(threeD: boolean, exaggeration: number) { look.threeD = threeD; look.exaggeration = exaggeration; layers.setHeight(threeD, exaggeration); },
    toggleTilt() { map.easeTo({ pitch: map.getPitch() > 1 ? 0 : 55, duration: 600 }); },
  };
  layers.setHeight(look.threeD, look.exaggeration);
  map.on('pitchend', () => ui?.render());
  ui = createPointCloudBar(session, picker, useView, () => picker.start(), look);
  stage.append(ui.element);

  return {
    setOpen(open) {
      ui.element.hidden = !open;
      if (!open) picker.cancel();
    },
    get picking() { return picker.active; },
    click: (at) => picker.click(at),
    move: (at) => picker.move(at),
    cancel: () => picker.cancel(),
  };
}
