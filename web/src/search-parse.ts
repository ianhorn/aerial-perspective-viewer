// Reading coordinates typed into the search box. No network: this decides whether the text is a coordinate pair at all
// (if not, it is a place or an address for the geocoder), and if it is, where.
//
// Understood:
//   decimal degrees        38.2288, -85.7878      38.2288 -85.7878      38.2288° N, 85.7878° W      N38.2288 W85.7878
//   degrees minutes seconds  38°13'44"N 85°47'16"W     38 13 44 N, 85 47 16 W     38d13m44s -85d47m16s
//   degrees decimal minutes  38°13.733'N 85°47.267'W
//   State Plane (EPSG:3089, feet)  4,939,006 3,977,891      4939006 E, 3977891 N      x=4939006 y=3977891
//
// Latitude comes first unless a hemisphere letter says otherwise, or the numbers can only be the other way round (a
// Kentucky longitude of 85 next to a latitude of 38 is not a latitude of 85 in Kentucky's neighbourhood of nothing).

import { gridToLonLat } from './lcc.ts';

export interface Coordinates {
  lng: number;
  lat: number;
  /** How it was written, for the message that says where it went. */
  kind: 'decimal' | 'dms' | 'stateplane';
}

/** Whether a place is somewhere the Kentucky State Plane grid can be meant: a loose box around the state, in degrees. */
const nearKentucky = (lng: number, lat: number): boolean => lng > -95 && lng < -75 && lat > 33 && lat < 42;

const num = (text: string): number => Number(text.replace(/,/g, ''));

