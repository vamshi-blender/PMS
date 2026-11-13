/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Backend the extension talks to until the user picks another in the
  // sidebar. Set when packaging a build for sharing (scripts/package-extension.mjs).
  readonly VITE_DEFAULT_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
