/**
 * The one build-time variable this package reads.
 *
 * Declared here rather than pulling in `vite/client`, because the package
 * itself has no Vite dependency — it is plain TypeScript that happens to be
 * consumed by two Vite apps. Both are optional: `env` is absent outside a
 * bundler, which is why resolveApiBase() uses `import.meta.env?.`.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}
