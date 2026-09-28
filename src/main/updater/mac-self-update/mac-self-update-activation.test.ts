import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setReleaseSourcesLiteralForTest } from '../../../shared/release-sources.fixture'
import type { ReleaseSource } from '../../../shared/release-sources'
import type * as MacSelfUpdateBundle from './mac-self-update-bundle'

type RunningBuild = {
  version: string
  publicKey: string | null
  /** What `codesign -d -r-` says of the running bundle, or the probe's failure. */
  requirement: string | Error
}

const runningBuild = vi.hoisted((): RunningBuild => ({
  version: '1.4.197-swaplabs.202609241530',
  publicKey: 'public-key',
  requirement: 'identifier "com.stablyai.orca" and certificate leaf = H"deadbeef"'
}))
/** Whether this process hosts a supervised `orca serve`, as the handoff module reports it. */
const supervised = vi.hoisted(() => ({ serve: false }))
const recordUpdaterLifecycleMock = vi.hoisted(() => vi.fn())

// Why hoisted: the activation module reads the registry its own import loaded.
vi.hoisted(() => {
  Object.defineProperty(globalThis, 'ORCA_RELEASE_SOURCES', {
    value: JSON.stringify([
      { id: 'upstream', label: 'Orca upstream', repo: 'stablyai/orca', prereleaseIdentifier: null },
      {
        id: 'swaplabs',
        label: 'SwapLabs',
        repo: 'SwapLabsInc/orca',
        prereleaseIdentifier: 'swaplabs'
      },
      {
        id: 'otherlab',
        label: 'Other Lab',
        repo: 'OtherLab/orca',
        prereleaseIdentifier: 'otherlab'
      }
    ]),
    configurable: true,
    enumerable: true,
    writable: true
  })
})

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => runningBuild.version,
    getPath: () => '/Applications/Orca.app/Contents/MacOS/Orca',
    quit: vi.fn()
  },
  net: { fetch: vi.fn() }
}))
vi.mock('../../persistence', () => ({ getCanonicalUserDataPath: () => '/Users/me/Library/Orca' }))
vi.mock('../../serve-update-handoff', () => ({
  hasServeUpdateSupervisor: () => supervised.serve
}))
vi.mock('../../updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))
vi.mock('../../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
vi.mock('../../../shared/mac-self-update-public-key', () => ({
  readMacSelfUpdatePublicKey: () => runningBuild.publicKey
}))
vi.mock('./mac-self-update-bundle', async (importActual) => ({
  ...(await importActual<typeof MacSelfUpdateBundle>()),
  readDesignatedRequirement: async () => {
    if (runningBuild.requirement instanceof Error) {
      throw runningBuild.requirement
    }
    return runningBuild.requirement
  }
}))

const SWAPLABS: ReleaseSource = {
  id: 'swaplabs',
  label: 'SwapLabs',
  repo: 'SwapLabsInc/orca',
  prereleaseIdentifier: 'swaplabs'
}
const OTHER_LAB: ReleaseSource = {
  id: 'otherlab',
  label: 'Other Lab',
  repo: 'OtherLab/orca',
  prereleaseIdentifier: 'otherlab'
}
const UPSTREAM: ReleaseSource = {
  id: 'upstream',
  label: 'Orca upstream',
  repo: 'stablyai/orca',
  prereleaseIdentifier: null
}

describe('mac self-update activation', () => {
  let platformSpy: { mockRestore(): void } | null = null

  beforeEach(() => {
    vi.resetModules()
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    runningBuild.version = '1.4.197-swaplabs.202609241530'
    runningBuild.publicKey = 'public-key'
    runningBuild.requirement = 'identifier "com.stablyai.orca" and certificate leaf = H"deadbeef"'
    supervised.serve = false
    recordUpdaterLifecycleMock.mockReset()
  })

  afterEach(() => {
    platformSpy?.mockRestore()
  })

  afterAll(() => {
    setReleaseSourcesLiteralForTest(null)
  })

  const loadModule = () => import('./mac-self-update-activation')

  // Why: the engine installs nothing another source publishes (a cross-source jump is a manual
  // install), so that source's releases must not be judged by this build's manifest contract.
  it("applies the manifest contract to the running source's releases only", async () => {
    const { getMacSelfUpdateSourceFor, getMacSelfUpdateSupport } = await loadModule()

    expect(getMacSelfUpdateSupport()).toMatchObject({ supported: true, source: { id: 'swaplabs' } })
    expect(getMacSelfUpdateSourceFor(SWAPLABS)).toEqual(SWAPLABS)
    expect(getMacSelfUpdateSourceFor(OTHER_LAB)).toBeNull()
    expect(getMacSelfUpdateSourceFor(UPSTREAM)).toBeNull()

    runningBuild.publicKey = null
    vi.resetModules()
    const withoutKey = await loadModule()
    expect(withoutKey.getMacSelfUpdateSourceFor(SWAPLABS)).toBeNull()
  })

  // Why: a build the installer cannot act for installs by hand, and a release list keyed on the
  // installer's assets would hide the DMG such a build needs.
  it('names an installer source only for a running bundle the installer can act for', async () => {
    const identityBound = await loadModule()
    await expect(identityBound.getMacSelfUpdateInstallerSourceFor(SWAPLABS)).resolves.toEqual(
      SWAPLABS
    )
    await expect(identityBound.getMacSelfUpdateInstallerSourceFor(OTHER_LAB)).resolves.toBeNull()

    runningBuild.requirement = 'cdhash H"00"'
    vi.resetModules()
    const adHoc = await loadModule()
    await expect(adHoc.isMacSelfUpdateActive()).resolves.toBe(false)
    await expect(adHoc.getMacSelfUpdateInstallerSourceFor(SWAPLABS)).resolves.toBeNull()
    // The manifest contract is the engine's, which is selected on the static conditions alone.
    expect(adHoc.getMacSelfUpdateSourceFor(SWAPLABS)).toEqual(SWAPLABS)

    runningBuild.requirement = new Error('codesign: not found')
    vi.resetModules()
    const unprobed = await loadModule()
    await expect(unprobed.getMacSelfUpdateInstallerSourceFor(SWAPLABS)).resolves.toBeNull()
  })

  // Why: the helper's swap, relaunch and health watch are written for the desktop app, and the
  // supervisor restarts a serve on its own terms; such a host keeps the manual update path.
  it('stays inactive under a supervised serve, with one lifecycle diagnostic', async () => {
    supervised.serve = true
    const {
      createMacSelfUpdateEngineIfSupported,
      getMacSelfUpdateInstallerSourceFor,
      getMacSelfUpdateSourceFor,
      getMacSelfUpdateSupport,
      isMacSelfUpdateActive
    } = await loadModule()

    expect(getMacSelfUpdateSupport()).toEqual({ supported: false, reason: 'supervised-serve' })
    expect(createMacSelfUpdateEngineIfSupported()).toBeNull()
    await expect(isMacSelfUpdateActive()).resolves.toBe(false)
    expect(getMacSelfUpdateSourceFor(SWAPLABS)).toBeNull()
    await expect(getMacSelfUpdateInstallerSourceFor(SWAPLABS)).resolves.toBeNull()
    expect(recordUpdaterLifecycleMock).toHaveBeenCalledTimes(1)
    expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
      'mac_self_update_inactive',
      { reason: 'supervised-serve', source: 'swaplabs' },
      expect.objectContaining({ message: expect.stringContaining('supervised serve') })
    )

    // The same build, hosting no supervised serve, is the one the installer acts for.
    supervised.serve = false
    vi.resetModules()
    const desktop = await loadModule()
    expect(desktop.getMacSelfUpdateSupport()).toMatchObject({ supported: true })
    await expect(desktop.isMacSelfUpdateActive()).resolves.toBe(true)

    // A build the installer never acts for says so, not "supervised serve".
    supervised.serve = true
    runningBuild.version = '1.4.197'
    recordUpdaterLifecycleMock.mockReset()
    vi.resetModules()
    const upstream = await loadModule()
    expect(upstream.getMacSelfUpdateSupport()).toEqual({
      supported: false,
      reason: 'primary-source'
    })
    expect(recordUpdaterLifecycleMock).not.toHaveBeenCalled()
  })
})
