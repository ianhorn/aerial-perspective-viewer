import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// The files are also read by programs that are not this code: GDAL (through pyogrio), GeoPandas, pyarrow and PROJ, which check the
// geometry, the coordinate systems, the attributes, the sizes and the GeoPackage's own rules against values worked out separately
// (test/support/verify_exports.py). They need Python with `geopandas pyarrow pyogrio pyproj shapely`; set GEO_PYTHON to the
// interpreter that has them (default python3). Without them this test is skipped, unless REQUIRE_GEO_READERS is set (CI sets it).

const python = process.env['GEO_PYTHON'] ?? 'python3';
const available = spawnSync(python, ['-c', 'import geopandas, pyarrow, pyogrio, pyproj, shapely'], { encoding: 'utf8' }).status === 0;
if (!available && process.env['REQUIRE_GEO_READERS']) throw new Error(`REQUIRE_GEO_READERS is set but ${python} cannot import geopandas, pyarrow, pyogrio, pyproj and shapely`);

describe('the exported files, read by GDAL, GeoPandas, pyarrow and PROJ', { skip: !available && 'no Python with the geospatial readers (see the comment at the top of this file)' }, () => {
  it('agree with what was drawn, in both coordinate systems', () => {
    const dir = mkdtempSync(join(tmpdir(), 'draw-export-'));
    try {
      const write = spawnSync(process.execPath, ['test/support/write-samples.ts', dir], { encoding: 'utf8' });
      assert.equal(write.status, 0, write.stderr);
      const verify = spawnSync(python, ['test/support/verify_exports.py', dir], { encoding: 'utf8' });
      assert.equal(verify.status, 0, `${verify.stdout}${verify.stderr}`);
      assert.match(verify.stdout, /^OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
