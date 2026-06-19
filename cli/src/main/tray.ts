import { Tray, Menu, nativeImage, type BrowserWindow } from 'electron'
import { deflateSync } from 'node:zlib'
import { log } from './logger'

/* ------------------------------------------------------------------ *
 * Tray icon — generated at runtime so no binary asset is needed.
 *
 * We rasterize an anti-aliased RGBA pixel grid (accent rounded square + a
 * white geometric "F" glyph) and encode it as a PNG via Node's zlib + a tiny
 * CRC/PNG chunk writer. The shape mirrors the packaged Forge app icon.
 * ------------------------------------------------------------------ */

const ACCENT_R = 0xdf
const ACCENT_G = 0x76
const ACCENT_B = 0x5f
const ICON_SUPERSAMPLE = 4

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

interface PaintSample {
  r: number
  g: number
  b: number
  a: number
}

function roundedRectSdf(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius: number
): number {
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  const hx = (right - left) / 2 - radius
  const hy = (bottom - top) / 2 - radius
  const qx = Math.abs(x - cx) - hx
  const qy = Math.abs(y - cy) - hy
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  return outside + inside - radius
}

function inRoundedRect(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius: number
): boolean {
  return roundedRectSdf(x, y, left, top, right, bottom, radius) <= 0
}

function over(sample: PaintSample, r: number, g: number, b: number, a: number): void {
  const alpha = clamp(a, 0, 1)
  const inverse = 1 - alpha
  sample.r = r * alpha + sample.r * inverse
  sample.g = g * alpha + sample.g * inverse
  sample.b = b * alpha + sample.b * inverse
  sample.a = alpha + sample.a * inverse
}

function inForgeGlyph(x: number, y: number, size: number): boolean {
  const stem = inRoundedRect(
    x,
    y,
    (0.405 - 0.091 / 2) * size,
    (0.518 - 0.418 / 2) * size,
    (0.405 + 0.091 / 2) * size,
    (0.518 + 0.418 / 2) * size,
    0.023 * size
  )
  const top = inRoundedRect(
    x,
    y,
    (0.505 - 0.287 / 2) * size,
    (0.331 - 0.087 / 2) * size,
    (0.505 + 0.287 / 2) * size,
    (0.331 + 0.087 / 2) * size,
    0.023 * size
  )
  const middle = inRoundedRect(
    x,
    y,
    (0.487 - 0.252 / 2) * size,
    (0.488 - 0.08 / 2) * size,
    (0.487 + 0.252 / 2) * size,
    (0.488 + 0.08 / 2) * size,
    0.021 * size
  )
  return stem || top || middle
}

function paintIconSample(x: number, y: number, size: number): PaintSample {
  const sample: PaintSample = { r: 0, g: 0, b: 0, a: 0 }
  const left = (0.5 - 0.86 / 2) * size
  const top = (0.5 - 0.86 / 2) * size
  const right = (0.5 + 0.86 / 2) * size
  const bottom = (0.5 + 0.86 / 2) * size
  const radius = 0.235 * size
  const distance = roundedRectSdf(x, y, left, top, right, bottom, radius)
  if (distance > 0) return sample

  over(sample, ACCENT_R / 255, ACCENT_G / 255, ACCENT_B / 255, 0.96)

  const verticalPosition = clamp((y - top) / (bottom - top), 0, 1)
  over(sample, 1, 1, 1, 0.08 * (1 - verticalPosition))

  if (distance > -0.036 * size) {
    over(sample, 1, 1, 1, 0.16)
  }

  if (inForgeGlyph(x, y, size)) {
    over(sample, 1, 1, 1, 1)
  }

  return sample
}

function rasterizeIcon(size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = ICON_SUPERSAMPLE * ICON_SUPERSAMPLE

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < ICON_SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < ICON_SUPERSAMPLE; sx++) {
          const sample = paintIconSample(
            x + (sx + 0.5) / ICON_SUPERSAMPLE,
            y + (sy + 0.5) / ICON_SUPERSAMPLE,
            size
          )
          r += sample.r
          g += sample.g
          b += sample.b
          a += sample.a
        }
      }

      const alpha = a / samples
      if (alpha <= 0) {
        rgba[idx + 3] = 0
      } else {
        rgba[idx] = Math.round((r / samples / alpha) * 255)
        rgba[idx + 1] = Math.round((g / samples / alpha) * 255)
        rgba[idx + 2] = Math.round((b / samples / alpha) * 255)
        rgba[idx + 3] = Math.round(alpha * 255)
      }
    }
  }
  return rgba
}

