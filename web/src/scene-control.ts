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
 *
 * "Bird's Eye View" above it is the same switch seen from the other side: it is pressed while the scene is off (the
 * plain map, seen from above) and pressing it toggles the scene exactly as Scene does.
 */
export class SceneControl implements IControl {
  private readonly handlers: SceneControlHandlers;
  private readonly birdsEye = document.createElement('button');
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

    const toggleScene = (): void => {
      this.sceneOn = !this.sceneOn;
      this.photoShown = true;
      this.render();
      this.handlers.onScene(this.sceneOn);
    };
    this.birdsEye.type = 'button';
    this.birdsEye.textContent = "Bird's Eye View";
    this.birdsEye.title = 'The map, seen from above. The same switch as Scene: pressed while the scene is off';
    this.birdsEye.addEventListener('click', toggleScene);

    this.scene.type = 'button';
    this.scene.textContent = 'Scene';
    this.scene.title = 'Show the photo on the map, turned so the way it looks is up';
    this.scene.setAttribute('aria-pressed', 'false');
    this.scene.addEventListener('click', toggleScene);

    this.photo.type = 'button';
    this.photo.textContent = 'Photo';
    this.photo.title = 'Show or hide the photo on the map';
    this.photo.addEventListener('click', () => {
      this.photoShown = !this.photoShown;
      this.render();
      this.handlers.onPhoto(this.photoShown);
    });

    this.render();
    box.append(this.birdsEye, this.scene, this.photo);
    return (this.container = box);
  }

  private render(): void {
    this.birdsEye.setAttribute('aria-pressed', String(!this.sceneOn));
    this.scene.setAttribute('aria-pressed', String(this.sceneOn));
    this.photo.hidden = !this.sceneOn;
    this.photo.setAttribute('aria-pressed', String(this.photoShown));
  }

  onRemove(): void {
    this.container?.remove();
  }
}
