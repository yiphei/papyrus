/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAPBOX_TOKEN: string
  readonly VITE_USE_STATIC_EVENTS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
