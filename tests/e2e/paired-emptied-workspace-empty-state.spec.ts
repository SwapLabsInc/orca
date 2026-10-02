/**
 * A paired client whose active workspace loses its last terminal to a host-side close (an
 * orchestration `worker-release` closes the worker's tab this way) must offer a way back
 * instead of a blank pane.
 *
 * Topology: a headless paired Orca runtime host + a paired Orca desktop client. The host owns
 * the workspace's terminals; the client mirrors them. A runtime-owned workspace the user emptied
 * is deliberately not re-seeded (#21630), so the client keeps the workspace active with an empty
 * tab group. Before the fix that group's body rendered nothing at all.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/paired-emptied-workspace-empty-state.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { findPairedWorktreeId } from './helpers/paired-browser-placement-fixture'

async function terminalTabCount(page: Page, worktreeId: string): Promise<number> {
  return page.evaluate(
    (id) => window.__store?.getState().tabsByWorktree[id]?.length ?? -1,
    worktreeId
  )
}

test('a paired workspace emptied by its host offers New Terminal instead of a blank pane', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost()
  let client: Awaited<ReturnType<typeof launchPairedElectronClient>> | null = null
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const created = await host.client.call<{ terminal: { handle: string } }>('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Released worker'
    })

    client = await launchPairedElectronClient(host.offer, testInfo, 'emptied workspace empty state')
    const page = client.page
    const worktreeId = await findPairedWorktreeId(page, testRepoPath)
    await page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )
    await expect
      .poll(() => terminalTabCount(page, worktreeId), {
        timeout: 90_000,
        message: 'paired client never mirrored the host terminal'
      })
      .toBe(1)
    const emptyState = page.locator('[data-tab-group-empty-state]')
    await expect(emptyState).toHaveCount(0)

    // The same runtime close worker-release performs after archiving the worker's output.
    await host.client.call('terminal.close', { terminal: created.result.terminal.handle })

    await expect
      .poll(() => terminalTabCount(page, worktreeId), {
        timeout: 60_000,
        message: 'paired client kept the closed host terminal'
      })
      .toBe(0)
    await expect
      .poll(() => page.evaluate(() => window.__store?.getState().activeWorktreeId ?? null))
      .toBe(worktreeId)
    await expect(emptyState).toBeVisible({ timeout: 30_000 })
    await emptyState.screenshot({ path: testInfo.outputPath('emptied-workspace-empty-state.png') })

    await emptyState.getByRole('button', { name: /New Terminal/ }).click()
    await expect
      .poll(() => terminalTabCount(page, worktreeId), {
        timeout: 60_000,
        message: 'New Terminal in the empty state created no terminal'
      })
      .toBe(1)
    await expect(emptyState).toHaveCount(0)
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
