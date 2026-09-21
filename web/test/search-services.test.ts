import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';
import {
  extentDegrees, interpretNominatim, kindOf, moveFor, nominatimUrl, POINT_ZOOM, resetSearch, SearchError, searchPlaces, type NominatimResult,
} from '../src/search-services.ts';

// Real answers from Nominatim (test/fixtures/nominatim.json), so the reading of them is checked against the real shape.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/nominatim.json', import.meta.url), 'utf8')) as Record<string, { query: string; results: NominatimResult[] }>;
const placesOf = (key: string) => interpretNominatim(fixtures[key]!.results);

describe('the request', () => {
  it('asks for JSON with address details, US only, at most 8, bounded to the viewer\'s area', () => {
    const url = new URL(nominatimUrl('401 W Main St, Louisville', [-90.3, 35.8, -81.3, 39.7]));
    assert.equal(url.origin + url.pathname, 'https://nominatim.openstreetmap.org/search');
    assert.equal(url.searchParams.get('q'), '401 W Main St, Louisville');
    assert.equal(url.searchParams.get('format'), 'jsonv2');
    assert.equal(url.searchParams.get('addressdetails'), '1');
    assert.equal(url.searchParams.get('countrycodes'), 'us');
    assert.equal(url.searchParams.get('limit'), '8');
    assert.equal(url.searchParams.get('bounded'), '1');
    assert.equal(url.searchParams.get('viewbox'), '-90.3,39.7,-81.3,35.8'); // west, north, east, south
  });

  it('keeps what was typed intact, whatever it holds', () => {
    const q = "O'Hara & Sons #2, 100% \"Main\"?";
    assert.equal(new URL(nominatimUrl(q)).searchParams.get('q'), q);
  });

  it('by default covers the viewer\'s pan limits, so nothing that could not be shown is asked for', () => {
    const [west, north, east, south] = new URL(nominatimUrl('x')).searchParams.get('viewbox')!.split(',').map(Number);
    assert.ok(west! < -89.7 && east! > -81.9 && south! < 36.5 && north! > 39.1);
  });
});

describe('reading real answers', () => {
  it('names a town by its name, says what it is and where', () => {
    const [town] = placesOf('town');
    assert.equal(town!.label, 'Bowling Green');
    assert.equal(town!.detail, 'City · Warren County, KY');
    assert.ok(Math.abs(town!.lat - 36.99) < 0.01 && Math.abs(town!.lng + 86.44) < 0.01);
    assert.ok(town!.bounds);
  });

  it('reads a ZIP code, a county and a park', () => {
    assert.deepEqual(placesOf('zip').map((p) => [p.label, p.detail]), [['40202', 'ZIP code · Louisville, Jefferson County, KY']]);
    assert.deepEqual(placesOf('county').map((p) => [p.label, p.detail]), [['Warren County', 'County · KY']]);
    const [park] = placesOf('park');
    assert.equal(park!.label, 'Cherokee Park');
    assert.match(park!.detail, /^Park · /);
  });

  it('gives a street address as a name and its street line, town and county', () => {
    const [place] = placesOf('address');
    assert.equal(place!.label, 'Truist Tower - One Riverfront Plaza');
    assert.equal(place!.detail, 'Building · 401 West Main Street, Louisville, Jefferson County, KY');
  });

  it('keeps the service\'s order (best first) and has nothing for a nonsense search', () => {
    const frankfort = placesOf('frankfort');
    assert.equal(frankfort[0]!.label, 'Frankfort');
    assert.match(frankfort[0]!.detail, /Franklin County, KY/);
    assert.deepEqual(placesOf('none'), []);
  });

  it('leaves out an answer with no position, and a repeat', () => {
    const one = fixtures['town']!.results[0]!;
    const places = interpretNominatim([one, { ...one, place_id: 2 }, { ...one, place_id: 3, lat: 'x' }]);
    assert.equal(places.length, 1);
  });

  it('turns a bounding box (south, north, west, east) into west, south, east, north', () => {
    const [town] = placesOf('town');
    assert.deepEqual(town!.bounds, [-86.533207, 36.898847, -86.306719, 37.046652]);
  });

  it('names a kind in a word or two, from the address type or the type', () => {
    assert.equal(kindOf({ addresstype: 'town' }), 'Town');
    assert.equal(kindOf({ addresstype: 'postcode' }), 'ZIP code');
    assert.equal(kindOf({ type: 'nature_reserve' }), 'Nature reserve');
    assert.equal(kindOf({ category: 'shop', type: 'yes' }), 'Shop');
    assert.equal(kindOf({ type: 'ski_jump' }), 'Ski jump');
  });
});

