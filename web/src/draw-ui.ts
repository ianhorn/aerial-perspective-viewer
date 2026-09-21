// The drawing card: the tools, what to do next, the editor for the selected shape (label, notes, colour, size), Undo, Redo, Delete
// and Clear, and the export buttons. Everything is drawn again from the controller and the store whenever either changes, except
// the text boxes, which are left alone while they are being typed in.

import { exportName } from './draw-export.ts';
import { measuresOf } from './draw-geometry.ts';
import { COLOURS, type DrawFeature, type DrawStore } from './draw-model.ts';
import { TOOL_LIST, type DrawController } from './draw-tool.ts';
import { formatArea, formatLength } from './measure.ts';

export interface Exporter {
  id: string;
  label: string;
  hint: string;
  extension: string;
  mime: string;
  /** The file's contents. May be asynchronous (the binary formats load a library first). */
  build(features: readonly DrawFeature[]): BlobPart | Promise<BlobPart>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};
const button = (text: string, title: string, onClick: () => void, className = ''): HTMLButtonElement => {
  const b = el('button', className, text);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
};

/** Hand a file to the browser to save. */
export function download(name: string, mime: string, data: BlobPart): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const KIND_NAME: Record<DrawFeature['kind'], string> = { point: 'Point', line: 'Line', polygon: 'Polygon', rectangle: 'Rectangle', circle: 'Circle', text: 'Text' };

/** The size of a shape, as label and value rows. */
export function sizeRows(f: DrawFeature): [string, string][] {
  const m = measuresOf(f);
  const rows: [string, string][] = [];
  if (m.lengthFt !== undefined) rows.push(['Length', formatLength(m.lengthFt)]);
  if (m.radiusFt !== undefined) rows.push(['Radius', formatLength(m.radiusFt)]);
  if (m.areaSqFt !== undefined) rows.push(['Area', formatArea(m.areaSqFt)]);
  if (m.perimeterFt !== undefined) rows.push(['Perimeter', formatLength(m.perimeterFt)]);
  return rows;
}

export interface DrawUi {
  element: HTMLElement;
  /** Put the cursor in the label box of the selected shape (after a piece of text is placed, so it can be typed straight away). */
  focusLabel(): void;
}

