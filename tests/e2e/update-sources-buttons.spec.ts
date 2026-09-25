import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Locator, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

declare global {
  // Main-process probe recording the stubbed updater:check calls.
  var __orcaUpdaterCheckCalls: unknown[] | undefined
}

/**
 * The multi-source Updates row: one button per configured release source, the running
 * source marked, a cross-source click that goes through `updater:check` with the listed
 * tag, and every button held while the download runs.
 *
 * Why the skip: the source registry is a compile-time define. Build with
 * `ORCA_RELEASE_SOURCES='[{"id":"upstream",...},{"id":"swaplabs",...}]' npx electron-vite build --mode e2e`
 * and run with the same variable set; an upstream build has one source and no row to assert.
 * Set ORCA_UPDATES_SCREENSHOT_DIR to also copy the captures somewhere outside test-results.
 */
const MULTI_SOURCE_BUILD = Boolean(process.env.ORCA_RELEASE_SOURCES)
const SCREENSHOT_DIR = process.env.ORCA_UPDATES_SCREENSHOT_DIR ?? null

const FORK_VERSION = '1.4.197-swaplabs.202609251710'
const UPSTREAM_LABEL = 'Download 1.4.198 (Orca upstream)'
const FORK_LABEL = `Download ${FORK_VERSION} (SwapLabs)`

test.skip(!MULTI_SOURCE_BUILD, 'needs an app built with ORCA_RELEASE_SOURCES')
test.use({ seedTestRepo: false })

for (const theme of ['dark', 'light'] as const) {
  test(`offers one download per release source and holds the row while downloading (${theme})`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.setViewportSize({ width: 1200, height: 800 })

    // Why main-side stubs: the fixture runs an unpackaged dev build, whose updater answers
    // every check with "not available" and whose version carries no source. The stubs
    // stand in for a fork build with both repositories reachable.
    await electronApp.evaluate(({ ipcMain, BrowserWindow }, forkVersion) => {
      globalThis.__orcaUpdaterCheckCalls = []
      const send = (status: unknown): void => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('updater:status', status)
        }
      }
      ipcMain.removeHandler('updater:getVersion')
      ipcMain.handle('updater:getVersion', () => forkVersion)
      ipcMain.removeHandler('updater:listSources')
      ipcMain.handle('updater:listSources', () => [
        {
          id: 'upstream',
          label: 'Orca upstream',
          running: false,
          install: 'in-app',
          latest: {
            tag: 'v1.4.198',
            version: '1.4.198',
            channel: 'stable',
            name: null,
            publishedAt: null,
            releaseUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.198',
            installerUrl:
              'https://github.com/stablyai/orca/releases/download/v1.4.198/orca-linux.AppImage'
          },
          error: null
        },
        {
          id: 'swaplabs',
          label: 'SwapLabs',
          running: true,
          install: 'in-app',
          latest: {
            tag: 'swaplabs-v1.4.197+202609251710',
            version: forkVersion,
            channel: 'stable',
            name: `${forkVersion} • main • abc1234`,
            publishedAt: null,
            releaseUrl:
              'https://github.com/SwapLabsInc/orca/releases/tag/swaplabs-v1.4.197%2B202609251710',
            installerUrl:
              'https://github.com/SwapLabsInc/orca/releases/download/swaplabs-v1.4.197%2B202609251710/orca-linux.AppImage'
          },
          error: null
        }
      ])
      ipcMain.removeHandler('updater:check')
      ipcMain.handle('updater:check', (_event, options) => {
        globalThis.__orcaUpdaterCheckCalls?.push(options)
        send({ state: 'checking', userInitiated: true, releaseSource: 'upstream' })
        send({ state: 'available', version: '1.4.198', changelog: null, releaseSource: 'upstream' })
        send({ state: 'downloading', percent: 42, version: '1.4.198', releaseSource: 'upstream' })
      })
    }, FORK_VERSION)

    await orcaPage.evaluate(async (theme) => {
      const state = window.__store!.getState()
      await state.updateSettingsOrThrow({ theme })
      state.setUpdateStatus({ state: 'idle' })
      state.openSettingsPage()
    }, theme)
    await expect(orcaPage.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /\blight\b/)
    const search = orcaPage.getByPlaceholder('Search settings')
    await expect(search).toBeVisible({ timeout: 10_000 })
    await search.fill('Check for Updates')

    const section = orcaPage
      .locator('section', { has: orcaPage.getByRole('heading', { name: 'Updates', exact: true }) })
      .last()
    const upstreamButton = section.getByRole('button', { name: UPSTREAM_LABEL, exact: true })
    const forkButton = section.getByRole('button', { name: FORK_LABEL, exact: true })
    await expect(upstreamButton).toBeEnabled()
    await expect(forkButton).toBeDisabled()
    await expect(section.getByText('Current source', { exact: true })).toBeVisible()
    await expect(section.getByText(`Current version: ${FORK_VERSION} · SwapLabs`)).toBeVisible()
    await expect(
      section.getByText(
        'Updates are checked automatically on launch against the SwapLabs releases.'
      )
    ).toBeVisible()
    await capture(section, testInfo, `after-idle-${theme}`)

    await upstreamButton.click()

    await expect(section.getByText('Downloading v1.4.198 (Orca upstream)... 42%')).toBeVisible()
    await expect(upstreamButton).toBeDisabled()
    await expect(forkButton).toBeDisabled()
    await expect(section.getByRole('button', { name: 'Check for Updates' })).toBeDisabled()
    await capture(section, testInfo, `after-downloading-${theme}`)
    const checkCalls = await electronApp.evaluate(() => globalThis.__orcaUpdaterCheckCalls)
    expect(checkCalls).toEqual([
      {
        channel: 'stable',
        targetTag: 'v1.4.198',
        source: 'upstream',
        targetVersion: '1.4.198',
        autoDownload: true
      }
    ])

    // A refused jump names where to fetch the build by hand.
    await orcaPage.evaluate(() => {
      window.__store!.getState().setUpdateStatus({
        state: 'error',
        message:
          'Orca on macOS can only install updates carrying the same code signature, and Orca upstream builds are signed differently. Download the Orca upstream build from its release page and install it by hand.',
        userInitiated: true,
        releaseSource: 'upstream',
        manualInstallUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.198'
      })
    })
    await expect(section.getByRole('link', { name: 'Open download page' })).toHaveAttribute(
      'href',
      'https://github.com/stablyai/orca/releases/tag/v1.4.198'
    )
    await expect(upstreamButton).toBeEnabled()
    await capture(section, testInfo, `after-error-manual-install-${theme}`)
    await orcaPage.screenshot({
      path: testInfo.outputPath(`after-settings-page-${theme}.png`),
      animations: 'disabled'
    })
    if (SCREENSHOT_DIR) {
      copyFileSync(
        testInfo.outputPath(`after-settings-page-${theme}.png`),
        path.join(SCREENSHOT_DIR, `after-settings-page-${theme}.png`)
      )
    }
  })
}

async function capture(section: Locator, testInfo: TestInfo, name: string): Promise<void> {
  const file = testInfo.outputPath(`${name}.png`)
  // The pane re-renders on status changes; retry on a detached element.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await section.scrollIntoViewIfNeeded()
      await section.screenshot({ path: file, animations: 'disabled' })
      break
    } catch (error) {
      if (attempt === 2) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  await testInfo.attach(name, { path: file, contentType: 'image/png' })
  if (SCREENSHOT_DIR) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    copyFileSync(file, path.join(SCREENSHOT_DIR, `${name}.png`))
  }
}
