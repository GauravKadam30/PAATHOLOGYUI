/**
 * @telepathology/shared — the pieces both front-ends need.
 *
 * Ships raw TypeScript: both consumers are Vite apps that transpile it, so
 * there is no build step and no dist/ that can fall out of sync with src/.
 */
export * from './types.ts';
export * from './client.ts';