export function createDrawBar(store: DrawStore, controller: DrawController, exporters: readonly Exporter[], now: () => Date = () => new Date()): DrawUi {
  const bar = el('div', 'draw-bar');
  bar.hidden = true;
  bar.setAttribute('aria-label', 'Drawing tools');

  const tools = el('div', 'draw-tools');
  tools.setAttribute('role', 'group');
  tools.setAttribute('aria-label', 'Drawing tools');
  const toolButtons = TOOL_LIST.map((t) => {
    const b = button(t.label, t.hint, () => controller.setTool(t.id));
    b.dataset.tool = t.id;
    tools.append(b);
    return b;
  });

  const prompt = el('p', 'draw-prompt');
  prompt.setAttribute('role', 'status');
  const notice = el('p', 'draw-notice');

  // The editor for the selected shape.
  const editor = el('div', 'draw-editor');
  const heading = el('div', 'draw-editor-heading');
  const labelLabel = el('label', 'draw-field', 'Label');
  const label = el('input');
  label.type = 'text';
  label.maxLength = 200;
  label.setAttribute('aria-label', 'Label');
  labelLabel.append(label);
  const notesLabel = el('label', 'draw-field', 'Notes');
  const notes = el('textarea');
  notes.rows = 2;
  notes.maxLength = 2000;
  notes.setAttribute('aria-label', 'Notes');
  notesLabel.append(notes);
  const swatches = el('div', 'draw-swatches');
  swatches.setAttribute('role', 'radiogroup');
  swatches.setAttribute('aria-label', 'Colour');
  const swatchButtons = COLOURS.map((colour) => {
    const b = el('button', 'draw-swatch');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', colour);
    b.title = colour;
    b.dataset.colour = colour;
    b.style.background = colour;
    b.addEventListener('click', () => { const id = controller.selected; if (id) store.update(id, { properties: { color: colour } }); });
    swatches.append(b);
    return b;
  });
  const sizes = el('dl', 'draw-sizes');
  const remove = button('Delete', 'Delete this shape (Delete)', () => controller.deleteSelected(), 'draw-delete');
  editor.append(heading, labelLabel, notesLabel, swatches, sizes, remove);

  // Change the selected shape's label and notes when the box is left (or Enter is pressed in the label), as one step of the history each.
  const commit = (field: 'label' | 'notes', box: HTMLInputElement | HTMLTextAreaElement): void => {
    const id = controller.selected;
    const f = id ? store.get(id) : undefined;
    if (f && f.properties[field] !== box.value) store.update(f.id, { properties: { [field]: box.value } });
  };
  label.addEventListener('change', () => commit('label', label));
  label.addEventListener('keydown', (e) => { if (e.key === 'Enter') label.blur(); });
  notes.addEventListener('change', () => commit('notes', notes));

  const finish = button('Finish', 'Finish the shape (Enter)', () => controller.finish(), 'draw-finish');
  const undo = button('Undo', 'Undo (Ctrl+Z)', () => store.undo());
  const redo = button('Redo', 'Redo (Ctrl+Shift+Z)', () => store.redo());
  const clear = button('Clear all', 'Remove everything drawn (can be undone)', () => {
    if (store.features.length === 0) return;
    if (store.features.length < 3 || window.confirm(`Remove all ${store.features.length} drawn features? (Undo brings them back.)`)) store.clear();
  }, 'draw-clear');
  const actions = el('div', 'draw-actions');
  actions.append(undo, redo, finish, clear);

  const exportBox = el('div', 'draw-export');
  exportBox.append(el('span', 'draw-export-label', 'Export'));
  const exportButtons = exporters.map((x) => {
    const b = button(x.label, x.hint, () => {
      exporting = true;
      render();
      Promise.resolve(x.build(store.features))
        .then((data) => download(exportName(x.extension, now()), x.mime, data))
        .catch((error: unknown) => { console.error(`could not export ${x.label}`, error); controller.notice = `The ${x.label} file could not be made.`; })
        .finally(() => { exporting = false; render(); });
    });
    b.dataset.export = x.id;
    exportBox.append(b);
    return b;
  });
  const count = el('span', 'draw-count');
  exportBox.append(count);

  bar.append(tools, prompt, notice, editor, actions, exportBox);

  let focusRequested = false;
  let exporting = false; // a file is being made
  const render = (): void => {
    bar.hidden = !controller.active;
    if (!controller.active) return;
    toolButtons.forEach((b) => b.setAttribute('aria-pressed', String(controller.tool === b.dataset.tool)));
    prompt.textContent = controller.prompt;
    notice.textContent = controller.notice ?? '';
    notice.hidden = controller.notice === null;

    const f = controller.selectedFeature;
    editor.hidden = !f;
    if (f) {
      heading.textContent = KIND_NAME[f.kind];
      if (document.activeElement !== label) label.value = f.properties.label;
      if (document.activeElement !== notes) notes.value = f.properties.notes;
      label.placeholder = f.kind === 'text' ? 'The text' : 'Optional';
      swatchButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.colour === f.properties.color)));
      sizes.replaceChildren(...sizeRows(f).flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]));
      if (focusRequested) { focusRequested = false; label.focus(); label.select(); }
    }
    finish.hidden = !(controller.draft && (controller.draft.tool === 'line' || controller.draft.tool === 'polygon'));
    undo.disabled = !store.canUndo;
    redo.disabled = !store.canRedo;
    clear.disabled = store.features.length === 0;
    exportButtons.forEach((b) => { b.disabled = exporting || store.features.length === 0; });
    count.textContent = store.features.length === 1 ? '1 feature' : `${store.features.length} features`;
  };
  controller.subscribe(render);
  store.subscribe(render);
  render();

  return { element: bar, focusLabel: () => { focusRequested = true; render(); } };
}
