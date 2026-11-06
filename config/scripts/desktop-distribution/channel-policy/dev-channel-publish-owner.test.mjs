import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectDevChannelPackagingProblems } from './verify-dev-channel-packaging.mjs'

// LOCAL: a fork publishes from the same config into its own repository, so the publish identity
// is env-overridable, and a dev-channel build must refuse an override left set.

const require = createRequire(import.meta.url)
const CONFIG_PATH = resolve(import.meta.dirname, '../../../electron-builder.config.cjs')

/** The config reads process.env at require time, so each identity needs a fresh load. */
function loadConfigWithEnv(env) {
  const saved = { ...process.env }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ORCA_')) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, env)
  try {
    delete require.cache[require.resolve(CONFIG_PATH)]
    return require(CONFIG_PATH)
  } finally {
    process.env = saved
    delete require.cache[require.resolve(CONFIG_PATH)]
  }
}

const WIN_ADHOC_ENV = {
  ORCA_WIN_ADHOC: '1',
  ORCA_ADHOC_BUILD_VERSION: '1.4.178-adhoc.20260819010203'
}

afterEach(() => {
  delete require.cache[require.resolve(CONFIG_PATH)]
})

describe('electron-builder publish identity overrides', () => {
  it('takes the publish owner and repo from the environment, defaulting to stablyai/orca', () => {
    const config = loadConfigWithEnv({
      ORCA_PUBLISH_OWNER: 'SwapLabsInc',
      ORCA_PUBLISH_REPO: 'orca',
      ORCA_LOCAL_BUILD_VERSION: '1.4.197-swaplabs.202609241530'
    })

    expect(config.publish.owner).toBe('SwapLabsInc')
    expect(config.publish.repo).toBe('orca')
    expect(config.extraMetadata.version).toBe('1.4.197-swaplabs.202609241530')
    expect(loadConfigWithEnv({}).publish.owner).toBe('stablyai')
    expect(
      loadConfigWithEnv({ ORCA_PUBLISH_OWNER: '', ORCA_PUBLISH_REPO: '' }).publish
    ).toMatchObject({
      owner: 'stablyai',
      repo: 'orca'
    })
  })

  it('reports a dev-channel build whose publish owner was overridden', () => {
    const config = loadConfigWithEnv({ ...WIN_ADHOC_ENV, ORCA_PUBLISH_OWNER: 'SwapLabsInc' })

    expect(config.publish.owner).toBe('SwapLabsInc')
    expect(
      collectDevChannelPackagingProblems({
        channel: 'adhoc',
        platform: 'win32',
        config,
        env: WIN_ADHOC_ENV
      })
    ).toEqual([expect.stringContaining('publish.owner is "SwapLabsInc"')])
  })

  it('reports a dev-channel build whose publish repo was overridden', () => {
    const config = loadConfigWithEnv({ ...WIN_ADHOC_ENV, ORCA_PUBLISH_REPO: 'orca' })

    expect(config.publish.repo).toBe('orca')
    expect(
      collectDevChannelPackagingProblems({
        channel: 'adhoc',
        platform: 'win32',
        config,
        env: WIN_ADHOC_ENV
      })
    ).toEqual([expect.stringContaining('publish.repo is "orca"')])
  })
})

describe('collectDevChannelPackagingProblems publish owner', () => {
  it('rejects a config whose publish owner is not stablyai', () => {
    const problems = collectDevChannelPackagingProblems({
      channel: 'adhoc',
      platform: 'win32',
      config: {
        publish: { owner: 'SwapLabsInc', repo: 'orca-adhoc', releaseType: 'prerelease' },
        extraMetadata: { version: '1.4.178-adhoc.20260819010203' },
        win: { verifyUpdateCodeSignature: false }
      },
      env: { ORCA_ADHOC_BUILD_VERSION: '1.4.178-adhoc.20260819010203' }
    })

    expect(problems).toEqual([expect.stringContaining('must publish to "stablyai/orca-adhoc"')])
  })
})
