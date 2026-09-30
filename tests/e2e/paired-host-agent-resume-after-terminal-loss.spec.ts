/**
 * A paired headless host resumes the agent a pane lost with its terminal.
 *
 * The host (`orca serve`) owns the pane and its agent-status store; a paired desktop client
 * reconnects and re-activates the pane. Whether the pane comes back running `claude --resume <id>`
 * is decided on the host, from what the agent itself reported, so every journey reads the fake
 * agent's launch log (argv per process) rather than any client state.
 *
 * Isolation: every host and client gets its own profile, port and daemon; `ORCA_*` from the shell
 * running the suite (possibly an Orca pane) is removed first so no hook can reach a live Orca.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, forwardElectronProcessLogs, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { cleanupE2EDaemons, readDaemonPidFiles } from './helpers/electron-process-shutdown'
import {
  installFakeClaudeAgent,
  type FakeClaudeAgent,
  type FakeClaudeLaunch
} from './helpers/fake-claude-resume-agent'

test.describe.configure({ mode: 'serial' })

const JOURNEY_TIMEOUT_MS = 480_000
const RESUME_TIMEOUT_MS = 180_000
const scrubbedEnv: Record<string, string> = {}

test.beforeAll(() => {
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key.startsWith('ORCA_') &&
      key !== 'ORCA_BACKGROUND_LAUNCH' &&
      !key.startsWith('ORCA_E2E_')
    ) {
      scrubbedEnv[key] = value
      delete process.env[key]
    }
  }
})

test.afterAll(() => {
  Object.assign(process.env, scrubbedEnv)
})

type Journey = {
  testInfo: TestInfo
  root: string
  agent: FakeClaudeAgent
  host: HeadlessPairedRuntimeHost
  clients: PairedElectronClient[]
  worktreeId: string
}

type HostTerminalTab = {
  type: string
  parentTabId: string
  leafId: string
  status?: string
  launchAgent?: string | null
  agentStatus?: { state?: string; providerSession?: { id?: string } } | null
}

async function openWorktree(client: PairedElectronClient, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        client.page.evaluate(
          (id) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .some((worktree) => worktree.id === id) ?? false,
          worktreeId
        ),
      { timeout: 60_000 }
    )
    .toBe(true)
  await client.page.evaluate(
    ({ environmentId, worktreeId }) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
    },
    { environmentId: client.environmentId, worktreeId }
  )
  await expect
    .poll(() => client.page.evaluate(() => window.__store?.getState().activeWorktreeId), {
      timeout: 30_000
    })
    .toBe(worktreeId)
}

async function startJourney(
  testInfo: TestInfo,
  testRepoPath: string,
  options: { mode: 'idle' | 'working'; clients?: number }
): Promise<Journey> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-host-resume-'))
  const agent = installFakeClaudeAgent(root)
  const host = await launchHeadlessPairedRuntimeHost({
    pinnedServePort: true,
    extraEnv: agent.env(options.mode)
  })
  forwardElectronProcessLogs(host.app, testInfo)
  const clients: PairedElectronClient[] = []
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    let worktreeId = ''
    await expect
      .poll(
        async () => {
          const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
            repo: `id:${added.result.repo.id}`
          })
          worktreeId = listed.result.worktrees[0]?.id ?? ''
          return worktreeId
        },
        { timeout: 30_000 }
      )
      .not.toBe('')
    for (let index = 0; index < (options.clients ?? 1); index += 1) {
      const client = await launchPairedElectronClient(host.offer, testInfo, `resume-${index}`)
      clients.push(client)
      if (process.env.ORCA_E2E_FORWARD_APP_LOGS === '1') {
        client.page.on('console', (message) => console.log(`[client-${index}] ${message.text()}`))
      }
      await openWorktree(client, worktreeId)
    }
    return { testInfo, root, agent, host, clients, worktreeId }
  } catch (error) {
    await disposeJourney({ testInfo, root, agent, host, clients, worktreeId: '' })
    throw error
  }
}

async function disposeJourney(journey: Journey): Promise<void> {
  for (const client of journey.clients) {
    await client.dispose().catch(() => undefined)
  }
  await journey.host.dispose().catch(() => undefined)
  rmSync(journey.root, { recursive: true, force: true })
}

async function hostTerminalTabs(journey: Journey): Promise<HostTerminalTab[]> {
  const listed = await journey.host.client.call<{ tabs: HostTerminalTab[] }>('session.tabs.list', {
    worktree: `id:${journey.worktreeId}`
  })
  return listed.result.tabs.filter((tab) => tab.type === 'terminal')
}

/** Launches Claude the way a user does, from the client's "+" menu, and waits for it to report. */
async function launchClaude(journey: Journey, page: Page): Promise<FakeClaudeLaunch> {
  const before = journey.agent.launches().length
  await page.getByRole('button', { name: 'New tab' }).first().click({ force: true })
  await page
    .getByRole('menuitem', { name: /^Claude(?:\s|$)/i })
    .first()
    .click({ force: true })
  await expect.poll(() => journey.agent.launches().length, { timeout: 60_000 }).toBe(before + 1)
  const launch = journey.agent.launches()[before]!
  // Why: the host store must hold the session before the terminal goes, or there is nothing to lose.
  await expect
    .poll(
      async () =>
        (await hostTerminalTabs(journey)).some(
          (tab) =>
            `${tab.parentTabId}:${tab.leafId}` === launch.paneKey &&
            tab.agentStatus?.providerSession?.id === launch.sessionId
        ),
      { timeout: 60_000 }
    )
    .toBe(true)
  return launch
}