describe('where the map goes', () => {
  it('goes to street level for a building or an address, at the zoom the photos are best', () => {
    const [building] = placesOf('address');
    assert.deepEqual(moveFor(building!), { kind: 'point', zoom: POINT_ZOOM });
  });

  it('fits a town or a park, and looks up the photos at its middle', () => {
    for (const key of ['town', 'park', 'frankfort']) {
      const move = moveFor(placesOf(key)[0]!);
      assert.equal(move.kind, 'fit', key);
      assert.equal(move.kind === 'fit' && move.lookUp, true, key);
    }
  });

  it('fits a county without looking up photos, which would mean nothing over 30 miles', () => {
    const move = moveFor(placesOf('county')[0]!);
    assert.equal(move.kind, 'fit');
    assert.equal(move.kind === 'fit' && move.lookUp, false);
  });

  it('does the same for a ZIP code, which the service gives a city-sized box (0.45 degrees for 40202)', () => {
    const zip = placesOf('zip')[0]!;
    assert.ok(extentDegrees(zip) > 0.27);
    const move = moveFor(zip);
    assert.equal(move.kind, 'fit');
    assert.equal(move.kind === 'fit' && move.lookUp, false);
  });

  it('measures the extent as the larger side in degrees of latitude, with longitude shortened by latitude', () => {
    assert.ok(Math.abs(extentDegrees({ lat: 60, bounds: [0, 0, 1, 0.2] }) - 0.5) < 1e-9);
    assert.equal(extentDegrees({ lat: 38, bounds: null }), 0);
  });
});

describe('being polite to the service, and honest about failures', () => {
  const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
  let clock = 0;
  const sleeps: number[] = [];
  // Time as it really passes: waits that begin together overlap, and the clock only moves forward to where a wait ends.
  const env = { now: () => clock, sleep: async (ms: number) => { sleeps.push(ms); const until = clock + ms; await Promise.resolve(); clock = Math.max(clock, until); } };
  beforeEach(() => { resetSearch(); clock = 1_000_000; sleeps.length = 0; });

  it('asks the service once, and remembers the answer (whatever the case and spacing)', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return new Response(JSON.stringify(fixtures['town']!.results)); };
    const a = await searchPlaces('Bowling Green, KY', { fetch: fetchImpl as unknown as typeof fetch, ...env });
    const b = await searchPlaces('  bowling   green, ky ', { fetch: fetchImpl as unknown as typeof fetch, ...env });
    assert.equal(calls, 1);
    assert.equal(a[0]!.label, 'Bowling Green');
    assert.deepEqual(a, b);
  });

  it('gives each of several searches started together its own turn, a little over a second apart', async () => {
    const fetchImpl = async () => new Response('[]');
    await Promise.all(['one', 'two', 'three'].map((q) => searchPlaces(q, { fetch: fetchImpl as unknown as typeof fetch, ...env })));
    assert.deepEqual([...sleeps].sort((a, b) => a - b), [1100, 2200]); // the first goes at once
  });

  it('waits only for what is left of the second, when a search comes soon after another', async () => {
    const fetchImpl = async () => new Response('[]');
    await searchPlaces('first', { fetch: fetchImpl as unknown as typeof fetch, ...env });
    assert.deepEqual(sleeps, []);
    clock += 300;
    await searchPlaces('second', { fetch: fetchImpl as unknown as typeof fetch, ...env });
    assert.deepEqual(sleeps, [800]);
    clock += 5000; // long enough after: no wait at all
    await searchPlaces('third', { fetch: fetchImpl as unknown as typeof fetch, ...env });
    assert.deepEqual(sleeps, [800]);
  });

  it('says the service is busy on a 429, and failed on other errors, an unreadable answer or no network', async () => {
    await assert.rejects(searchPlaces('a', { fetch: answer([], 429) as unknown as typeof fetch, ...env }), (e: SearchError) => e instanceof SearchError && e.kind === 'busy');
    await assert.rejects(searchPlaces('b', { fetch: answer([], 503) as unknown as typeof fetch, ...env }), (e: SearchError) => e.kind === 'failed');
    await assert.rejects(searchPlaces('c', { fetch: (async () => new Response('<html>oops</html>')) as unknown as typeof fetch, ...env }), (e: SearchError) => e.kind === 'failed');
    await assert.rejects(searchPlaces('d', { fetch: answer({ not: 'a list' }) as unknown as typeof fetch, ...env }), (e: SearchError) => e.kind === 'failed');
    await assert.rejects(searchPlaces('e', { fetch: (async () => { throw new TypeError('network down'); }) as unknown as typeof fetch, ...env }), (e: SearchError) => e.kind === 'failed');
  });

  it('does not remember a failure, so trying again asks again', async () => {
    let calls = 0;
    const flaky = async () => { calls++; return calls === 1 ? new Response('', { status: 503 }) : new Response(JSON.stringify(fixtures['town']!.results)); };
    await assert.rejects(searchPlaces('Bowling Green', { fetch: flaky as unknown as typeof fetch, ...env }));
    const places = await searchPlaces('Bowling Green', { fetch: flaky as unknown as typeof fetch, ...env });
    assert.equal(places.length, 1);
    assert.equal(calls, 2);
  });

  it('gives up quietly when the search was cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(searchPlaces('x', { signal: controller.signal, fetch: (async () => { throw new DOMException('aborted', 'AbortError'); }) as unknown as typeof fetch, ...env }), (e: Error) => e.name === 'AbortError');
  });
});
