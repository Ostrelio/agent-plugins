import { createRequire } from 'node:module';

/** Package version; `../package.json` resolves from both `src/` and `dist/`. */
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
