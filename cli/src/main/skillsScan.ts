import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SkillInfo } from '../shared/ipc'

/**
 * 会话未启动时的技能列表来源：主进程直接扫磁盘上的 SKILL.md。
 *
 * 背景：ACP 后端的技能清单（available_commands_update / listSkills）要等
 * 会话真正起来才有——而 Kimi 会话是懒创建的（第一条消息才启动后端），此前
 * 「/」菜单和技能页都是空的。技能本身是装机/项目级的文件，不依赖会话，
 * 主进程自己扫一遍就能在会话前给出列表；会话起来后仍以 ACP 推送为准。
 *
 * 扫描目标（各只扫一层子目录，不递归）：
 * - <cwd>/.agents/skills/<skill>/SKILL.md     （项目级，同名覆盖用户级）
 * - ~/.agents/skills/<skill>/SKILL.md         （用户级）
 */

/** 只从 frontmatter 的 `---` 块里抠 name/description 两个标量：项目没有
 *  yaml 依赖，也不值得为两个字段引入一个。多行值（|、>）、嵌套结构一律
 *  不解析；没有 frontmatter 时退回目录名 + 空描述。 */
function parseSkillFrontmatter(content: string, dirName: string): SkillInfo {
  const fields: Record<string, string> = {}
  // 剥掉 BOM（显式 charCode 判断，避免在源码里塞不可见字符）。
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  if (text.startsWith('---')) {
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (line.trim() === '---') break
      const m = /^(name|description)\s*:\s*(.*)$/.exec(line)
      if (!m) continue
      // 去掉成对的包围引号；不处理转义（skill 元数据里基本用不到）。
      fields[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    }
  }
  return { name: fields.name || dirName, description: fields.description ?? '' }
}

/** 扫一个 skills 根目录（只一层子目录）；目录不存在/读不了就静默回空。 */
async function scanSkillsRoot(root: string): Promise<SkillInfo[]> {
  const dirents = await readdir(root, { withFileTypes: true }).catch(() => null)
  if (!dirents) return []
  const skills: SkillInfo[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    try {
      const content = await readFile(join(root, dirent.name, 'SKILL.md'), 'utf-8')
      skills.push(parseSkillFrontmatter(content, dirent.name))
    } catch {
      // 单个 skill 读不了（没有 SKILL.md、权限拒绝…）不影响其它条目。
    }
  }
  return skills
}

/** 会话前的技能列表：项目级 + 用户级，按 name 去重，同名时项目级赢。 */
export async function scanSkillsForCwd(cwd: string): Promise<SkillInfo[]> {
  const byName = new Map<string, SkillInfo>()
  // 项目级先入表，用户级只补缺、不覆盖。
  for (const skill of await scanSkillsRoot(join(cwd, '.agents', 'skills'))) {
    byName.set(skill.name, skill)
  }
  for (const skill of await scanSkillsRoot(join(homedir(), '.agents', 'skills'))) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill)
  }
  return [...byName.values()]
}
