import { app } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { log } from './logger'

/**
 * 无项目会话的独立工作目录（2026-09-01 项目模型 Codex 化·第 2 期）。
 *
 * 学 Codex 桌面端：「不在项目中工作」不再落用户主目录，而是每次新建一个
 * 一次性工作目录 `Documents/Tran/YYYY-MM-DD/session-HHmmss-xxxx/`：
 * - slug 只用时间戳 + 随机短码，不用消息文本——事后改名会让会话 cwd 失效；
 * - mkdir 失败（Documents 被重定向到不存在的位置/权限不足）回退
 *   `userData/scratch/` 下同规则目录，绝不让「无项目」入口点不动；
 * - 目录创建时写一份 AGENTS.md 指引（kimi-code 会自动加载 cwd 的 AGENTS.md，
 *   已实证），让 agent 把产出文件写在该目录里、保持整洁。
 */

const AGENTS_MD = `# AGENTS.md

This directory was created automatically by Tran as a scratch working directory
for a session that is not attached to any project.

- Write all output files you produce into this directory (or a subdirectory of it).
- Keep it tidy: clean up temporary files you no longer need.
- Do not treat this directory as a project root with existing conventions — ask the
  user before making assumptions about structure or tooling.

本目录由 Tran 自动创建，作为「不在项目中工作」会话的临时工作目录：
把产出文件写在这里、保持整洁；这里没有既有工程约定，结构性假设先问用户。
`

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYY-MM-DD` / `session-HHmmss-xxxx`（本地时区，xxxx = 4 位随机十六进制防撞）。 */
function scratchSlug(now: Date): { day: string; dirName: string } {
  const day = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  const suffix = randomBytes(2).toString('hex')
  return { day, dirName: `session-${time}-${suffix}` }
}

async function createScratchDir(base: string): Promise<string> {
  const { day, dirName } = scratchSlug(new Date())
  const dir = join(base, day, dirName)
  await mkdir(dir, { recursive: true })
  // 指引落盘失败不致命（目录已可用），只记 log。
  await writeFile(join(dir, 'AGENTS.md'), AGENTS_MD, 'utf8').catch((e: unknown) => {
    log('scratchDirs', `AGENTS.md 写入失败（${dir}）：${e instanceof Error ? e.message : String(e)}`)
  })
  return dir
}

/** 创建并返回一个新的无项目工作目录；Documents 失败回退 userData/scratch。 */
export async function ensureScratchDir(): Promise<string> {
  try {
    return await createScratchDir(join(app.getPath('documents'), 'Tran'))
  } catch (e: unknown) {
    log('scratchDirs', `Documents 下创建失败，回退 userData/scratch：${e instanceof Error ? e.message : String(e)}`)
    return createScratchDir(join(app.getPath('userData'), 'scratch'))
  }
}
