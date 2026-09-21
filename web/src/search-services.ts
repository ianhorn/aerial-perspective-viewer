// Looking up places and addresses by name, with Nominatim, OpenStreetMap's public search. It knows towns, counties, ZIP codes,
// parks, landmarks and street addresses, needs no key, and answers cross-origin calls from a page, which is why it was chosen
// (the state's NG911 locator, tried first, is for 911 dispatch: it found addresses and intersections but nothing for a town, a
// ZIP code or a park). Its intersections are weaker; coordinates are read in the browser (`search-parse.ts`), not here.
//
// Its usage policy (operations.osmfoundation.org/policies/nominatim) is kept to: at most one request a second, no search as
// you type (the box searches when Enter is pressed), the answers are remembered, the page's address goes as the referrer (the
// browser does that), the credit "© OpenStreetMap contributors" is on the map, and the use is light. It is the one place
// here that sends what a person types to someone else. Swapping it for another service means changing this file only.

import { MAX_BOUNDS } from './config.ts';
import { LruCache } from './lru.ts';

export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

/** A place found by name, ready to show in a list and to go to. */
export interface Place {
  id: string;
  /** What to call it: its name, or its street address. */
  label: string;
  /** What kind of place it is, and where: "Town · Warren County, KY". */
  detail: string;
  lng: number;
  lat: number;
  /** West, south, east, north in degrees, for a place with an extent (a town, a county, a park); null for a point. */
  bounds: [number, number, number, number] | null;
}

/** The parts of one Nominatim answer that are used (format=jsonv2, addressdetails=1). */
export interface NominatimResult {
  place_id: number | string;
  lat: string;
  lon: string;
  category?: string;
  type?: string;
  addresstype?: string;
  name?: string;
  display_name: string;
  /** South, north, west, east, as text. */
  boundingbox?: string[];
  address?: Record<string, string>;
}

/** The address of a search: Kentucky's viewer area (the map cannot be moved beyond its bounds anyway), USA only, at most 8 answers. */
export function nominatimUrl(query: string, bounds: readonly [number, number, number, number] = MAX_BOUNDS): string {
  const [west, south, east, north] = bounds;
  const params = new URLSearchParams({
    q: query, format: 'jsonv2', limit: '8', addressdetails: '1', countrycodes: 'us',
    viewbox: `${west},${north},${east},${south}`, bounded: '1',
  });
  return `${NOMINATIM_URL}?${params}`;
}

const KIND_BY_ADDRESS_TYPE: Record<string, string> = {
  city: 'City', town: 'Town', village: 'Village', hamlet: 'Hamlet', suburb: 'Neighborhood', neighbourhood: 'Neighborhood',
  quarter: 'Neighborhood', county: 'County', state: 'State', postcode: 'ZIP code', road: 'Street', house: 'Address',
  building: 'Building', park: 'Park', nature_reserve: 'Nature reserve', peak: 'Peak', river: 'River', stream: 'Stream',
  lake: 'Lake', school: 'School', hospital: 'Hospital', university: 'University', airport: 'Airport', cemetery: 'Cemetery',
};