function sigtermDaemons(userDataDir: string): void {
  for (const pid of readDaemonPidFiles(userDataDir)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
}

/** Serve and its daemon both die, as a host reboot takes them. */
async function rebootHost(journey: Journey): Promise<void> {
  await journey.host.restartServeProcess({
    betweenProcesses: async () => {
      sigtermDaemons(journey.host.userDataDir)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      await cleanupE2EDaemons(journey.host.userDataDir)
    }
  })
  forwardElectronProcessLogs(journey.host.app, journey.testInfo)
}

/** Nudges each client the way the OS does when a host comes back, until `done` holds. */
async function nudgeClientsUntil(
  journey: Journey,
  done: () => boolean | Promise<boolean>,
  timeoutMs = RESUME_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await done())) {
    if (Date.now() > deadline) {
      const hostTabs = await hostTerminalTabs(journey).catch((error: unknown) => String(error))
      const clientPanes = await Promise.all(
        journey.clients.map((client) =>
          client.page.evaluate(() =>
            [...(window.__paneManagers ?? new Map()).entries()].map(([tabId, manager]) => ({
              tabId,
              panes: (manager.getPanes?.() ?? []).map((pane) => ({
                ptyId: pane.container.dataset.ptyId ?? null,
                recoveryState: pane.container.dataset.ptyRecoveryState ?? null
              }))
            }))
          )
        )
      )
      throw new Error(
        `Clients never settled after the host came back: ${JSON.stringify({
          hostTabs,
          clientPanes,
          launches: journey.agent.launches()
        })}`
      )
    }
    for (const client of journey.clients) {
      await client.page
        .evaluate((environmentId) => {
          void window.__store?.getState().refreshRuntimeEnvironmentStatus(environmentId)
          window.dispatchEvent(new Event('online'))
        }, client.environmentId)
        .catch(() => undefined)
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

/** Opens a host pane from a client, the way its pane transport does when the user selects it. */
async function activateHostPane(
  journey: Journey,
  client: PairedElectronClient,
  paneKey: string
): Promise<void> {
  const [hostTabId, leafId] = paneKey.split(':')
  await client.page.evaluate((webTabId) => {
    const state = window.__store?.getState()
    state?.setActiveTab(webTabId)
    state?.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
  }, toWebTerminalSurfaceTabId(hostTabId!))
  // Why: a hidden test window mounts no pane for a newly selected tab, so send the activation
  // its transport would send once visible.
  await client.page.evaluate(
    async ({ selector, params }) => {
      await window.api.runtimeEnvironments.call({
        selector,
        method: 'session.tabs.activate',
        params
      })
    },
    {
      selector: client.environmentId,
      params: {
        worktree: `id:${journey.worktreeId}`,
        tabId: hostTabId,
        leafId,
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      }
    }
  )
}

type ClientPaneState = {
  mouseTrackingMode: string | null
  mouseEventsClass: boolean
  recoveryState: string | null
  screen: string
}

async function clientPaneState(
  client: PairedElectronClient,
  paneKey: string
): Promise<ClientPaneState | null> {
  const [hostTabId] = paneKey.split(':')
  return client.page.evaluate((hostTabId) => {
    for (const [tabId, manager] of window.__paneManagers ?? new Map()) {
      if (!decodeURIComponent(tabId).includes(hostTabId)) {
        continue
      }
      const pane = manager.getActivePane?.() ?? manager.getPanes?.()[0]
      if (!pane) {
        continue
      }
      const buffer = pane.terminal.buffer.active
      const lines: string[] = []
      for (let row = 0; row < buffer.length; row += 1) {
        lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
      }
      return {
        mouseTrackingMode: pane.terminal.modes.mouseTrackingMode ?? null,
        mouseEventsClass:
          pane.container.querySelector('.xterm')?.classList.contains('enable-mouse-events') ??
          false,
        recoveryState: pane.container.dataset.ptyRecoveryState ?? null,
        screen: lines.join('\n').trim()
      }
    }
    return null
  }, hostTabId)
}

function resumesOf(journey: Journey, paneKey: string): FakeClaudeLaunch[] {
  return journey.agent
    .launches()
    .filter((launch) => launch.paneKey === paneKey && launch.argv.includes('--resume'))
}

function recordEvidence(testInfo: TestInfo, journey: Journey, extra: unknown): void {
  const file = testInfo.outputPath('host-resume-evidence.json')
  writeFileSync(
    file,
    JSON.stringify(
      { launches: journey.agent.launches(), hookPosts: journey.agent.hookPosts(), extra },
      null,
      2
    )
  )
  void testInfo.attach('host-resume-evidence', { path: file, contentType: 'application/json' })
  console.error(`[host-resume] ${testInfo.title}: ${JSON.stringify(journey.agent.launches())}`)
}

async function expectResumedInPlace(
  journey: Journey,
  launch: FakeClaudeLaunch,
  testInfo: TestInfo
): Promise<void> {
  await nudgeClientsUntil(journey, () => resumesOf(journey, launch.paneKey).length > 0)
  const [resumed] = resumesOf(journey, launch.paneKey)
  expect(resumed!.argv.slice(-2)).toEqual(['--resume', launch.sessionId])
  expect(resumed!.sessionId).toBe(launch.sessionId)
  // The resumed session reports back into the same pane.
  await expect
    .poll(
      async () =>
        (await hostTerminalTabs(journey)).find(
          (tab) => `${tab.parentTabId}:${tab.leafId}` === launch.paneKey
        ),
      { timeout: 60_000 }
    )
    .toMatchObject({
      status: 'ready',
      launchAgent: 'claude',
      agentStatus: { providerSession: { id: launch.sessionId } }
    })
  for (const client of journey.clients) {
    await expect
      .poll(async () => (await clientPaneState(client, launch.paneKey))?.screen ?? '', {
        timeout: 60_000
      })
      .toContain(`FAKE_CLAUDE_READY session=${launch.sessionId} resumed=yes`)
    // Scenario 9: the dead TUI's mouse reporting did not survive into its replacement.
    await expect
      .poll(async () => clientPaneState(client, launch.paneKey), { timeout: 30_000 })
      .toMatchObject({ mouseTrackingMode: 'none', mouseEventsClass: false })
  }
  recordEvidence(testInfo, journey, { hostTabs: await hostTerminalTabs(journey) })
}

test.describe('paired host resumes an agent after losing its terminal', () => {
  for (const firstRequest of ['activation', 'tab list'] as const) {
    test(`a host reboot resumes an idle Claude in the same pane (${firstRequest} first)`, async ({
      testRepoPath
    }, testInfo) => {
      test.setTimeout(JOURNEY_TIMEOUT_MS)
      const journey = await startJourney(testInfo, testRepoPath, { mode: 'idle' })
      try {
        const launch = await launchClaude(journey, journey.clients[0]!.page)
        await rebootHost(journey)
        // Why: whichever request reaches a fresh host first runs its first hydrate; pin both.
        const [hostTabId, leafId] = launch.paneKey.split(':')
        await (firstRequest === 'tab list'
          ? journey.host.client.call('session.tabs.list', { worktree: `id:${journey.worktreeId}` })
          : journey.host.client.call('session.tabs.activate', {
              worktree: `id:${journey.worktreeId}`,
              tabId: hostTabId,
              leafId,
              notifyClients: false,
              navigation: 'caller',
              intent: 'automatic'
            }))
        await expectResumedInPlace(journey, launch, testInfo)
        expect(journey.agent.launches()).toHaveLength(2)
      } finally {
        await disposeJourney(journey)
      }
    })
  }

  test('a host reboot resumes a Claude that was mid-turn', async ({ testRepoPath }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS)
    const journey = await startJourney(testInfo, testRepoPath, { mode: 'working' })
    try {
      const launch = await launchClaude(journey, journey.clients[0]!.page)
      await rebootHost(journey)
      await expectResumedInPlace(journey, launch, testInfo)
      expect(journey.agent.launches()).toHaveLength(2)
    } finally {
      await disposeJourney(journey)
    }
  })

  for (const mode of ['idle', 'working'] as const) {
    test(`a replaced daemon under a running host resumes a ${mode} Claude`, async ({
      testRepoPath
    }, testInfo) => {
      test.setTimeout(JOURNEY_TIMEOUT_MS)
      const journey = await startJourney(testInfo, testRepoPath, { mode })
      try {
        const launch = await launchClaude(journey, journey.clients[0]!.page)
        const daemonPids = readDaemonPidFiles(journey.host.userDataDir)
        expect(daemonPids.length).toBeGreaterThan(0)
        sigtermDaemons(journey.host.userDataDir)
        await expectResumedInPlace(journey, launch, testInfo)
        expect(journey.agent.launches()).toHaveLength(2)
        expect(readDaemonPidFiles(journey.host.userDataDir)).not.toEqual(daemonPids)
      } finally {
        await disposeJourney(journey)
      }
    })
  }

  test('a serve restart over a surviving daemon reattaches without a second launch', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS)
    const journey = await startJourney(testInfo, testRepoPath, { mode: 'idle' })
    try {
      const launch = await launchClaude(journey, journey.clients[0]!.page)
      await journey.host.restartServeProcess()
      forwardElectronProcessLogs(journey.host.app, testInfo)
      await nudgeClientsUntil(journey, async () =>
        (await hostTerminalTabs(journey)).some(
          (tab) => `${tab.parentTabId}:${tab.leafId}` === launch.paneKey && tab.status === 'ready'
        )
      )
      // Give a wrongly issued resume time to show up in the launch log.
      await new Promise((resolve) => setTimeout(resolve, 15_000))
      expect(journey.agent.launches()).toHaveLength(1)
      expect(() => process.kill(launch.pid, 0)).not.toThrow()
      await expect
        .poll(
          async () => (await clientPaneState(journey.clients[0]!, launch.paneKey))?.screen ?? ''
        )
        .toContain(`FAKE_CLAUDE_READY session=${launch.sessionId} resumed=no`)
      recordEvidence(testInfo, journey, { hostTabs: await hostTerminalTabs(journey) })
    } finally {
      await disposeJourney(journey)
    }
  })

  test('an agent the user ended before the reboot stays ended', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS)
    const journey = await startJourney(testInfo, testRepoPath, { mode: 'idle' })
    try {
      const launch = await launchClaude(journey, journey.clients[0]!.page)
      const [hostTabId, leafId] = launch.paneKey.split(':')
      const handle = (
        await journey.host.client.call<{
          terminals: { handle: string; tabId?: string; leafId?: string }[]
        }>('terminal.list', { worktree: `id:${journey.worktreeId}` })
      ).result.terminals.find(
        (terminal) => terminal.tabId === hostTabId && terminal.leafId === leafId
      )?.handle
      expect(handle).toBeTruthy()
      await journey.host.client.call('terminal.send', { terminal: handle, text: '\x04' })
      await expect
        .poll(() =>
          journey.agent
            .hookPosts()
            .some((post) => post.eventName === 'SessionEnd' && post.status === 204)
        )
        .toBe(true)
      await rebootHost(journey)
      await nudgeClientsUntil(journey, async () =>
        (await hostTerminalTabs(journey)).some(
          (tab) => `${tab.parentTabId}:${tab.leafId}` === launch.paneKey && tab.status === 'ready'
        )
      )
      await new Promise((resolve) => setTimeout(resolve, 15_000))
      expect(journey.agent.launches()).toHaveLength(1)
      await expect
        .poll(async () => clientPaneState(journey.clients[0]!, launch.paneKey), { timeout: 30_000 })
        .toMatchObject({ mouseTrackingMode: 'none' })
      recordEvidence(testInfo, journey, { hostTabs: await hostTerminalTabs(journey) })
    } finally {
      await disposeJourney(journey)
    }
  })

  test('a tab closed before the reboot brings nothing back', async ({ testRepoPath }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS)
    const journey = await startJourney(testInfo, testRepoPath, { mode: 'idle' })
    try {
      const launch = await launchClaude(journey, journey.clients[0]!.page)
      const [hostTabId, leafId] = launch.paneKey.split(':')
      const handle = (
        await journey.host.client.call<{
          terminals: { handle: string; tabId?: string; leafId?: string }[]
        }>('terminal.list', { worktree: `id:${journey.worktreeId}` })
      ).result.terminals.find(
        (terminal) => terminal.tabId === hostTabId && terminal.leafId === leafId
      )?.handle
      await journey.host.client.call('terminal.closeTab', { terminal: handle })
      await expect
        .poll(async () =>
          (await hostTerminalTabs(journey)).some((tab) => tab.parentTabId === hostTabId)
        )
        .toBe(false)
      await rebootHost(journey)
      await nudgeClientsUntil(journey, async () => (await hostTerminalTabs(journey)).length >= 0)
      await new Promise((resolve) => setTimeout(resolve, 20_000))
      expect(journey.agent.launches()).toHaveLength(1)
      expect((await hostTerminalTabs(journey)).some((tab) => tab.parentTabId === hostTabId)).toBe(
        false
      )
      recordEvidence(testInfo, journey, { hostTabs: await hostTerminalTabs(journey) })
    } finally {
      await disposeJourney(journey)
    }
  })

  test('two panes in one worktree each resume their own session', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS)
    const journey = await startJourney(testInfo, testRepoPath, { mode: 'idle' })
    try {
      const page = journey.clients[0]!.page
      const first = await launchClaude(journey, page)
      const second = await launchClaude(journey, page)
      expect(first.sessionId).not.toBe(second.sessionId)
      await rebootHost(journey)
      await nudgeClientsUntil(journey, async () => {
        // Panes come back on demand: open each the way the user would.
        for (const launch of [first, second]) {
          if (resumesOf(journey, launch.paneKey).length === 0) {
            await activateHostPane(journey, journey.clients[0]!, launch.paneKey)
          }
        }
        return [first, second].every((launch) => resumesOf(journey, launch.paneKey).length > 0)
      })
      for (const launch of [first, second]) {
        const resumes = resumesOf(journey, launch.paneKey)
        expect(resumes).toHaveLength(1)
        expect(resumes[0]!.argv.slice(-2)).toEqual(['--resume', launch.sessionId])
      }
      expect(journey.agent.launches()).toHaveLength(4)
      recordEvidence(testInfo, journey, { hostTabs: await hostTerminalTabs(journey) })
    } finally {
      await disposeJourney(journey)
    }
  })

  test('two clients reconnecting at once launch the agent exactly once', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS)
    const journey = await startJourney(testInfo, testRepoPath, { mode: 'idle', clients: 2 })
    try {
      const launch = await launchClaude(journey, journey.clients[0]!.page)
      await activateHostPane(journey, journey.clients[1]!, launch.paneKey)
      await expect
        .poll(
          async () => (await clientPaneState(journey.clients[1]!, launch.paneKey))?.screen ?? '',
          {
            timeout: 60_000
          }
        )
        .toContain('FAKE_CLAUDE_READY')
      await rebootHost(journey)
      await expectResumedInPlace(journey, launch, testInfo)
      await new Promise((resolve) => setTimeout(resolve, 10_000))
      expect(resumesOf(journey, launch.paneKey)).toHaveLength(1)
      expect(journey.agent.launches()).toHaveLength(2)
    } finally {
      await disposeJourney(journey)
    }
  })
})
