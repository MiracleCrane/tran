import { Tray, Menu, nativeImage, type BrowserWindow } from 'electron'
import { deflateSync } from 'node:zlib'
import { log } from './logger'

/* ------------------------------------------------------------------ *
 * Tray icon — generated at runtime so no binary asset is needed.
 *
 * We rasterize an anti-aliased RGBA pixel grid (accent rounded square + a
 * white geometric "T" glyph) and encode it as a PNG via Node's zlib + a tiny
 * CRC/PNG chunk writer. The shape mirrors the packaged Tran app icon.
 * ------------------------------------------------------------------ */

const ACCENT_R = 0x8b
const ACCENT_G = 0x5c
const ACCENT_B = 0xf6
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

/**
 * "T" 字形：衬线体。
 *
 * 三笔：两端略加厚的横笔（衬线的味道来源）、竖笔、底部衬线脚。
 *
 * 比例是按「去掉底板之后」重新定的：原来的 T 只占 28.7% 宽，因为外面还有一个
 * 紫色圆角方块托着它；托盘图标在 Windows 上实际渲染到 16px，没有底板还用那个
 * 尺寸就只剩几根细线。现在放大到 62% 宽，让字形本身承担整个图标的视觉重量。
 *
 * 试过斜体带弯钩和加起笔的花体：72px 下确实好看，但托盘那 16px 会把钩和起笔
 * 全糊掉，只剩一个歪着的 T。衬线脚是唯一在 16px 下还能留住的装饰。
 */
const GLYPH_BAR_TOP = 0.25
const GLYPH_BAR_THICKNESS = 0.118
const GLYPH_BAR_HALF_WIDTH = 0.31
/** 横笔端点相对中间加厚多少（0 = 等宽）。再大就成蝴蝶结了。 */
const GLYPH_BAR_END_BOOST = 0.3
const GLYPH_STEM_HALF_WIDTH = 0.072
const GLYPH_STEM_BOTTOM = 0.755
const GLYPH_FOOT_HALF_WIDTH = 0.2
const GLYPH_FOOT_BOTTOM = 0.85

/** 楔形横笔：离中心越远越厚，厚度沿中线两侧对称展开。 */
function inTaperedBar(x: number, y: number, size: number): boolean {
  const halfPx = GLYPH_BAR_HALF_WIDTH * size
  const dx = Math.abs(x - 0.5 * size)
  if (dx > halfPx) return false
  const t = dx / halfPx
  const base = GLYPH_BAR_THICKNESS * size
  const thickness = base * (1 + GLYPH_BAR_END_BOOST * t * t)
  const top = GLYPH_BAR_TOP * size - (thickness - base) / 2
  return y >= top && y <= top + thickness
}

function inTranGlyph(x: number, y: number, size: number): boolean {
  const stem = inRoundedRect(
    x,
    y,
    (0.5 - GLYPH_STEM_HALF_WIDTH) * size,
    GLYPH_BAR_TOP * size,
    (0.5 + GLYPH_STEM_HALF_WIDTH) * size,
    GLYPH_STEM_BOTTOM * size,
    0.018 * size
  )
  const foot = inRoundedRect(
    x,
    y,
    (0.5 - GLYPH_FOOT_HALF_WIDTH) * size,
    GLYPH_STEM_BOTTOM * size,
    (0.5 + GLYPH_FOOT_HALF_WIDTH) * size,
    GLYPH_FOOT_BOTTOM * size,
    0.04 * size
  )
  return inTaperedBar(x, y, size) || stem || foot
}

/**
 * 只画字形，不画底板。
 *
 * 原先是「紫色圆角方块 + 顶部高光渐变 + 一圈内白边 + 白色 T」——那套在
 * 应用图标（大尺寸、有留白）上成立，但托盘里它就是一个紫色小方块，跟旁边
 * 一排系统图标的语言完全不一样，边界感很重。现在只留紫色的 T，背景透明，
 * 跟系统托盘里那些单色图标是一套。
 */
function paintIconSample(x: number, y: number, size: number): PaintSample {
  const sample: PaintSample = { r: 0, g: 0, b: 0, a: 0 }
  if (inTranGlyph(x, y, size)) {
    over(sample, ACCENT_R / 255, ACCENT_G / 255, ACCENT_B / 255, 1)
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
  tray.setToolTip('Tran')

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
        label: '退出 Tran',
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
