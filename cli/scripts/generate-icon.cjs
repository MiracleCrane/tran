/**
 * 应用图标小尺寸字形加粗（任务栏 / 开始菜单 / 桌面快捷方式 / 安装程序共用）。
 *
 * 设计不动，底板一个像素都不重画。这里只解决一件事：**小尺寸下 T 的笔画被
 * 量化掉三成**。
 *
 * 实测（2026-08-05，量的是改之前的 icon.ico）：
 *   256px  横笔 0.0898(23px)  竖笔 0.0859(22px)  白色占比 11.6%
 *    32px  横笔 0.0625( 2px)  竖笔 0.0625( 2px)  白色占比  6.2%
 * 32px 上横笔本该是 0.0898×32 = 2.87px，被舍成 2px —— 丢掉 30% 的墨量，
 * 紫点也淡到几乎看不见，于是任务栏上整个图标偏向"一块纯黑方块"。
 *
 * ⚠ 走过的弯路（别再试一次）：最初的版本是拿 256px 母版整张重新下采样，
 * 结果底部那层颗粒质感被面积平均糊成一片灰、圆角也发虚 —— **比原来更难看**。
 * 原来那几档小图是特意简化过的（去掉颗粒、边缘干净），它们唯一的毛病就是
 * 笔画细。所以现在的做法是：
 *
 * - 读**现有 ico 自己的**每一档子图当底，原样保留（底板/圆角/颗粒全不动）；
 * - 只在 ≤48px 的档位上，按母版量出的几何把白 T 与紫点重画一遍，笔画宽度
 *   向上取整（ceil）保证不被量化吃掉；
 * - ≥64px 一律原样搬运，那些档位本来就够清楚。
 *
 * 输入输出都是 build/icon.ico（原地重写，其余四个 ico 内容一致一并写出）。
 * 重复执行是幂等的：重画用的是固定几何，不是在上一次结果上叠加。
 *
 * 用法：node scripts/generate-icon.cjs
 */
const { deflateSync, inflateSync } = require('node:zlib')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const BUILD_DIR = join(__dirname, '..', 'build')
const SOURCE_ICO = join(BUILD_DIR, 'icon.ico')
/** 这个尺寸以下才重绘字形——再往上原图本来就够清楚。 */
const REDRAW_MAX = 48

/** 从 256px 母版量出的几何（归一化 0..1，见文件头注释）。 */
const GEO = {
  bar: { left: 0.3242, right: 0.6602, top: 0.3203, bottom: 0.4102 },
  stem: { left: 0.4492, right: 0.5352, top: 0.4102, bottom: 0.6719 },
  dot: { cx: 0.7246, cy: 0.2793, r: 0.0391, color: [139, 92, 246] }
}

/* ---------------------------------- PNG ---------------------------------- */

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = size * 4
  const rows = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    rows[y * (stride + 1)] = 0 // filter: none
    rgba.copy(rows, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function decodePng(buf) {
  let pos = 8
  let head = null
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') head = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] }
    if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  if (!head || head.depth !== 8 || head.color !== 6) {
    throw new Error(`母版必须是 8bit RGBA PNG（当前 depth=${head && head.depth} color=${head && head.color}）`)
  }
  const raw = inflateSync(Buffer.concat(idat))
  const w = head.w
  const h = head.h
  const stride = w * 4
  const out = Buffer.alloc(w * h * 4)
  let prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0
      const b = prev[x]
      const c = x >= 4 ? prev[x - 4] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 0xff
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { w: w, h: h, data: out }
}

/* ---------------------------------- ICO 读 -------------------------------- */

/** 拆开 ico，返回 [{size, png(Buffer)}]（本项目的 ico 全部是 PNG 压缩子图）。 */
function readIcoEntries(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('不是合法的 ICO')
  const count = buf.readUInt16LE(4)
  const entries = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    const size = buf[at] || 256
    const bytes = buf.readUInt32LE(at + 8)
    const offset = buf.readUInt32LE(at + 12)
    const data = buf.subarray(offset, offset + bytes)
    if (!(data[0] === 0x89 && data[1] === 0x50)) {
      throw new Error(`${size}px 子图不是 PNG 格式，本脚本只处理 PNG 子图`)
    }
    entries.push({ size: size, png: data })
  }
  return entries
}

/* -------------------------------- 字形重绘 -------------------------------- */

/** 覆盖率（0..1）：像素内 4x4 超采样，够小尺寸用且不糊。 */
function rectCoverage(x, y, rect) {
  let hit = 0
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4
      const py = y + (sy + 0.5) / 4
      if (px >= rect.left && px < rect.right && py >= rect.top && py < rect.bottom) hit++
    }
  }
  return hit / 16
}

function circleCoverage(x, y, cx, cy, r) {
  let hit = 0
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4
      const py = y + (sy + 0.5) / 4
      if (Math.hypot(px - cx, py - cy) <= r) hit++
    }
  }
  return hit / 16
}

