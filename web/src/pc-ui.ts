// The point cloud card: two ways to choose the area (the current view, or a rectangle drawn on the map), what is happening, Stop and Clear,
// and a legend for the colours. It is drawn again from the session whenever that changes.

import type { AreaPicker } from './pc-pick.ts';
import { RAMP_CSS } from './pc-ramp.ts';
import type { PcSession } from './pc-session.ts';
import { heightLabel, limitsText, statusLines } from './pc-text.ts';
import type { PcLimits } from './settings.ts';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};
const button = (text: string, title: string, onClick: () => void): HTMLButtonElement => {
  const b = el('button', '', text);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
};

export interface PcUi {
  element: HTMLElement;
  render(): void;
}

/** How the cloud is looked at: standing up in 3D or flat on the map (and how much the height is stretched), and the map's tilt. */
export interface Look {
  threeD: boolean;
  exaggeration: number;
  /** Whether the map is tilted now. */
  tilted(): boolean;
  set(threeD: boolean, exaggeration: number): void;
  /** Tilt the map to look at the cloud from the side, or level it again. */
  toggleTilt(): void;
}

/** Whether finer detail is added as the map is zoomed in and moved. */
export interface Detail {
  on: boolean;
  set(on: boolean): void;
}

export const EXAGGERATIONS = [1, 2, 3, 5] as const;

export function createPointCloudBar(session: PcSession, picker: AreaPicker, useView: () => void, startPicking: () => void, look: Look, detail: Detail, limits: () => PcLimits): PcUi {
  const bar = el('div', 'draw-bar pc-bar');
  bar.hidden = true;
  bar.setAttribute('aria-label', 'Point cloud');

  bar.append(el('div', 'draw-editor-heading', 'Point cloud'), el('p', 'draw-prompt', 'KyFromAbove lidar, coloured by height. Phase 3 where it has been flown, Phase 2 elsewhere.'));

  const choose = el('div', 'draw-tools');
  const viewButton = button('Use current view', 'Load the point cloud for what is on the map now', useView);
  const drawButton = button('Draw an area', 'Click two corners on the map to choose the area', startPicking);
  choose.append(viewButton, drawButton);

  const prompt = el('p', 'draw-prompt pc-prompt');
  prompt.setAttribute('role', 'status');
  const status = el('div', 'pc-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const notes = el('div', 'pc-notes');
  const error = el('p', 'draw-notice pc-error');
  const problem = el('p', 'draw-notice pc-detail-problem');

  const actions = el('div', 'draw-actions');
  const stop = button('Stop', 'Stop loading. What has arrived stays on the map.', () => session.cancel());
  const clear = button('Clear point cloud', 'Take the points off the map', () => session.clear());
  actions.append(stop, clear);

  // How the points are drawn: standing up at their height (3D), or flat on the map; how much the height is stretched; and a tilt for the map.
  const heightRow = el('div', 'draw-tools pc-height');
  heightRow.setAttribute('role', 'group');
  heightRow.setAttribute('aria-label', 'Height');
  heightRow.append(el('span', 'pc-height-label', 'Height'));
  const threeDButton = button('3D', 'Points stand up at their height. Tilt the map to see it.', () => { look.set(true, look.exaggeration); render(); });
  const flatButton = button('Flat', 'Points lie flat on the map, lined up with the imagery, coloured by height', () => { look.set(false, look.exaggeration); render(); });
  const stretch = el('select');
  stretch.setAttribute('aria-label', 'Height exaggeration');
  stretch.title = 'How much the height is stretched';
  for (const x of EXAGGERATIONS) stretch.append(new Option(`${x}×`, String(x)));
  stretch.value = String(look.exaggeration);
  stretch.addEventListener('change', () => { look.set(look.threeD, Number(stretch.value)); render(); });
  const tiltButton = button('Tilt', 'Tilt the map to look at the cloud from the side, or level it again', () => { look.toggleTilt(); setTimeout(render, 700); });
  heightRow.append(threeDButton, flatButton, stretch, tiltButton);

  const follow = el('label', 'pc-follow');
  const followBox = el('input');
  followBox.type = 'checkbox';
  followBox.checked = detail.on;
  followBox.addEventListener('change', () => detail.set(followBox.checked));
  follow.append(followBox, document.createTextNode(' Add detail as you zoom in'));
  follow.title = 'Read finer detail for what is on the screen when you zoom in, within the area loaded, and drop what is far off the screen if the map gets full';

  const limitsLine = el('p', 'draw-prompt pc-limits');

  const legend = el('div', 'pc-legend');
  const ramp = el('div', 'pc-ramp');
  ramp.style.background = RAMP_CSS;
  const ends = el('div', 'pc-ramp-ends');
  const low = el('span'), high = el('span');
  ends.append(low, el('span', '', 'height'), high);
  legend.append(ramp, ends);

  bar.append(choose, prompt, status, notes, error, problem, actions, heightRow, follow, legend, limitsLine);

  const render = (): void => {
    const r = session.report;
    const loading = session.loading;
    viewButton.disabled = drawButton.disabled = loading || picker.active;
    drawButton.setAttribute('aria-pressed', String(picker.active));
    prompt.textContent = picker.active ? (picker.notice ?? picker.prompt) : '';
    prompt.hidden = !picker.active;
    status.replaceChildren(...statusLines(r).map((line) => el('p', '', line)));
    notes.replaceChildren(...r.notes.map((line) => el('p', 'draw-notice', line)));
    error.textContent = r.error ?? '';
    error.hidden = r.error === null;
    problem.textContent = r.detailProblem ?? '';
    problem.hidden = r.detailProblem === null;
    threeDButton.setAttribute('aria-pressed', String(look.threeD));
    flatButton.setAttribute('aria-pressed', String(!look.threeD));
    stretch.disabled = !look.threeD;
    tiltButton.setAttribute('aria-pressed', String(look.tilted()));
    const l = limits();
    limitsLine.textContent = limitsText(l.areaSqMi, l.budget.maxPoints);
    stop.hidden = !loading;
    clear.disabled = r.points === 0 && !loading;
    legend.hidden = !session.range;
    if (session.range) { low.textContent = heightLabel(session.range[0]); high.textContent = heightLabel(session.range[1]); }
  };
  session.subscribe(render);
  render();
  return { element: bar, render };
}