// ---- minimal PNG encoder (truecolor + alpha, single IDAT via zlib) ----
const CRC_TABLE: number[] = (() => {
  const table: number[] = new Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer, start: number): number {
  let c = 0xffffffff
  for (let i = start; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function writeU32BE(buf: Buffer, value: number, offset: number): void {
  buf[offset] = (value >>> 24) & 0xff
  buf[offset + 1] = (value >>> 16) & 0xff
  buf[offset + 2] = (value >>> 8) & 0xff
  buf[offset + 3] = value & 0xff
}

/** Encode an RGBA pixel buffer as a PNG. */
function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  // IHDR
  const ihdr = Buffer.alloc(13)
  writeU32BE(ihdr, width, 0)
  writeU32BE(ihdr, height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // Raw image data: one filter byte (0 = None) per scanline.
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = deflateSync(raw, { level: 9 })

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const typeIhdr = Buffer.from('IHDR')
  const typeIdat = Buffer.from('IDAT')
  const typeIend = Buffer.from('IEND')

  const chunk = (type: Buffer, data: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    writeU32BE(head, data.length, 0)
    head.write(type.toString('latin1'), 4, 'latin1')
    const body = Buffer.concat([head, data])
    const tail = Buffer.alloc(4)
    writeU32BE(tail, crc32(body, 4), 0)
    return Buffer.concat([body, tail])
  }

  return Buffer.concat([
    signature,
    chunk(typeIhdr, ihdr),
    chunk(typeIdat, idat),
    chunk(typeIend, Buffer.alloc(0))
  ])
}

function buildTrayIcon(): Electron.NativeImage {
  const size = 32
  const rgba = rasterizeIcon(size)
  const png = encodePng(rgba, size, size)
  const img = nativeImage.createFromBuffer(png, { scaleFactor: 1.0 })
  img.setTemplateImage(false) // colored icon, not a macOS template
  return img
}

export interface ForgeTray {
  tray: Tray
  /** Update the tray tooltip (e.g. session status). */
  setTooltip(text: string): void
  /** Tear down the tray (call before app quit to avoid lingering icons). */
  destroy(): void
}

/** Create the system tray. Single-click shows & focuses the window; the context
 *  menu offers show / new-chat (focused renderer) / quit.
 *  `requestQuit` should set a bypass flag so the window-close handler lets the
 *  app exit (instead of hiding to tray again). */
export function createTray(
  getMainWindow: () => BrowserWindow | null,
  requestQuit: () => void
): ForgeTray | null {
  const icon = buildTrayIcon()

  const showWindow = (): void => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    if (!win.isVisible()) win.show()
    if (win.isMinimized()) win.restore()
    win.focus()
  }

  const tray = new Tray(icon)
  tray.setToolTip('Forge')

  tray.on('click', showWindow)
  tray.on('double-click', showWindow)

  const refreshMenu = (): void => {
    const menu = Menu.buildFromTemplate([
      {
        label: '显示窗口',
        click: showWindow
      },
      {
        label: '新建会话',
        click: () => {
          const win = getMainWindow()
          if (!win || win.isDestroyed()) return
          showWindow()
          // Ask the renderer to start a fresh chat (mirrors the sidebar button).
          win.webContents.send('forge:new-chat-from-tray')
        }
      },
      { type: 'separator' },
      {
        label: '退出 Forge',
        click: () => requestQuit()
      }
    ])
    tray.setContextMenu(menu)
  }
  refreshMenu()

  const setTooltip = (text: string): void => {
    try {
      tray.setToolTip(text)
    } catch {
      /* ignore — tray may be torn down */
    }
  }

  const destroy = (): void => {
    try {
      tray.destroy()
    } catch {
      /* already destroyed */
    }
  }

  log('tray', 'system tray created')
  return { tray, setTooltip, destroy }
}
