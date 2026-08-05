import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Kimi CLI 的 home 目录解析（单一出处）。
 *
 * kimi 读写全部数据（会话、索引、凭据、server.token、mcp.json）的根目录是
 * $KIMI_CODE_HOME，未设置时才回退 ~/.kimi-code。用户把 home 指到别处
 * （实测 C:\LegacyD\Programs\kimi-code）时，写死 ~/.kimi-code 的模块会读写到
 * 一份**过期的同构副本**上——路径存在、文件格式对得上、代码全程不报错，但
 * 操作的根本不是 kimi 正在用的那份数据。
 *
 * 实测代价：sessionDelete 因此在旧副本上重写索引、删旧目录，然后返回成功；
 * session/list 走的是真 home，条目原样返回——表现就是「删除会话删不掉，
 * 点几次都没用」。aiTitles / kimiServerApi 的磁盘读同理静默读空。
 *
 * 注意：kimi 的**可执行文件**不随 KIMI_CODE_HOME 走——官方安装器固定装在
 * ~/.kimi-code/bin（kimi 自己上报的 auth command 就是该路径，同时带
 * KIMI_CODE_HOME 环境变量指向数据 home）。定位 exe 的 windowsKimi.ts 因此
 * 保持用 homedir()，不要"顺手"改成这里的 kimiHome()。
 */
export function kimiHome(): string {
  const home = process.env.KIMI_CODE_HOME?.trim()
  return home || join(homedir(), '.kimi-code')
}

/** 会话目录根：$KIMI_CODE_HOME/sessions/wd_<项目>_<hash>/session_<uuid>/ */
export function kimiSessionsRoot(): string {
  return join(kimiHome(), 'sessions')
}

/** 会话索引：每行 {sessionId, sessionDir, workDir} 的 JSONL。 */
export function kimiSessionIndexPath(): string {
  return join(kimiHome(), 'session_index.jsonl')
}