function blend(out, o, color, cov) {
  if (cov <= 0) return
  const a = Math.min(1, cov)
  out[o] = Math.round(out[o] * (1 - a) + color[0] * a)
  out[o + 1] = Math.round(out[o + 1] * (1 - a) + color[1] * a)
  out[o + 2] = Math.round(out[o + 2] * (1 - a) + color[2] * a)
  out[o + 3] = Math.max(out[o + 3], Math.round(255 * a))
}

/**
 * 按母版几何重绘白 T，笔画宽度**向上取整**。
 *
 * 关键就是这个 ceil：横笔在 32px 上算出来是 2.87px，直接量化成 2px 会丢掉
 * 30% 的墨量；取 3px 略粗一点点，但在 32px 的画布上肉眼看是"清楚"而不是"胖"。
 *
 * ⚠ 两个踩过的坑：
 * 1. 竖笔**必须**从横笔的整数中心推导。原先横竖各自 `round(中心 - 宽/2)`，
 *    两边取整方向不同就会错开半像素 —— 16/24px 上肉眼可见竖笔偏出横笔中线。
 * 2. 紫点**不重绘**。原图那颗点各档都干净利落；重绘时半径小于 1px 只能强行
 *    抬到 1，抗锯齿一摊就变成一块发糊的紫斑，比原来难看。
 */
function redrawGlyph(out, size) {
  const px = (v) => v * size

  // 横笔：宽度按母版比例，厚度 ceil 到整数像素
  const barCx = (GEO.bar.left + GEO.bar.right) / 2
  const barW = Math.max(1, Math.round(px(GEO.bar.right - GEO.bar.left)))
  const barH = Math.max(1, Math.ceil(px(GEO.bar.bottom - GEO.bar.top)))
  const barLeft = Math.round(px(barCx) - barW / 2)
  const barTop = Math.round(px(GEO.bar.top))
  const bar = { left: barLeft, right: barLeft + barW, top: barTop, bottom: barTop + barH }

  // 竖笔：宽度 ceil；左边界由横笔中心推出，保证两笔共轴（见上面第 1 条）。
  // 顶端接在横笔底部，避免接缝处出现一像素缝。
  const stemW = Math.max(1, Math.ceil(px(GEO.stem.right - GEO.stem.left)))
  const stemLeft = barLeft + Math.round((barW - stemW) / 2)
  const stemBottom = Math.round(px(GEO.stem.bottom))
  const stem = { left: stemLeft, right: stemLeft + stemW, top: bar.bottom, bottom: stemBottom }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4
      const cov = Math.min(1, rectCoverage(x, y, bar) + rectCoverage(x, y, stem))
      blend(out, o, [255, 255, 255], cov)
    }
  }
}

/* ---------------------------------- ICO ---------------------------------- */

function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(entries.length * 16)
  let offset = 6 + dir.length
  entries.forEach((entry, i) => {
    const at = i * 16
    dir[at] = entry.size === 256 ? 0 : entry.size
    dir[at + 1] = entry.size === 256 ? 0 : entry.size
    dir[at + 2] = 0 // palette
    dir[at + 3] = 0 // reserved
    dir.writeUInt16LE(1, at + 4) // color planes
    dir.writeUInt16LE(32, at + 6) // bpp
    dir.writeUInt32LE(entry.png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, dir].concat(entries.map((e) => e.png)))
}

/* --------------------------------- main ---------------------------------- */

/** 白色像素占比（相对不透明像素）：判断笔画墨量是否与大尺寸对齐的量化指标。 */
function whiteRatio(rgba) {
  let bright = 0
  let opaque = 0
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] > 128) {
      opaque++
      if ((rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3 > 140) bright++
    }
  }
  return (bright / Math.max(opaque, 1)) * 100
}

function main() {
  const source = readIcoEntries(readFileSync(SOURCE_ICO))
  console.log(`源 ico：${source.length} 档 ${source.map((e) => e.size).join('/')}`)

  const entries = source.map((entry) => {
    if (entry.size > REDRAW_MAX) {
      console.log(`  ${String(entry.size).padStart(3)}px  原样保留`)
      return entry
    }
    const img = decodePng(entry.png)
    const before = whiteRatio(img.data)
    redrawGlyph(img.data, entry.size)
    const after = whiteRatio(img.data)
    console.log(
      `  ${String(entry.size).padStart(3)}px  白色占比 ${before.toFixed(1)}% → ${after.toFixed(1)}%  (字形加粗)`
    )
    return { size: entry.size, png: encodePng(entry.size, img.data) }
  })

  const ico = buildIco(entries)
  const names = [
    'icon.ico',
    'desktopShortcutIcon.ico',
    'installerIcon.ico',
    'installerHeaderIcon.ico',
    'uninstallerIcon.ico'
  ]
  for (const name of names) writeFileSync(join(BUILD_DIR, name), ico)
  console.log(`写出 ${ico.length} 字节 × ${names.length} 个 ico`)
}

main()
