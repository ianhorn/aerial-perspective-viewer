import { defineConfig } from 'vite';

// In development the API runs on its own port; proxying keeps the browser on one origin, as it
// would be when deployed behind the same host.
export default defineConfig({
  server: {
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
});
