/// <reference types="vite/client" />

/**
 * Compile-time platform constant, injected via electron.vite.config.ts
 * `renderer.define`. This macOS build is always 'darwin'. The renderer has no
 * access to process.platform, so components read this to gate Windows/WSL UI.
 * Typed as a union so OS comparisons don't trip TypeScript's literal-narrowing.
 */
declare const __FORGE_PLATFORM__: 'darwin' | 'win32' | 'linux'
