/**
 * 从 256px 母版重新生成 icon.ico 的全部尺寸档。
 *
 * 起因（2026-08-12 用户报告）：低分辨率屏上 Tran 图标和高分辨率屏长得不一样。
 * 查下来 ICO 里 ≤48px 的档是另一套简化设计——瓦片顶满画布、无留白、无颗粒
 * 质感，而 ≥64px 才是带留白的正稿。Windows 按 DPI 挑档，于是两块屏看到两个图标。
 *
 * 这里统一从 256px 正稿等比缩放出全部小档（Electron 的 nativeImage 用的是
 * 高质量重采样），保证任何 DPI 下的比例、留白、配色都一致。
 *
 * 用法（在 cli/ 下）：
 *   npx electron scripts/rebuild-icons.js
 * 产物直接覆盖 build/*.ico（四个 ICO 内容相同，历史如此）。
 */
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
const BUILD_DIR = path.join(__dirname, '..', 'build')
const TARGETS = ['icon.ico', 'desktopShortcutIcon.ico', 'installerIcon.ico', 'installerHeaderIcon.ico', 'uninstallerIcon.ico']

/** 从现有 ICO 里取出最大的一档作母版（256px 正稿）。 */
function extractLargest(icoPath) {
  const buf = fs.readFileSync(icoPath)
  const count = buf.readUInt16LE(4)
  let best = null
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16
    const w = buf[o] === 0 ? 256 : buf[o]
    const size = buf.readUInt32LE(o + 8)
    const off = buf.readUInt32LE(o + 12)
    if (!best || w > best.w) best = { w, data: buf.subarray(off, off + size) }
  }
  return best
}

/** ICO 容器：6 字节头 + 每档 16 字节目录项 + 各档 PNG 数据。 */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach((e, i) => {
    const o = i * 16
    dir[o] = e.size >= 256 ? 0 : e.size // 256 记作 0
    dir[o + 1] = e.size >= 256 ? 0 : e.size
    dir[o + 2] = 0 // 调色板数
    dir[o + 3] = 0 // reserved
    dir.writeUInt16LE(1, o + 4) // color planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32LE(e.data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.data.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)])
}

app.whenReady().then(() => {
  const master = extractLargest(path.join(BUILD_DIR, 'icon.ico'))
  if (!master || master.w < 256) {
    console.error('母版尺寸不足 256px，中止')
    app.exit(1)
    return
  }
  const image = nativeImage.createFromBuffer(master.data)
  console.log('母版：', image.getSize())

  const entries = SIZES.map((size) => ({
    size,
    data:
      size === master.w
        ? master.data
        : image.resize({ width: size, height: size, quality: 'best' }).toPNG()
  }))
  const ico = buildIco(entries)
  for (const name of TARGETS) {
    const target = path.join(BUILD_DIR, name)
    if (!fs.existsSync(target)) continue
    fs.writeFileSync(target, ico)
    console.log('已重写', name, `(${(ico.length / 1024).toFixed(0)} KB)`)
  }
  for (const e of entries) console.log(`  ${e.size}x${e.size}  ${(e.data.length / 1024).toFixed(1)}KB`)
  app.exit(0)
})
