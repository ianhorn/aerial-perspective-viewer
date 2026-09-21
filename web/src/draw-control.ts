import type { IControl } from 'maplibre-gl';

/** The Draw button on the map: turns the drawing tools on and off. It can be disabled, with the reason shown as its tooltip. */
export class DrawControl implements IControl {
  private readonly button = document.createElement('button');
  private readonly onToggle: (on: boolean) => void;
  private container?: HTMLElement;
  private on = false;
  private disabledReason: string | null = null;

  constructor(onToggle: (on: boolean) => void) {
    this.onToggle = onToggle;
  }

  onAdd(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group scene-control draw-control';
    this.button.type = 'button';
    this.button.textContent = 'Draw';
    this.button.addEventListener('click', () => {
      this.on = !this.on;
      this.render();
      this.onToggle(this.on);
    });
    this.render();
    box.append(this.button);
    return (this.container = box);
  }

  /** Show the button as on or off without calling the handler (the tools were turned on or off from elsewhere). */
  setOn(on: boolean): void {
    this.on = on;
    this.render();
  }

  /** Enable the button, or disable it with the reason (null enables it). */
  setDisabled(reason: string | null): void {
    this.disabledReason = reason;
    this.render();
  }

  private render(): void {
    this.button.setAttribute('aria-pressed', String(this.on));
    this.button.disabled = this.disabledReason !== null;
    this.button.title = this.disabledReason ?? 'Draw shapes, lines, points and text on the map, and export them';
  }

  onRemove(): void {
    this.container?.remove();
  }
}
