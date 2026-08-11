import { app, net, shell } from 'electron'
import { createWriteStream, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type {
  UpdateAssetInfo,
  UpdateCheckResult,
  UpdateDownloadOptions,
  UpdateDownloadProgress,
  UpdateInstallResult
} from '../shared/ipc'

const UPDATE_REPO = 'MiracleCrane/tran'
const RELEASES_LATEST_URL = `https://github.com/${UPDATE_REPO}/releases/latest`
const RELEASES_TAG_BASE_URL = `https://github.com/${UPDATE_REPO}/releases/tag`
const RELEASES_DOWNLOAD_BASE_URL = `https://github.com/${UPDATE_REPO}/releases/download`
const UPDATE_USER_AGENT = `Tran/${app.getVersion()}`

interface LatestReleaseInfo {
  tag: string
  releaseUrl: string
}

interface RuntimeUpdateDownloadOptions extends UpdateDownloadOptions {
  onProgress?: (progress: UpdateDownloadProgress) => void
}

interface PipeDownloadOptions {
  fileName: string
  requestId?: string
  onProgress?: (progress: UpdateDownloadProgress) => void
}

/** 取 major.minor.patch 三段数字，忽略预发布/构建元数据。 */
function normalizeVersion(version: string | undefined): number[] {
  return String(version ?? '')
    .trim()
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => {
      const parsed = Number.parseInt(part, 10)
      return Number.isFinite(parsed) ? parsed : 0
    })
}

/** 预发布标识（1.2.0-beta.1 的 "beta.1"）；正式版返回空串。
 *  按 semver：有预发布标识的版本低于同号正式版。 */
function prereleaseTag(version: string | undefined): string {
  const match = /^[vV]?\d+(?:\.\d+){0,2}-([0-9A-Za-z.-]+)/.exec(String(version ?? '').trim())
  return match?.[1] ?? ''
}

function compareVersions(a: string | undefined, b: string | undefined): number {
  const left = normalizeVersion(a)
  const right = normalizeVersion(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  // 三段数字相同时按 semver 比预发布标识：1.2.0-beta < 1.2.0。
  // 此前一律返回 0，从预发布升到同号正式版会被判定为「无更新」。
  const leftTag = prereleaseTag(a)
  const rightTag = prereleaseTag(b)
  if (leftTag === rightTag) return 0
  if (!leftTag) return 1
  if (!rightTag) return -1
  return leftTag < rightTag ? -1 : 1
}

async function requestLatestRelease(): Promise<LatestReleaseInfo> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('Update check timed out.')), 15000)
  try {
    // net.fetch 走 Chromium 网络栈，自动遵循系统代理（Node 原生 https 不走代理）。
    // 重定向由 net.fetch 自动跟随（redirect:'manual' 在 Electron 中有 bug，见
    // electron/electron#43715），tag 从最终的 release 页面 HTML 提取。
    const res = await net.fetch(RELEASES_LATEST_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,*/*',
        'User-Agent': UPDATE_USER_AGENT
      }
    })

    const body = await res.text()
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GitHub returned ${res.status}: ${body.slice(0, 240)}`)
    }
    // 字符类排除 `*`：GitHub 页面里嵌有路由模式占位符 /releases/tag/*name，
    // 位置在真实 tag 之前，且 git tag 本身不允许含 `*`。
    const match = body.match(/\/releases\/tag\/([^"'?#/*]+)/)
    const tag = match?.[1]
    if (!tag) {
      throw new Error('Could not resolve latest release tag from GitHub.')
    }
    return { tag, releaseUrl: `${RELEASES_TAG_BASE_URL}/${tag}` }
  } catch (error) {
    // body 读取途中被 abort 时 Chromium 抛的是通用 AbortError，还原为超时错误消息
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function installerAssetForVersion(version: string, tag = `v${version}`): UpdateAssetInfo {
  const name = `Tran-${version}-setup.exe`
  return {
    name,
    browserDownloadUrl: `${RELEASES_DOWNLOAD_BASE_URL}/${tag}/${encodeURIComponent(name)}`
  }
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const checkedAt = Date.now()
  try {
    const release = await requestLatestRelease()
    const latestVersion = release.tag.replace(/^v/i, '') || undefined
    const updateAvailable = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false
    const asset = latestVersion ? installerAssetForVersion(latestVersion, release.tag) : undefined
    return {
      checkedAt,
      currentVersion,
      ...(latestVersion ? { latestVersion } : {}),
      updateAvailable,
      ...(latestVersion ? { releaseName: `Tran ${latestVersion}` } : {}),
      releaseUrl: release.releaseUrl,
      ...(asset ? { asset } : {})
    }
  } catch (error) {
    return {
      checkedAt,
      currentVersion,
      updateAvailable: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function pipeDownload(url: string, destination: string, options: PipeDownloadOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => {
      try {
        unlinkSync(destination)
      } catch {
        /* ignore incomplete downloads */
      }
      // 流读取途中被 abort 时 Chromium 抛的是通用 AbortError，还原为超时错误消息
      reject(controller.signal.aborted ? controller.signal.reason : error)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Update download timed out.')), 300000)
    const done = (): void => {
      clearTimeout(timeout)
    }

    // net.fetch 走 Chromium 网络栈，自动遵循系统代理，并自动跟随重定向
    // （redirect:'manual' 在 Electron 中有 bug，见 electron/electron#43715）。
    net
      .fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': UPDATE_USER_AGENT
        }
      })
      .then((res) => {
        if (res.status < 200 || res.status >= 300 || !res.body) {
          res.body?.cancel().catch(() => {
            /* ignore body teardown errors */
          })
          done()
          fail(new Error(`Download returned ${res.status}.`))
          return
        }

        const parsedTotal = Number.parseInt(res.headers.get('content-length') ?? '', 10)
        const totalBytes = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : undefined
        const startedAt = Date.now()
        let receivedBytes = 0
        let lastEmitAt = 0

        const emitProgress = (finished = false): void => {
          const now = Date.now()
          if (!finished && now - lastEmitAt < 250) return
          lastEmitAt = now
          const elapsedMs = Math.max(now - startedAt, 1)
          const progress: UpdateDownloadProgress = {
            ...(options.requestId ? { requestId: options.requestId } : {}),
            fileName: options.fileName,
            path: destination,
            receivedBytes,
            ...(totalBytes ? { totalBytes } : {}),
            ...(totalBytes ? { percent: Math.min(100, (receivedBytes / totalBytes) * 100) } : {}),
            bytesPerSecond: receivedBytes / (elapsedMs / 1000),
            elapsedMs,
            ...(finished ? { done: true } : {})
          }
          options.onProgress?.(progress)
        }

        const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>)
        const file = createWriteStream(destination)
        file.on('error', (error) => {
          done()
          fail(error)
        })
        file.on('finish', () => {
          file.close((error) => {
            done()
            if (error) fail(error)
            else {
              emitProgress(true)
              resolve()
            }
          })
        })
        body.on('error', (error) => {
          done()
          // 源流出错时 pipe 不会拆掉可写端：不显式 destroy 会泄漏 fd，
          // 且 Windows 上文件句柄没关会让 fail() 里的 unlinkSync 失败，
          // 半个 .exe 留在磁盘上。
          file.destroy()
          fail(error)
        })
        body.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length
          emitProgress()
        })
        emitProgress()
        body.pipe(file)
      })
      .catch((error) => {
        done()
        fail(error)
      })
  })
}