/** What to call the kind of a result, in a word or two. */
export function kindOf(r: Pick<NominatimResult, 'addresstype' | 'type' | 'category'>): string {
  const known = KIND_BY_ADDRESS_TYPE[r.addresstype ?? ''] ?? KIND_BY_ADDRESS_TYPE[r.type ?? ''];
  if (known) return known;
  const raw = (r.type && r.type !== 'yes' ? r.type : r.category) ?? 'place';
  const text = raw.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const STATE_ABBREVIATION: Record<string, string> = { Kentucky: 'KY', Tennessee: 'TN', Ohio: 'OH', Indiana: 'IN', Illinois: 'IL', Missouri: 'MO', 'West Virginia': 'WV', Virginia: 'VA' };

/** A result as a label and a detail line. */
export function describeResult(r: NominatimResult): { label: string; detail: string } {
  const a = r.address ?? {};
  const street = a['house_number'] && a['road'] ? `${a['house_number']} ${a['road']}` : (a['road'] ?? '');
  const first = r.display_name.split(',')[0]!.trim();
  const label = (r.name && r.name.trim()) || street || first;
  const locality = a['city'] ?? a['town'] ?? a['village'] ?? a['hamlet'] ?? a['suburb'] ?? '';
  const state = a['state'] ? (STATE_ABBREVIATION[a['state']] ?? a['state']) : '';
  const where = [
    street && street !== label ? street : '',
    locality && locality !== label ? locality : '',
    a['county'] && a['county'] !== label ? a['county'] : '',
    state,
  ].filter(Boolean).join(', ');
  return { label, detail: [kindOf(r), where].filter(Boolean).join(' · ') };
}

/** Nominatim's answers as places, in its own order (best first), leaving out any with no position or a repeat. */
export function interpretNominatim(results: readonly NominatimResult[]): Place[] {
  const seen = new Set<string>();
  const places: Place[] = [];
  for (const r of results) {
    const lat = Number(r.lat), lng = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const { label, detail } = describeResult(r);
    const key = `${label}|${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let bounds: Place['bounds'] = null;
    if (r.boundingbox && r.boundingbox.length === 4) {
      const [south, north, west, east] = r.boundingbox.map(Number) as [number, number, number, number];
      if ([south, north, west, east].every(Number.isFinite)) bounds = [west, south, east, north];
    }
    places.push({ id: String(r.place_id), label, detail, lng, lat, bounds });
  }
  return places;
}

/** The larger side of a place's extent, in degrees of latitude (a degree of longitude is shortened by the latitude). */
export function extentDegrees(place: Pick<Place, 'bounds' | 'lat'>): number {
  if (!place.bounds) return 0;
  const [west, south, east, north] = place.bounds;
  return Math.max(north - south, (east - west) * Math.cos((place.lat * Math.PI) / 180));
}

/** How the map goes to a place: to a point at street level, to fit a town or a park (and look up the photos at its middle), or to fit a very large one (a county) without looking up any. */
export type MapMove = { kind: 'point'; zoom: number } | { kind: 'fit'; bounds: [number, number, number, number]; lookUp: boolean };
/** Under this a place is treated as a point (about 450 m); above `WIDE` (about 30 km) it is too big for a photo lookup to mean anything. */
export const POINT_EXTENT_DEGREES = 0.004;
export const WIDE_EXTENT_DEGREES = 0.27;
/** MapLibre's camera zoom for street level: the Bing/Google level is one more (level 18), where the photos are at their best. */
export const POINT_ZOOM = 17;

export function moveFor(place: Place): MapMove {
  const extent = extentDegrees(place);
  if (!place.bounds || extent <= POINT_EXTENT_DEGREES) return { kind: 'point', zoom: POINT_ZOOM };
  return { kind: 'fit', bounds: place.bounds, lookUp: extent <= WIDE_EXTENT_DEGREES };
}

/** The search could not be done: `busy` when the service asked us to slow down, else it failed or did not answer. */
export class SearchError extends Error {
  readonly kind: 'busy' | 'failed';
  constructor(kind: 'busy' | 'failed', message: string) {
    super(message);
    this.kind = kind;
  }
}

const MIN_INTERVAL_MS = 1100; // the policy allows one request a second
const cache = new LruCache<string, Place[]>(40);
let nextRequestAt = 0;

export interface SearchOptions {
  signal?: AbortSignal;
  /** Replaces the network, the clock and the wait, for tests. */
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Forget what was remembered and the spacing between requests. For tests. */
export function resetSearch(): void {
  cache.clear();
  nextRequestAt = 0;
}

/** Look a place or an address up by name. Answers already seen are remembered; requests are spaced a little over a second apart. */
export async function searchPlaces(query: string, options: SearchOptions = {}): Promise<Place[]> {
  const { signal, fetch: doFetch = fetch, now = Date.now, sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = options;
  const text = query.trim().replace(/\s+/g, ' ');
  const key = text.toLowerCase();
  const kept = cache.get(key);
  if (kept) return kept;

  // Take the next free turn before waiting, so searches in quick succession each get their own.
  const start = Math.max(now(), nextRequestAt);
  nextRequestAt = start + MIN_INTERVAL_MS;
  if (start > now()) await sleep(start - now());
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  let response: Response;
  try {
    response = await doFetch(nominatimUrl(text), { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SearchError('failed', `the search service could not be reached: ${(error as Error).message}`);
  }
  if (response.status === 429) throw new SearchError('busy', 'the search service asked for a pause');
  if (!response.ok) throw new SearchError('failed', `the search service answered ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SearchError('failed', 'the search service gave an answer that could not be read');
  }
  if (!Array.isArray(body)) throw new SearchError('failed', 'the search service gave an unexpected answer');
  const places = interpretNominatim(body as NominatimResult[]);
  cache.set(key, places);
  return places;
}
