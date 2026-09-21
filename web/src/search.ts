// The search box at the top of the panel: type a place, an address or coordinates, press Enter. Coordinates are read at once, in
// the browser (`search-parse.ts`). Anything else is looked up by name (`search-services.ts`): one answer is gone to directly,
// several are listed to choose from, and none says so and what to try. Nothing is searched as you type (the service's policy).
//
// The box is one element, made once and kept by the panel across its redraws, so what was typed and the answers stay.

import { describeCoordinates, parseCoordinates } from './search-parse.ts';
import { SearchError, searchPlaces, type Place } from './search-services.ts';

export interface SearchOptions {
  /** A place found by name was chosen (or was the only answer). */
  onPlace(place: Place): void;
  /** Coordinates were typed in. */
  onCoordinates(lng: number, lat: number): void;
  /** Replaces the lookup, for tests. */
  search?: typeof searchPlaces;
}

export interface Search {
  readonly element: HTMLElement;
  /** Say something under the box (why a place could not be gone to), or clear it with an empty string. */
  notice(text: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createSearch(options: SearchOptions): Search {
  const lookUp = options.search ?? searchPlaces;
  const root = el('div', 'search');

  const form = el('form');
  form.setAttribute('role', 'search');
  const input = el('input');
  input.type = 'search';
  input.name = 'q';
  input.placeholder = 'Place, address or coordinates';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Search for a place, an address or coordinates');
  const button = el('button', 'search-go', 'Search');
  button.type = 'submit';
  form.append(input, button);

  const status = el('p', 'search-status');
  status.setAttribute('role', 'status');
  status.hidden = true;
  const results = el('ul', 'search-results');
  results.hidden = true;
  const credit = el('p', 'search-credit');
  credit.hidden = true;
  const link = el('a', undefined, '© OpenStreetMap contributors');
  link.href = 'https://www.openstreetmap.org/copyright';
  link.target = '_blank';
  link.rel = 'noopener';
  credit.append('Search: ', link);
  root.append(form, status, results, credit);

  let request: AbortController | undefined;

  const say = (text: string): void => {
    status.textContent = text;
    status.hidden = text === '';
  };
  const showResults = (places: Place[] | null): void => {
    results.replaceChildren();
    results.hidden = places === null || places.length === 0;
    credit.hidden = results.hidden;
    for (const place of places ?? []) {
      const item = el('li');
      const choose = el('button', 'search-result');
      choose.type = 'button';
      choose.append(el('strong', undefined, place.label), el('span', undefined, place.detail));
      choose.addEventListener('click', () => {
        showResults(null);
        say('');
        options.onPlace(place);
      });
      item.append(choose);
      results.append(item);
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    request?.abort();
    showResults(null);
    if (text === '') return say('');

    const coordinates = parseCoordinates(text);
    if (coordinates) {
      say(`Going to ${describeCoordinates(coordinates)}.`);
      options.onCoordinates(coordinates.lng, coordinates.lat);
      return;
    }

    const mine = (request = new AbortController());
    say('Searching…');
    button.disabled = true;
    lookUp(text, { signal: mine.signal }).then((places) => {
      if (mine.signal.aborted) return;
      if (places.length === 0) {
        // Two streets, "4th St & Main St": the search service does not know intersections (they would only be guessed at).
        const crossing = /&|\band\b|\bat\b|\bcorner of\b/i.test(text) ? ' Intersections cannot be searched.' : '';
        say(`Nothing found for “${text}”.${crossing} Try a town or county name, a ZIP code, a street address like “401 W Main St, Louisville”, or coordinates.`);
      } else if (places.length === 1) {
        say('');
        options.onPlace(places[0]!);
      } else {
        say(`${places.length} places found. Choose one.`);
        showResults(places);
      }
    }).catch((error: unknown) => {
      if (mine.signal.aborted) return;
      showResults(null);
      say(error instanceof SearchError && error.kind === 'busy'
        ? 'The search service is busy. Try again in a moment.'
        : 'The search service did not answer. Try again in a moment.');
      console.error(error);
    }).finally(() => {
      if (request === mine) button.disabled = false;
    });
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (results.hidden === false || status.hidden === false)) {
      event.stopPropagation(); // clears the answers, and does not close the photo pane too
      request?.abort();
      showResults(null);
      say('');
      button.disabled = false;
    }
  });

  return { element: root, notice: say };
}
