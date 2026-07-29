import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 原子写入：先写同目录下的 .tmp，再 rename 覆盖目标。
 *
 * 直接 writeFileSync 在写到一半崩溃/断电时会留下被截断的 JSON，下次读取
 * 解析失败——各 store 的 catch 会退回空默认值，等于静默丢掉全部数据。
 * rename 在同一文件系统内是原子的，读者要么看到旧内容、要么看到新内容。
 *
 * 同目录 tmp 是必需的：跨盘 rename 会退化成非原子的复制+删除。
 */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    // rename 失败时别把半成品 tmp 留在磁盘上。
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* 清理是尽力而为，不能盖掉原始错误 */
    }
    throw error
  }
}

/** JSON 版本的原子写入。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2))
}

/**
 * 区分「文件不存在」和「读取/解析失败」的 JSON 读取。
 *
 * 调用方据此决定能否安全地覆写：文件不存在 → 可以从空对象开始重建；
 * 读取或解析失败 → 底下可能压着好数据（杀软临时占用、写到一半的文件），
 * 此时覆写会造成永久丢失，必须放弃本次写入。
 */
export type JsonReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  | { status: 'failed'; error: Error }

export function readJsonSafe<T = unknown>(path: string): JsonReadResult<T> {
  if (!existsSync(path)) return { status: 'missing' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) }
  }
  // 空文件当作缺失：常见于此前被截断的写入，重建是安全的。
  if (raw.trim() === '') return { status: 'missing' }
  try {
    return { status: 'ok', value: JSON.parse(raw) as T }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) }
  }
}
