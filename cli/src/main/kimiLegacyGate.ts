/**
 * Kimi Code legacy 引擎降级开关（2026-08-24）。
 *
 * (a) 这是 Kimi Code 0.37.0–0.38.0 的临时兼容措施：0.37.0 起 v2 引擎的 ACP 终端守卫
 *     （acp-server acpTerminalRunner.isBashToolInvocation）只放行 Bash 工具的
 *     ['-c', cmd]+NO_COLOR/TERM=dumb 指纹，Grep/Glob 的 rg spawn 必抛
 *     "ACP runtime only supports interactive Bash tool processes"；legacy 引擎下
 *     rg 在 kimi 进程本地 spawn（AcpKaos.exec 委托 LocalKaos），Tran 与 kimi 同机
 *     运行结果等价。
 * (b) 上游由 kimi-code PR #3183 修复（2026-08-23 已合并，但尚无任何正式版包含它，
 *     0.38.0 是合并时的最新发布版，故版本边界上沿取 0.38.0）。
 * (c) 不要永久强制 legacy：legacy 引擎忽略 hooks 等 v2 配置，且该回退标志未来可能
 *     被上游移除。
 * (d) 确认某个正式版包含修复后，更新 GUARD_RANGE_MAX 版本边界或整体删除本模块
 *     （连带 KimiBackend.ensureClient 里的 extraEnv 注入）。
 *
 * 本模块刻意不 import electron / 其他主进程模块，保持可被裸 node 直接测试。
 */

/** 注入给 kimi 子进程的环境变量名（上游官方回退标志）。 */
const LEGACY_FLAG_ENV = 'KIMI_CODE_LEGACY_FLAG'
/** 隐藏手动开关（无 GUI）：'1' 强制注入，'0' 强制不注入，其他/未设走版本门。 */
const OVERRIDE_ENV = 'TRAN_KIMI_LEGACY'

/** 受影响版本区间 [0.37.0, 0.38.0]（含两端），见模块头注释 (b)。 */
const GUARD_RANGE_MIN = [0, 37, 0]
const GUARD_RANGE_MAX = [0, 38, 0]

/** 取 major.minor.patch 三段数字。与 updater.normalizeVersion / kimiVersion.normalize 同规则。 */
function normalizeVersion(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => {
      const parsed = Number.parseInt(part, 10)
      return Number.isFinite(parsed) ? parsed : 0
    })
}

function compareTriples(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 按 kimi 版本决定是否注入 KIMI_CODE_LEGACY_FLAG=1：
 * - TRAN_KIMI_LEGACY=1/0 手动覆盖优先（见 OVERRIDE_ENV）；
 * - 版本在 [0.37.0, 0.38.0] → 注入；
 * - 版本低于 0.37.0（守卫引入前）或高于 0.38.0（视作已含 #3183 修复）→ 不注入；
 * - 版本探测失败（null/undefined/空串）→ 注入：legacy 是 Tran 跑了几个月的引擎，
 *   比撞上 v2 终端守卫（Grep/Glob 全灭）更安全。
 */
export function legacyEngineFlagForKimiVersion(
  version: string | null | undefined
): Record<string, string> | undefined {
  const override = (process.env[OVERRIDE_ENV] ?? '').trim()
  if (override === '1') return { [LEGACY_FLAG_ENV]: '1' }
  if (override === '0') return undefined
  if (!version) return { [LEGACY_FLAG_ENV]: '1' }
  const triple = normalizeVersion(version)
  if (compareTriples(triple, GUARD_RANGE_MIN) >= 0 && compareTriples(triple, GUARD_RANGE_MAX) <= 0) {
    return { [LEGACY_FLAG_ENV]: '1' }
  }
  return undefined
}
