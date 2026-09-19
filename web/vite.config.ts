import { defineConfig } from 'vite';

// The API runs on its own port. Proxying keeps the browser on one origin, as it would be when
// deployed behind the same host. `preview` serves the production build and needs the same proxy.
const proxy = { '/api': 'http://127.0.0.1:3001' };

export default defineConfig({
  server: { proxy },
  preview: { proxy },
});
