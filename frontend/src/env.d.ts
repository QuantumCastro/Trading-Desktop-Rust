/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly APP_DB_FILENAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
