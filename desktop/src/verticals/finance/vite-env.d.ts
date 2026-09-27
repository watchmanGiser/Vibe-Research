/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BOOTSTRAP_DEEPSEEK_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
