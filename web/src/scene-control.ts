import type { IControl } from 'maplibre-gl';

export interface SceneControlHandlers {
  /** The scene was turned on or off. */
  onScene(on: boolean): void;
  /** The draped photo was shown or hidden (only possible while the scene is on). */
  onPhoto(shown: boolean): void;
}

/**
 * The scene buttons on the map. "Scene" turns the scene on and off: photos draped on the map with the look
 * direction at the top. While it is on, "Photo" appears under it and shows or hides the draped photo, to see the
 * map underneath. Turning the scene off and on again shows the photo again.
 */
export class SceneControl implements IControl {
  private readonly handlers: SceneControlHandlers;
  private readonly scene = document.createElement('button');
  private readonly photo = document.createElement('button');
  private container?: HTMLElement;
  private sceneOn = false;
  private photoShown = true;

  constructor(handlers: SceneControlHandlers) {
    this.handlers = handlers;
  }

  onAdd(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group scene-control';

    this.scene.type = 'button';
    this.scene.textContent = 'Scene';
    this.scene.title = 'Show the photo on the map, turned so the way it looks is up';
    this.scene.setAttribute('aria-pressed', 'false');
    this.scene.addEventListener('click', () => {
      this.sceneOn = !this.sceneOn;
      this.photoShown = true;
      this.render();
      this.handlers.onScene(this.sceneOn);
    });

    this.photo.type = 'button';
    this.photo.textContent = 'Photo';
    this.photo.title = 'Show or hide the photo on the map';
    this.photo.addEventListener('click', () => {
      this.photoShown = !this.photoShown;
      this.render();
      this.handlers.onPhoto(this.photoShown);
    });

    this.render();
    box.append(this.scene, this.photo);
    return (this.container = box);
  }

  private render(): void {
    this.scene.setAttribute('aria-pressed', String(this.sceneOn));
    this.photo.hidden = !this.sceneOn;
    this.photo.setAttribute('aria-pressed', String(this.photoShown));
  }

  onRemove(): void {
    this.container?.remove();
  }
}
