import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { apiPath } from '../src/api.ts';

// The API calls are relative to the page, so the app works at the root of a host and under a subpath behind a proxy.

describe('apiPath', () => {
  it('is /api/... when the page is at the root of its host', () => {
    assert.equal(apiPath('frames?lon=-85.7&lat=38.2', 'https://host.example/'), '/api/frames?lon=-85.7&lat=38.2');
    assert.equal(apiPath('frames?lon=-85.7', 'http://127.0.0.1:5173/'), '/api/frames?lon=-85.7');
  });

  it('follows the page under a subpath, so a proxy that forwards /viewer/ gets /viewer/api/...', () => {
    assert.equal(apiPath('frames?look=north', 'https://host.example/viewer/'), '/viewer/api/frames?look=north');
    assert.equal(apiPath('scene?west=1&south=2', 'https://host.example/a/b/c/'), '/a/b/c/api/scene?west=1&south=2');
  });

  it('treats a page called index.html as the folder it is in', () => {
    assert.equal(apiPath('frames?x=1', 'https://host.example/viewer/index.html'), '/viewer/api/frames?x=1');
    assert.equal(apiPath('frames?x=1', 'https://host.example/index.html'), '/api/frames?x=1');
  });

  it('keeps the frame path with its folder, and a query string, intact', () => {
    assert.equal(apiPath('frames/KY_KYAPED_2024_Season1_3IN/Fwd_7028_44960.tif', 'https://host.example/viewer/'), '/viewer/api/frames/KY_KYAPED_2024_Season1_3IN/Fwd_7028_44960.tif');
    assert.equal(apiPath('frames?lon=-85.6880&lat=38.2480&look=west&limit=20', 'https://h/x/'), '/x/api/frames?lon=-85.6880&lat=38.2480&look=west&limit=20');
  });

  it('ignores the host and any query on the page itself, and needs the slash: /viewer without it means the root', () => {
    assert.equal(apiPath('frames?a=1', 'https://host.example/viewer/?debug=1#top'), '/viewer/api/frames?a=1');
    assert.equal(apiPath('frames?a=1', 'https://host.example/viewer'), '/api/frames?a=1'); // why the proxy redirects /viewer to /viewer/
  });
});
