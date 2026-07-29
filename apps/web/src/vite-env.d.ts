/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MCODE_WEB_AUTOMATION?: string;
}

declare module "*.css" {
  const content: string;
  export default content;
}
