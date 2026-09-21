import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// The tiny COPC file the point-cloud tests read (test/fixtures/tiny.copc.laz) was made by test/support/make_copc.py. This reads it with laspy, a
// LAZ reader that is not the one under test, against the formula the points were made from, and checks that the generator still makes exactly the
// committed file. Needs Python with laspy, lazrs and numpy (test/support/requirements-geo.txt); skipped without them unless REQUIRE_GEO_READERS is set.

const python = process.env['GEO_PYTHON'] ?? 'python3';
const available = spawnSync(python, ['-c', 'import laspy, lazrs, numpy'], { encoding: 'utf8' }).status === 0;
if (!available && process.env['REQUIRE_GEO_READERS']) throw new Error(`REQUIRE_GEO_READERS is set but ${python} cannot import laspy, lazrs and numpy`);

describe('the tiny COPC test file', { skip: !available && 'no Python with laspy (see the comment at the top of this file)' }, () => {
  it('is what the generator makes, and laspy reads the points it was made from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copc-'));
    try {
      const fresh = join(dir, 'fresh.copc.laz');
      const make = spawnSync(python, ['test/support/make_copc.py', fresh], { encoding: 'utf8' });
      assert.equal(make.status, 0, make.stderr);
      const verify = spawnSync(python, ['test/support/verify_copc.py', 'test/fixtures/tiny.copc.laz', fresh], { encoding: 'utf8' });
      assert.equal(verify.status, 0, `${verify.stdout}${verify.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
