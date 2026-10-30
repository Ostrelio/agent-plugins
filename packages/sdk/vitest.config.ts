import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The integration suite boots the Control Plane from AIAuthDev's Backend/, linked in as ../../Backend
    // (see the README). Without it only the unit tests run here; AIAuthDev's CI runs the integration suite.
    exclude: ['**/._*', '**/node_modules/**', '**/dist/**', ...(existsSync(new URL('../../Backend/src/app.ts', import.meta.url)) ? [] : ['test/integration.test.ts'])],
    // The integration suite boots the backend with PGlite; give migrations room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