function safeAssetName(assetUrl: string, fallback = 'Tran-update-setup.exe'): string {
  try {
    const parsed = new URL(assetUrl)
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
    // 解码后必须是"纯文件名"：URL 里编码的 %5C（\）/ %2F（/）/ .. 解码后能让
    // join(updateDir, name) 越出下载目录，而下载终点会被 shell.openPath 执行。
    if (/[\\/:]/.test(name) || name.includes('..')) return fallback
    return /setup\.exe$/i.test(name) ? name : fallback
  } catch {
    return fallback
  }
}

/** 只允许从本仓库的 GitHub releases 下载：assetUrl 来自渲染层（IPC 载荷不可信），
 *  下载完成后会 shell.openPath 执行——不设白名单等于给渲染层留了任意代码执行通道。 */
function isAllowedAssetUrl(url: string): boolean {
  return url.startsWith(`${RELEASES_DOWNLOAD_BASE_URL}/`)
}

export async function downloadAndInstallUpdate(
  options?: RuntimeUpdateDownloadOptions | string
): Promise<UpdateInstallResult> {
  try {
    const normalized = typeof options === 'string' ? { assetUrl: options } : (options ?? {})
    if (normalized.assetUrl && !isAllowedAssetUrl(normalized.assetUrl)) {
      throw new Error('Refused to download update from an untrusted URL.')
    }
    const update = normalized.assetUrl ? undefined : await checkForUpdates()
    const url = normalized.assetUrl ?? update?.asset?.browserDownloadUrl
    if (!url) throw new Error('No update installer asset found.')

    const updateDir = normalized.directory?.trim() || join(app.getPath('temp'), 'Tran-updates')
    mkdirSync(updateDir, { recursive: true })
    const fileName = safeAssetName(url)
    const destination = join(updateDir, fileName)
    await pipeDownload(url, destination, {
      fileName,
      ...(normalized.requestId ? { requestId: normalized.requestId } : {}),
      ...(normalized.onProgress ? { onProgress: normalized.onProgress } : {})
    })

    if (normalized.openWhenDone !== false) {
      const openError = await shell.openPath(destination)
      if (openError) throw new Error(openError)
    }
    return { ok: true, path: destination }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
