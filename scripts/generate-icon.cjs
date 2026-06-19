const { deflateSync } = require('node:zlib')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const OUT_DIR = join(__dirname, '..', 'build')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const PREVIEW_SIZE = 512

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value))
}

function mix(a, b, t) {
  return a + (b - a) * t
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function roundedRectSdf(x, y, cx, cy, w, h, r) {
  const qx = Math.abs(x - cx) - (w / 2 - r)
  const qy = Math.abs(y - cy) - (h / 2 - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

function coverRoundedRect(x, y, cx, cy, w, h, r, aa) {
  return 1 - smoothstep(-aa, aa, roundedRectSdf(x, y, cx, cy, w, h, r))
}

function over(dst, src) {
  const a = src[3] + dst[3] * (1 - src[3])
  if (a <= 0) return [0, 0, 0, 0]
  return [
    (src[0] * src[3] + dst[0] * dst[3] * (1 - src[3])) / a,
    (src[1] * src[3] + dst[1] * dst[3] * (1 - src[3])) / a,
    (src[2] * src[3] + dst[2] * dst[3] * (1 - src[3])) / a,
    a
  ]
}

function renderPixel(x, y, aa) {
  let color = [0, 0, 0, 0]

  const shadow1 = coverRoundedRect(x, y - 0.03, 0.5, 0.5, 0.86, 0.86, 0.23, aa * 3.5)
  color = over(color, [45, 18, 12, shadow1 * 0.16])

  const shadow2 = coverRoundedRect(x, y - 0.014, 0.5, 0.5, 0.88, 0.88, 0.235, aa * 2.5)
  color = over(color, [0, 0, 0, shadow2 * 0.12])

  const body = coverRoundedRect(x, y, 0.5, 0.5, 0.86, 0.86, 0.235, aa)
  if (body > 0) {
    const top = [231, 128, 101]
    const bottom = [205, 94, 73]
    const t = clamp((y - 0.07) / 0.86)
    let r = mix(top[0], bottom[0], t)
    let g = mix(top[1], bottom[1], t)
    let b = mix(top[2], bottom[2], t)

    const highlight = clamp(1 - Math.hypot((x - 0.25) / 0.62, (y - 0.15) / 0.5))
    r = mix(r, 255, highlight * 0.22)
    g = mix(g, 245, highlight * 0.2)
    b = mix(b, 235, highlight * 0.18)

    const lowerShade = smoothstep(0.3, 1, y) * 0.08
    r *= 1 - lowerShade
    g *= 1 - lowerShade
    b *= 1 - lowerShade

    color = over(color, [r, g, b, body * 0.98])
  }

  const rim = coverRoundedRect(x, y, 0.5, 0.5, 0.86, 0.86, 0.235, aa) -
    coverRoundedRect(x, y, 0.5, 0.5, 0.81, 0.81, 0.205, aa)
  if (rim > 0) color = over(color, [255, 235, 220, rim * 0.22])

  const fShadow =
    coverRoundedRect(x, y - 0.012, 0.405, 0.518, 0.091, 0.418, 0.023, aa) +
    coverRoundedRect(x, y - 0.012, 0.505, 0.331, 0.287, 0.087, 0.023, aa) +
    coverRoundedRect(x, y - 0.012, 0.487, 0.488, 0.252, 0.08, 0.021, aa)
  if (fShadow > 0) color = over(color, [92, 28, 18, clamp(fShadow) * 0.18])

  const f =
    coverRoundedRect(x, y, 0.405, 0.518, 0.091, 0.418, 0.023, aa) +
    coverRoundedRect(x, y, 0.505, 0.331, 0.287, 0.087, 0.023, aa) +
    coverRoundedRect(x, y, 0.487, 0.488, 0.252, 0.08, 0.021, aa)
  if (f > 0) color = over(color, [255, 255, 255, clamp(f) * 0.98])

  return color
}

function render(size) {
  const scale = size <= 32 ? 4 : 3
  const hi = size * scale
  const hiPixels = new Float64Array(hi * hi * 4)
  const aa = 1 / hi

  for (let y = 0; y < hi; y++) {
    for (let x = 0; x < hi; x++) {
      const nx = (x + 0.5) / hi
      const ny = (y + 0.5) / hi
      const rgba = renderPixel(nx, ny, aa)
      const i = (y * hi + x) * 4
      hiPixels[i] = rgba[0]
      hiPixels[i + 1] = rgba[1]
      hiPixels[i + 2] = rgba[2]
      hiPixels[i + 3] = rgba[3]
    }
  }

  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const i = ((y * scale + sy) * hi + (x * scale + sx)) * 4
          r += hiPixels[i]
          g += hiPixels[i + 1]
          b += hiPixels[i + 2]
          a += hiPixels[i + 3]
        }
      }
      const n = scale * scale
      const o = (y * size + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round((a / n) * 255)
    }
  }
  return out
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  typeBuffer.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length)
  return out
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const rows = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1)
    rows[rowStart] = 0
    rgba.copy(rows, rowStart + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function ico(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(entries.length * 16)
  let offset = header.length + directory.length
  entries.forEach((entry, index) => {
    const i = index * 16
    directory[i] = entry.size === 256 ? 0 : entry.size
    directory[i + 1] = entry.size === 256 ? 0 : entry.size
    directory[i + 2] = 0
    directory[i + 3] = 0
    directory.writeUInt16LE(1, i + 4)
    directory.writeUInt16LE(32, i + 6)
    directory.writeUInt32LE(entry.data.length, i + 8)
    directory.writeUInt32LE(offset, i + 12)
    offset += entry.data.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)])
}

mkdirSync(OUT_DIR, { recursive: true })

const preview = png(PREVIEW_SIZE, render(PREVIEW_SIZE))
writeFileSync(join(OUT_DIR, 'icon.png'), preview)

const iconEntries = ICO_SIZES.map((size) => ({ size, data: png(size, render(size)) }))
const iconFile = ico(iconEntries)
writeFileSync(join(OUT_DIR, 'icon.ico'), iconFile)
writeFileSync(join(OUT_DIR, 'installerIcon.ico'), iconFile)
writeFileSync(join(OUT_DIR, 'installerHeaderIcon.ico'), iconFile)
writeFileSync(join(OUT_DIR, 'uninstallerIcon.ico'), iconFile)
writeFileSync(join(OUT_DIR, 'desktopShortcutIcon.ico'), iconFile)

console.log(`Generated Forge icon assets in ${OUT_DIR}`)
