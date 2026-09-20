import { defineConfig } from 'vite';

// The API runs on its own port, possibly on another machine. Proxying keeps the browser on one origin,
// as it would be when deployed behind the same host. `preview` serves the production build and needs
// the same proxy. Point it elsewhere with API_TARGET, for example API_TARGET=http://HOST:3001.
const target = process.env.API_TARGET ?? 'http://127.0.0.1:3001';
const proxy = { '/api': target };

// `base: './'` makes the built page refer to its files relative to itself, so it works at any address: the root of a
// host, or a subpath behind a proxy (https://host/viewer/). The API calls do the same (see `apiPath` in src/api.ts).
export default defineConfig({
  base: './',
  server: { proxy },
  preview: { proxy },
});
