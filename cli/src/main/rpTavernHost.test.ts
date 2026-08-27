import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import {
  RP_TAVERN_ROUTER_HEALTH_URL,
  RP_TAVERN_URL,
  RpTavernHost,
  type RpTavernAdapter
} from './rpTavernHost'

const INSTALL = 'C:\\apps\\SillyTavern'
const CONFIG = 'C:\\state\\rp-tavern.json'
const BRIDGE = 'C:\\bridge\\Start-RPTavern.ps1'

class FakeAdapter implements RpTavernAdapter {
  configPath = CONFIG
  installCandidates = [INSTALL]
  bridgeLauncherPath: string | null = BRIDGE
  bridgeInstallPath: string | null = INSTALL
  powershellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  commandPromptPath = 'C:\\Windows\\System32\\cmd.exe'
  files = new Map<string, string>([
    [join(INSTALL, 'server.js'), ''],
    [join(INSTALL, 'Start.bat'), ''],
    [join(INSTALL, 'package.json'), JSON.stringify({ version: '1.18.0' })],
    [BRIDGE, '']
  ])
  urls = new Set<string>()
  spawns: Array<{ command: string; args: string[]; cwd: string }> = []
  opened: string[] = []
  makeReadyOnDelay = false
  spawnError: Error | null = null

  exists(path: string): boolean { return this.files.has(path) }
  readText(path: string): string { return this.files.get(path) ?? '' }
  writeText(path: string, content: string): void { this.files.set(path, content) }
  ensureDirectory(): void {}
  async commandOutput(): Promise<string> { return 'v22.14.0\n' }
  async spawnDetached(command: string, args: string[], cwd: string): Promise<void> {
    if (this.spawnError) throw this.spawnError
    this.spawns.push({ command, args, cwd })
  }
  async checkUrl(url: string): Promise<boolean> { return this.urls.has(url) }
  async delay(): Promise<void> {
    if (this.makeReadyOnDelay) this.urls.add(RP_TAVERN_URL)
  }
  async openWindow(url: string): Promise<void> { this.opened.push(url) }
}

test('detects a valid external installation and runtime', async () => {
  const adapter = new FakeAdapter()
  adapter.urls.add(RP_TAVERN_URL)
  adapter.urls.add(RP_TAVERN_ROUTER_HEALTH_URL)
  const status = await new RpTavernHost(adapter).getStatus()
  assert.equal(status.installed, true)
  assert.equal(status.version, '1.18.0')
  assert.equal(status.nodeCompatible, true)
  assert.equal(status.running, true)
  assert.equal(status.autoRouterReady, true)
})

test('opens an already running tavern without spawning services', async () => {
  const adapter = new FakeAdapter()
  adapter.urls.add(RP_TAVERN_URL)
  const result = await new RpTavernHost(adapter).open()
  assert.equal(result.ok, true)
  assert.equal(adapter.spawns.length, 0)
  assert.deepEqual(adapter.opened, [RP_TAVERN_URL])
})

test('starts the companion launcher and waits until the tavern is ready', async () => {
  const adapter = new FakeAdapter()
  adapter.makeReadyOnDelay = true
  const result = await new RpTavernHost(adapter, {
    readinessAttempts: 2,
    readinessIntervalMs: 0
  }).open()
  assert.equal(result.ok, true)
  assert.equal(adapter.spawns[0]?.command, adapter.powershellPath)
  assert.equal(adapter.spawns[0]?.args.includes('-NoBrowser'), true)
  assert.deepEqual(adapter.opened, [RP_TAVERN_URL])
})

test('persists a valid configured installation path', async () => {
  const adapter = new FakeAdapter()
  const status = await new RpTavernHost(adapter).configure(`"${INSTALL}"`)
  assert.equal(status.installPath, INSTALL)
  assert.match(adapter.files.get(CONFIG) ?? '', /SillyTavern/)
})

test('reports an invalid installation without persisting it', async () => {
  const adapter = new FakeAdapter()
  const status = await new RpTavernHost(adapter).configure('C:\\missing')
  assert.equal(status.installed, false)
  assert.equal(adapter.files.has(CONFIG), false)
  assert.equal(status.issues.length > 0, true)
})

test('returns the process creation error instead of waiting for a timeout', async () => {
  const adapter = new FakeAdapter()
  adapter.spawnError = new Error('spawn denied')

  const result = await new RpTavernHost(adapter, {
    readinessAttempts: 2,
    readinessIntervalMs: 0
  }).open()

  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /spawn denied/)
  assert.deepEqual(adapter.opened, [])
})
