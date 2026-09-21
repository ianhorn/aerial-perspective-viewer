// The settings card: every setting as a slider with its value, what it does, and a way to put it back; and a button to put them all back. It is drawn
// once and updated in place when a setting changes (so a slider being dragged keeps the pointer).

import { DEFS, KEYS, type Group, type SettingKey, type Settings } from './settings.ts';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};

const GROUPS: Group[] = ['Point cloud', 'Photos'];

export interface SettingsUi {
  element: HTMLElement;
  setOpen(open: boolean): void;
}

export function createSettingsBar(settings: Settings): SettingsUi {
  const bar = el('div', 'draw-bar settings-bar');
  bar.hidden = true;
  bar.setAttribute('aria-label', 'Settings');
  bar.append(el('div', 'settings-title', 'Settings'), el('p', 'settings-lead', 'Kept in this browser. Bigger numbers use more memory, data and time.'));

  const rows = new Map<SettingKey, { input: HTMLInputElement; value: HTMLElement; reset: HTMLButtonElement }>();
  for (const group of GROUPS) {
    bar.append(el('div', 'settings-group', group));
    for (const key of KEYS.filter((k) => DEFS[k].group === group)) {
      const d = DEFS[key];
      const row = el('div', 'settings-row');
      const head = el('div', 'settings-head');
      const label = el('label', 'settings-label', d.label);
      const value = el('span', 'settings-value');
      const reset = el('button', 'settings-reset', '↺');
      reset.type = 'button';
      reset.title = `Back to ${d.default}${d.unit ? ' ' + d.unit : ''}`;
      reset.setAttribute('aria-label', `Reset ${d.label}`);
      reset.addEventListener('click', () => settings.reset(key));
      head.append(label, value, reset);
      const input = el('input');
      input.type = 'range';
      input.min = String(d.min);
      input.max = String(d.max);
      input.step = String(d.step);
      input.id = `setting-${key}`;
      label.htmlFor = input.id;
      input.addEventListener('input', () => settings.set(key, Number(input.value)));
      row.append(head, input, el('p', 'settings-hint', d.hint));
      bar.append(row);
      rows.set(key, { input, value, reset });
    }
  }
  const resetAll = el('button', 'settings-reset-all', 'Reset all to the defaults');
  resetAll.type = 'button';
  resetAll.addEventListener('click', () => settings.reset());
  bar.append(resetAll);

  const render = (): void => {
    for (const [key, r] of rows) {
      const d = DEFS[key];
      const v = settings.get(key);
      if (document.activeElement !== r.input || r.input.value !== String(v)) r.input.value = String(v);
      r.value.textContent = `${v}${d.unit ? ' ' + d.unit : ''}`;
      r.reset.hidden = settings.isDefault(key);
    }
    resetAll.disabled = !settings.changed;
  };
  settings.subscribe(render);
  render();

  return { element: bar, setOpen: (open) => { bar.hidden = !open; } };
}
