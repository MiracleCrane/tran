/**
 * Platform detection for the renderer.
 *
 * The renderer runs in a sandboxed browser context with no `process.platform`.
 * __FORGE_PLATFORM__ is injected at build time by electron.vite.config.ts, so
 * components can branch on the OS without crossing the IPC boundary.
 *
 * This macOS build is always 'darwin'.
 */

export const isMac = __FORGE_PLATFORM__ === 'darwin'
export const isWindows = __FORGE_PLATFORM__ === 'win32'
