import type { IControl } from 'maplibre-gl';

/** A map button that turns the scene on and off: photos draped on the map with the look direction at the top. */
export class SceneControl implements IControl {
  private readonly onToggle: (on: boolean) => void;
  private readonly button = document.createElement('button');
  private container?: HTMLElement;
  private on = false;

  constructor(onToggle: (on: boolean) => void) {
    this.onToggle = onToggle;
  }

  onAdd(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group scene-control';
    this.button.type = 'button';
    this.button.textContent = 'Scene';
    this.button.title = 'Show the photo on the map, turned so the way it looks is up';
    this.button.setAttribute('aria-pressed', 'false');
    this.button.addEventListener('click', () => {
      this.on = !this.on;
      this.button.setAttribute('aria-pressed', String(this.on));
      this.onToggle(this.on);
    });
    box.append(this.button);
    return (this.container = box);
  }

  onRemove(): void {
    this.container?.remove();
  }
}