/** A State Plane pair: two large numbers, feet, easting first unless labelled the other way. */
function parseStatePlane(text: string): Coordinates | null {
  const big = String.raw`(\d{1,3}(?:,\d{3})+|\d{6,8})(?:\.\d+)?`;
  const re = new RegExp(String.raw`^\s*(?:(X|E|EAST(?:ING)?|N|NORTH(?:ING)?|Y)\s*[:=]?\s*)?${big}\s*(?:US\s*)?(?:FT|FEET|E|N)?\s*[,;\s]\s*(?:(X|E|EAST(?:ING)?|N|NORTH(?:ING)?|Y)\s*[:=]?\s*)?${big}\s*(?:US\s*)?(?:FT|FEET|E|N)?\s*$`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  const a = num(m[0].match(new RegExp(big, 'i'))![0]);
  const rest = m[0].slice(m[0].search(new RegExp(big, 'i')) + m[0].match(new RegExp(big, 'i'))![0].length);
  const b = num(rest.match(new RegExp(big, 'i'))![0]);
  // Which is which: labels say (a leading N or Y label, or a trailing N on the first number, means northing first); otherwise easting first.
  const labelled = (label: string | undefined): 'x' | 'y' | null => (label ? (/^(X|E)/i.test(label) ? 'x' : 'y') : null);
  const first = labelled(m[1]) ?? (/\d\s*(?:FT|FEET)?\s*N\s*[,;\s]/i.test(text) ? 'y' : 'x');
  const [x, y] = first === 'y' ? [b, a] : [a, b];
  for (const [ex, ny] of [[x, y], [y, x]] as const) {
    const [lng, lat] = gridToLonLat(ex, ny);
    if (nearKentucky(lng, lat)) return { lng, lat, kind: 'stateplane' };
  }
  return null;
}

interface Angle { value: number; axis: 'lat' | 'lng' | null; parts: number }

/** Turn the numbers of one angle (degrees, or degrees and minutes, or degrees, minutes and seconds) and its hemisphere into a signed angle. */
function angle(numbers: string[], hemisphere: string | null): Angle | null {
  const [d, m = '0', s = '0'] = numbers;
  if (d === undefined || numbers.length > 3) return null;
  const negative = d.startsWith('-') || (hemisphere !== null && /[SW]/.test(hemisphere));
  const degrees = Math.abs(Number(d)), minutes = Number(m), seconds = Number(s);
  if (!Number.isFinite(degrees) || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
  // Only the last part may have a fraction: 38.5 13 is not an angle.
  if (numbers.slice(0, -1).some((n) => n.includes('.'))) return null;
  const value = degrees + minutes / 60 + seconds / 3600;
  return { value: negative ? -value : value, axis: hemisphere === null ? null : /[NS]/.test(hemisphere) ? 'lat' : 'lng', parts: numbers.length };
}

/** Latitude and longitude as decimal degrees or as degrees, minutes and seconds, with or without hemisphere letters. */
function parseAngles(text: string): Coordinates | null {
  // The unit letters d, m and s (38d13m44s) are lowercase; an uppercase S or W is a hemisphere. So they go before the case is changed.
  let t = text.replace(/(?<=\d)[dms](?=\s|\d|$|[NSEWnsew,;])/g, ' ').toUpperCase().replace(/[′’']/g, ' ').replace(/[″”"]/g, ' ').replace(/[°º]/g, ' ');
  t = t.replace(/\b(LATITUDE|LAT|LONGITUDE|LONG|LNG|LON)\b\.?/g, ' ');
  if (/[^0-9.\-+\sNSEW,;:]/.test(t)) return null; // any other letter, or a symbol: this is an address or a place
  t = t.replace(/\+/g, '');
  const tokens = t.match(/[NSEW]|-?\d+(?:\.\d+)?|-?\.\d+/g);
  if (!tokens || tokens.length < 2) return null;
  // If the text has a comma or semicolon between the two angles it says where the split is; use it as a guide only.
  const groups: { numbers: string[]; hemisphere: string | null }[] = [];
  const hasLetters = tokens.some((tok) => /[NSEW]/.test(tok));
  if (hasLetters) {
    const prefix = /[NSEW]/.test(tokens[0]!); // N38.2 W85.7 (a letter first) or 38.2 N 85.7 W (a letter after)
    let cur: { numbers: string[]; hemisphere: string | null } = { numbers: [], hemisphere: null };
    for (const tok of tokens) {
      if (/[NSEW]/.test(tok)) {
        if (prefix) {
          if (cur.numbers.length > 0 || cur.hemisphere) groups.push(cur);
          cur = { numbers: [], hemisphere: tok };
        } else {
          cur.hemisphere = tok;
          groups.push(cur);
          cur = { numbers: [], hemisphere: null };
        }
      } else cur.numbers.push(tok);
    }
    if (cur.numbers.length > 0 || cur.hemisphere) groups.push(cur);
  } else {
    const n = tokens.length;
    if (n !== 2 && n !== 4 && n !== 6) return null;
    const each = n / 2;
    groups.push({ numbers: tokens.slice(0, each), hemisphere: null }, { numbers: tokens.slice(each), hemisphere: null });
  }
  if (groups.length !== 2 || groups.some((g) => g.numbers.length === 0)) return null;
  const a = angle(groups[0]!.numbers, groups[0]!.hemisphere), b = angle(groups[1]!.numbers, groups[1]!.hemisphere);
  if (!a || !b) return null;

  let lat: number, lng: number;
  if (a.axis && b.axis) {
    if (a.axis === b.axis) return null; // two latitudes
    [lat, lng] = a.axis === 'lat' ? [a.value, b.value] : [b.value, a.value];
  } else if (a.axis || b.axis) {
    const known = a.axis ? a : b, other = a.axis ? b : a;
    [lat, lng] = known.axis === 'lat' ? [known.value, other.value] : [other.value, known.value];
  } else {
    [lat, lng] = [a.value, b.value];
    // Written longitude first (85.7 W is not a Kentucky latitude): swap when the first cannot be a latitude, or the pair is only sensible the other way.
    if (Math.abs(a.value) > 90 || (nearKentucky(b.value, a.value) === false && nearKentucky(a.value, b.value))) [lat, lng] = [b.value, a.value];
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lng, lat, kind: groups.some((g) => g.numbers.length > 1) ? 'dms' : 'decimal' };
}

/** The coordinates in a piece of text, or null when it is not a coordinate pair (so it is a place or an address). */
export function parseCoordinates(text: string): Coordinates | null {
  const t = text.trim();
  if (t === '') return null;
  return parseStatePlane(t) ?? parseAngles(t);
}

/** How a pair of coordinates reads back in a sentence: 38.22880, -85.78780. */
export const describeCoordinates = (c: Coordinates): string => `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
