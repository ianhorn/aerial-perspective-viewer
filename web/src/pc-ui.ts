// The point cloud card: two ways to choose the area (the current view, or a rectangle drawn on the map), what is happening, Stop and Clear,
// and a legend for the colours. It is drawn again from the session whenever that changes.

import type { AreaPicker } from './pc-pick.ts';
import { RAMP_CSS } from './pc-ramp.ts';
import type { PcSession } from './pc-session.ts';
import { heightLabel, LIMITS_TEXT, statusLines } from './pc-text.ts';

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

export function createPointCloudBar(session: PcSession, picker: AreaPicker, useView: () => void, startPicking: () => void): PcUi {
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

  const actions = el('div', 'draw-actions');
  const stop = button('Stop', 'Stop loading. What has arrived stays on the map.', () => session.cancel());
  const clear = button('Clear point cloud', 'Take the points off the map', () => session.clear());
  actions.append(stop, clear);

  const legend = el('div', 'pc-legend');
  const ramp = el('div', 'pc-ramp');
  ramp.style.background = RAMP_CSS;
  const ends = el('div', 'pc-ramp-ends');
  const low = el('span'), high = el('span');
  ends.append(low, el('span', '', 'height'), high);
  legend.append(ramp, ends);

  bar.append(choose, prompt, status, notes, error, actions, legend, el('p', 'draw-prompt pc-limits', LIMITS_TEXT));

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
    stop.hidden = !loading;
    clear.disabled = r.points === 0 && !loading;
    legend.hidden = !session.range;
    if (session.range) { low.textContent = heightLabel(session.range[0]); high.textContent = heightLabel(session.range[1]); }
  };
  session.subscribe(render);
  render();
  return { element: bar, render };
}
