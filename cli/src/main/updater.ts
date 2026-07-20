import { app, shell } from 'electron'
import { createWriteStream, mkdirSync, unlinkSync } from 'node:fs'
import { get } from 'node:https'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
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

function compareVersions(a: string | undefined, b: string | undefined): number {
  const left = normalizeVersion(a)
  const right = normalizeVersion(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function releaseTagFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const tagIndex = parts.findIndex((part, index) => part === 'tag' && parts[index - 1] === 'releases')
    return tagIndex >= 0 ? parts[tagIndex + 1] : undefined
  } catch {
    return undefined
  }
}

function absoluteLocation(location: string, currentUrl: string): string {
  return new URL(location, currentUrl).toString()
}

function requestLatestRelease(url = RELEASES_LATEST_URL, redirects = 5): Promise<LatestReleaseInfo> {
  return new Promise((resolve, reject) => {
    const req = get(
      url,
      {
        headers: {
          Accept: 'text/html,*/*',
          'User-Agent': UPDATE_USER_AGENT
        }
      },
      (res) => {
        const location = res.headers.location
        if (
          location &&
          redirects > 0 &&
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400
        ) {
          const nextUrl = absoluteLocation(location, url)
          const tag = releaseTagFromUrl(nextUrl)
          res.resume()
          if (tag) resolve({ tag, releaseUrl: nextUrl })
          else requestLatestRelease(nextUrl, redirects - 1).then(resolve, reject)
          return
        }

        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GitHub returned ${res.statusCode ?? 'unknown'}: ${body.slice(0, 240)}`))
            return
          }
          const match = body.match(/\/releases\/tag\/([^"'?#/]+)/)
          const tag = match?.[1]
          if (!tag) {
            reject(new Error('Could not resolve latest release tag from GitHub.'))
            return
          }
          resolve({ tag, releaseUrl: `${RELEASES_TAG_BASE_URL}/${tag}` })
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(15000, () => {
      req.destroy(new Error('Update check timed out.'))
    })
  })
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

function pipeDownload(
  url: string,
  destination: string,
  options: PipeDownloadOptions,
  redirects = 5
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => {
      try {
        unlinkSync(destination)
      } catch {
        /* ignore incomplete downloads */
      }
      reject(error)
    }

    const req = get(
      url,
      {
        headers: {
          'User-Agent': UPDATE_USER_AGENT
        }
      },
      (res: IncomingMessage) => {
        const location = res.headers.location
        if (
          location &&
          redirects > 0 &&
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400
        ) {
          const nextUrl = absoluteLocation(location, url)
          res.resume()
          pipeDownload(nextUrl, destination, options, redirects - 1).then(resolve, reject)
          return
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume()
          fail(new Error(`Download returned ${res.statusCode ?? 'unknown'}.`))
          return
        }

        const rawTotal = Array.isArray(res.headers['content-length'])
          ? res.headers['content-length'][0]
          : res.headers['content-length']
        const parsedTotal = Number.parseInt(rawTotal ?? '', 10)
        const totalBytes = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : undefined
        const startedAt = Date.now()
        let receivedBytes = 0
        let lastEmitAt = 0

        const emitProgress = (done = false): void => {
          const now = Date.now()
          if (!done && now - lastEmitAt < 250) return
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
            ...(done ? { done: true } : {})
          }
          options.onProgress?.(progress)
        }

        const file = createWriteStream(destination)
        file.on('error', fail)
        file.on('finish', () => {
          file.close((error) => {
            if (error) fail(error)
            else {
              emitProgress(true)
              resolve()
            }
          })
        })
        res.on('error', fail)
        res.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length
          emitProgress()
        })
        emitProgress()
        res.pipe(file)
      }
    )
    req.on('error', fail)
    req.setTimeout(300000, () => {
      req.destroy(new Error('Update download timed out.'))
    })
  })
}

function safeAssetName(assetUrl: string, fallback = 'Tran-update-setup.exe'): string {
  try {
    const parsed = new URL(assetUrl)
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
    return /setup\.exe$/i.test(name) ? name : fallback
  } catch {
    return fallback
  }
}

export async function downloadAndInstallUpdate(
  options?: RuntimeUpdateDownloadOptions | string
): Promise<UpdateInstallResult> {
  try {
    const normalized = typeof options === 'string' ? { assetUrl: options } : (options ?? {})
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
