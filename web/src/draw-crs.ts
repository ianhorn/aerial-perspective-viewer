// The coordinate systems a drawing can be exported in, with the definitions the file formats carry. No DOM here.
//
// WGS84 is the default (and the only one GeoJSON has). The drawing is stored as longitude and latitude, and the difference between
// NAD83 and WGS84 (about a metre) is ignored, as it is everywhere in this app. Kentucky State Plane (EPSG:3089, US survey feet) is
// the coordinate system the imagery, the sizes shown on the card and the circles are worked out in.

export type ExportCrs = 'wgs84' | 'stateplane';

export interface CrsInfo {
  /** The EPSG code. */
  code: number;
  name: string;
  /** OGC WKT 1, as a GeoPackage's `gpkg_spatial_ref_sys` holds it. */
  wkt: string;
  /** PROJJSON, as GeoParquet's `geo` metadata holds it. Null for WGS84: GeoParquet's default when there is none is OGC:CRS84, longitude then latitude. */
  projjson: object | null;
  /** What the coordinates are in, for the card. */
  label: string;
}

const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';

// As PostGIS's spatial_ref_sys holds it (which is what the projection in lcc.ts was checked against): a Lambert conformal conic, false
// origin 36°20′N 85°45′W, standard parallels 37°05′N and 38°40′N, false easting 1,500,000 m and false northing 1,000,000 m in feet.
const STATE_PLANE_WKT =
  'PROJCS["NAD83 / Kentucky Single Zone (ftUS)",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","6269"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4269"]],PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["standard_parallel_1",37.08333333333334],PARAMETER["standard_parallel_2",38.66666666666666],PARAMETER["latitude_of_origin",36.33333333333334],PARAMETER["central_meridian",-85.75],PARAMETER["false_easting",4921250],PARAMETER["false_northing",3280833.333],UNIT["US survey foot",0.3048006096012192,AUTHORITY["EPSG","9003"]],AXIS["X",EAST],AXIS["Y",NORTH],AUTHORITY["EPSG","3089"]]';

const FOOT = { type: 'LinearUnit', name: 'US survey foot', conversion_factor: 0.3048006096012192 };

const STATE_PLANE_PROJJSON = {
  $schema: 'https://proj.org/schemas/v0.7/projjson.schema.json',
  type: 'ProjectedCRS',
  name: 'NAD83 / Kentucky Single Zone (ftUS)',
  base_crs: {
    name: 'NAD83',
    datum: {
      type: 'GeodeticReferenceFrame',
      name: 'North American Datum 1983',
      ellipsoid: { name: 'GRS 1980', semi_major_axis: 6378137, inverse_flattening: 298.257222101 },
    },
    coordinate_system: {
      subtype: 'ellipsoidal',
      axis: [
        { name: 'Geodetic latitude', abbreviation: 'Lat', direction: 'north', unit: 'degree' },
        { name: 'Geodetic longitude', abbreviation: 'Lon', direction: 'east', unit: 'degree' },
      ],
    },
    id: { authority: 'EPSG', code: 4269 },
  },
  conversion: {
    name: 'SPCS83 Kentucky Single Zone (US Survey feet)',
    method: { name: 'Lambert Conic Conformal (2SP)', id: { authority: 'EPSG', code: 9802 } },
    parameters: [
      { name: 'Latitude of false origin', value: 36.33333333333334, unit: 'degree', id: { authority: 'EPSG', code: 8821 } },
      { name: 'Longitude of false origin', value: -85.75, unit: 'degree', id: { authority: 'EPSG', code: 8822 } },
      { name: 'Latitude of 1st standard parallel', value: 37.08333333333334, unit: 'degree', id: { authority: 'EPSG', code: 8823 } },
      { name: 'Latitude of 2nd standard parallel', value: 38.66666666666666, unit: 'degree', id: { authority: 'EPSG', code: 8824 } },
      { name: 'Easting at false origin', value: 4921250, unit: FOOT, id: { authority: 'EPSG', code: 8826 } },
      { name: 'Northing at false origin', value: 3280833.333, unit: FOOT, id: { authority: 'EPSG', code: 8827 } },
    ],
  },
  coordinate_system: {
    subtype: 'Cartesian',
    axis: [
      { name: 'Easting', abbreviation: 'X', direction: 'east', unit: FOOT },
      { name: 'Northing', abbreviation: 'Y', direction: 'north', unit: FOOT },
    ],
  },
  id: { authority: 'EPSG', code: 3089 },
};

export const CRS: Record<ExportCrs, CrsInfo> = {
  wgs84: { code: 4326, name: 'WGS 84', wkt: WGS84_WKT, projjson: null, label: 'WGS 84 longitude and latitude (EPSG:4326)' },
  stateplane: { code: 3089, name: 'NAD83 / Kentucky Single Zone (ftUS)', wkt: STATE_PLANE_WKT, projjson: STATE_PLANE_PROJJSON, label: 'Kentucky State Plane, US survey feet (EPSG:3089)' },
};
