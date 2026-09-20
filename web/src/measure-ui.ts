// The measuring toolbar and readout. One model can have several of these (in the photo pane, and over the map in a
// scene); each redraws itself from the model, so they always agree.
//
// The tool buttons never change size or number, and the readout is not part of the layout it sits beside: in the photo
// pane it floats over the photo, since a toolbar that grew or wrapped when a tool was chosen would push the photo down
// and move everything under the pointer in the middle of a measurement.

import { TOOLS, type MeasureModel } from './measure-model.ts';

const button = (text: string, className: string, title: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
};

/** A button for each tool. Choosing the tool that is on turns it off. */
export function createMeasureToolbar(model: MeasureModel): HTMLElement {
  const tools = document.createElement('div');
  tools.className = 'measure-tools';
  tools.setAttribute('role', 'group');
  tools.setAttribute('aria-label', 'Measuring tools');
  const buttons = TOOLS.map((tool) => {
    const b = button(tool.label, '', tool.hint, () => model.setTool(tool.id));
    b.dataset.tool = tool.id;
    tools.append(b);
    return b;
  });
  const render = (): void => buttons.forEach((b) => b.setAttribute('aria-pressed', String(model.tool === b.dataset.tool)));
  model.subscribe(render);
  render();
  return tools;
}

/** What to do next, the numbers, any warnings, and Undo and Clear. Hidden while no tool is on. */
export function createMeasureReadout(model: MeasureModel): HTMLElement {
  const readout = document.createElement('div');
  readout.className = 'measure-readout';
  readout.setAttribute('role', 'status');
  readout.setAttribute('aria-live', 'polite');
  const undo = button('Undo', 'measure-undo', 'Take back the last point (Backspace)', () => model.undo());
  const clear = button('Clear', 'measure-clear', 'Start again (Escape)', () => model.clear());
  const actions = document.createElement('div');
  actions.className = 'measure-actions';
  actions.append(undo, clear);

  const render = (): void => {
    const reading = model.reading();
    readout.hidden = !reading;
    if (!reading) return readout.replaceChildren();
    undo.disabled = model.isEmpty;
    clear.disabled = model.isEmpty && model.notice === null;
    const parts: HTMLElement[] = [];
    if (reading.rows.length > 0) {
      const list = document.createElement('dl');
      for (const row of reading.rows) {
        const term = document.createElement('dt');
        term.textContent = row.label;
        const value = document.createElement('dd');
        value.textContent = row.value;
        list.append(term, value);
      }
      parts.push(list);
    }
    const prompt = document.createElement('p');
    prompt.className = 'prompt';
    prompt.textContent = reading.prompt;
    parts.push(prompt);
    for (const text of reading.warnings) {
      const p = document.createElement('p');
      p.className = 'warning';
      p.textContent = text;
      parts.push(p);
    }
    readout.replaceChildren(...parts, actions);
  };
  model.subscribe(render);
  render();
  return readout;
}

/** The toolbar and the readout together, as one card: for over the map in a scene. */
export function createMeasureBar(model: MeasureModel, className = ''): HTMLElement {
  const bar = document.createElement('div');
  bar.className = `measure-bar ${className}`.trim();
  bar.append(createMeasureToolbar(model), createMeasureReadout(model));
  return bar;
}
