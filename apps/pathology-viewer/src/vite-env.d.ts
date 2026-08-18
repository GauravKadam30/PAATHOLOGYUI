/// <reference types="vite/client" />

/**
 * Declares the environment variables this app reads, so `import.meta.env.X` is
 * type-checked rather than `any`. Vite only exposes variables prefixed VITE_.
 */
interface ImportMetaEnv {
  /** Backend origin. Unset locally, where api.ts falls back to localhost:3001. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
