import { describe, expect, it } from 'vitest'
import {
  WORKFLOW_CODE,
  jobs,
  runWorkflowShell,
  stepIndex,
  stepNamed,
  workflow
} from './swaplabs-build-workflow-shell.mjs'

// LOCAL: contract for the fork build pipeline. Parses the workflow like the
// upstream hourly/dev-channel contract tests so a careless edit fails here
// rather than on the fork's first Actions run. The macOS signing leg has its own
// file, swaplabs-build-workflow-mac-signing.test.mjs.

const runSteps = (job) => job.steps.filter((step) => typeof step.run === 'string')
const commandsOf = (job) => job.steps.map((step) => step.run ?? step.with?.command ?? '').join('\n')
const REPO_GUARD = "github.repository == 'SwapLabsInc/orca'"
const GITHUB_HOSTED_RUNNER = /^(ubuntu|macos)-/

describe('swaplabs fork build triggers and guards', () => {
  it('builds on pushes to swaplabs/main and on a forced dispatch only', () => {
    const triggers = workflow.on ?? workflow[true]
    expect(Object.keys(triggers).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(triggers.push).toEqual({ branches: ['swaplabs/main'] })
    expect(Object.keys(triggers.workflow_dispatch.inputs)).toEqual(['force'])
    expect(triggers.workflow_dispatch.inputs.force.type).toBe('boolean')
    expect(workflow.env.FORK_BRANCH).toBe('swaplabs/main')
  })

  // Why: this file is inherited by every clone of the fork, exactly like the
  // upstream release workflows that guard on stablyai/orca.
  it('guards the entry job on the fork repository and chains every other job to it', () => {
    expect(jobs.preflight.if).toBe(REPO_GUARD)
    const reaches = (name, seen = new Set()) => {
      if (name === 'preflight') {
        return true
      }
      const needs = [jobs[name].needs ?? []].flat()
      return needs.some((need) => !seen.has(need) && reaches(need, new Set([...seen, name])))
    }
    for (const name of Object.keys(jobs)) {
      expect(reaches(name), `${name} must depend on preflight`).toBe(true)
    }
    // The cleanup job runs with always(), so it repeats the guard itself.
    expect(jobs.cleanup.if).toContain('always()')
    expect(jobs.cleanup.if).toContain(REPO_GUARD)
  })

  it('serialises runs so version stamps never collide and a publish is never cut off', () => {
    expect(workflow.concurrency).toEqual({ group: 'swaplabs-build', 'cancel-in-progress': false })
  })

  it('uses GitHub-hosted runners only and has no Windows leg', () => {
    const runners = Object.values(jobs).flatMap((job) => {
      const runsOn = job['runs-on']
      return runsOn.startsWith('${{')
        ? job.strategy.matrix.include.map((entry) => entry.runner)
        : [runsOn]
    })
    for (const runner of runners) {
      expect(runner).toMatch(GITHUB_HOSTED_RUNNER)
      expect(runner).not.toMatch(/blacksmith|windows/i)
    }
    expect(runners).toEqual(
      expect.arrayContaining(['ubuntu-latest', 'ubuntu-24.04-arm', 'macos-15'])
    )
    for (const job of Object.values(jobs)) {
      expect(commandsOf(job)).not.toMatch(/--win\b|windows-setup/)
    }
  })

  it('publishes with GITHUB_TOKEN, minting no App token and using no Apple credential', () => {
    expect(WORKFLOW_CODE).not.toMatch(/create-github-app-token/)
    expect(WORKFLOW_CODE).not.toMatch(/CSC_LINK|APPLE_ID|APPLE_TEAM_ID|SIGNPATH|ORCA_MAC_RELEASE/)
    for (const name of ['draft', 'build-linux', 'build-mac', 'publish', 'cleanup']) {
      expect(jobs[name].permissions).toEqual({ contents: 'write' })
    }
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(jobs.preflight.permissions).toBeUndefined()
  })
})

describe('swaplabs fork build identity', () => {
  it('computes the identity once in preflight and hands it to every leg', () => {
    const identity = stepNamed(jobs.preflight, 'Compute the fork build identity')
    expect(identity.run).toContain('node config/scripts/swaplabs-build-version.mjs')
    expect(identity.run).toContain('SWAPLABS_PREVIOUS_VERSION')
    expect(identity.env.GH_TOKEN).toBe('${{ github.token }}')
    for (const key of ['version', 'tag', 'name', 'commit', 'head_sha']) {
      expect(jobs.preflight.outputs[key]).toBeTruthy()
    }
    for (const name of ['build-linux', 'build-mac']) {
      expect(jobs[name].env.ORCA_LOCAL_BUILD_VERSION).toBe('${{ needs.preflight.outputs.version }}')
      expect(jobs[name].env.ORCA_BUILD_COMMIT).toBe('${{ needs.preflight.outputs.commit }}')
      expect(stepNamed(jobs[name], 'Checkout').with.ref).toBe(
        '${{ needs.preflight.outputs.head_sha }}'
      )
      expect(stepNamed(jobs[name], 'Checkout').with['persist-credentials']).toBe(false)
    }
    expect(stepNamed(jobs.draft, 'Create the draft release').env.TAG).toBe(
      '${{ needs.preflight.outputs.tag }}'
    )
    expect(stepNamed(jobs.draft, 'Create the draft release').run).toContain('--target "$SHA"')
  })

  // The compile-time source registry and the publish target are what make a
  // fork build update from the fork; both must reach the app build and the
  // packaging step unchanged, which the workflow-level env guarantees.
  it('compiles every leg with the SwapLabs release sources and publish target', () => {
    const sources = JSON.parse(workflow.env.ORCA_RELEASE_SOURCES)
    expect(sources).toEqual([
      { id: 'upstream', label: 'Orca upstream', repo: 'stablyai/orca', prereleaseIdentifier: null },
      {
        id: 'swaplabs',
        label: 'SwapLabs',
        repo: 'SwapLabsInc/orca',
        prereleaseIdentifier: 'swaplabs'
      }
    ])
    expect(workflow.env.ORCA_PUBLISH_OWNER).toBe('SwapLabsInc')
    expect(workflow.env.ORCA_PUBLISH_REPO).toBe('orca')
    for (const job of Object.values(jobs)) {
      for (const key of ['ORCA_RELEASE_SOURCES', 'ORCA_PUBLISH_OWNER', 'ORCA_PUBLISH_REPO']) {
        expect(job.env?.[key]).toBeUndefined()
        for (const step of job.steps) {
          expect(step.env?.[key]).toBeUndefined()
        }
      }
    }
  })

  it('verifies the packaging identity before building and never stamps a telemetry identity', () => {
    for (const name of ['build-linux', 'build-mac']) {
      const job = jobs[name]
      const verify = stepIndex(job, 'Verify the fork packaging identity')
      expect(verify).toBeGreaterThanOrEqual(0)
      expect(verify).toBeLessThan(stepIndex(job, 'Build app'))
      expect(job.steps[verify].run).toContain('verify-swaplabs-packaging.mjs')
      expect(stepNamed(job, 'Build app').run).toBe('pnpm build:release')
      expect(Object.keys(job.env)).not.toContain('ORCA_BUILD_IDENTITY')
      for (const step of job.steps) {
        expect(Object.keys(step.env ?? {})).not.toContain('ORCA_BUILD_IDENTITY')
      }
    }
    expect(jobs['build-linux'].env.ORCA_LINUX_ARM64_RELEASE).toContain("matrix.arch == 'arm64'")
  })

  // Why: pnpm's bundled gyp_main.py is not executable on fresh Linux runners, so node-pty's
  // postinstall fails unless the install already sees an external node-gyp.
  it('points the Linux install at an external node-gyp before installing', () => {
    const job = jobs['build-linux']
    const nodeGyp = stepIndex(job, 'Use external node-gyp')
    expect(nodeGyp).toBeGreaterThanOrEqual(0)
    expect(nodeGyp).toBeLessThan(stepIndex(job, 'Install dependencies'))
    expect(job.steps[nodeGyp].run).toContain('npm_config_node_gyp=')
  })

  // Why --publish never everywhere: the orca-fork-ops tag is not `v<version>`,
  // which is the only tag electron-builder's publisher can upload into.
  it('packages with --publish never and uploads into the draft with gh', () => {
    const linuxPackage = stepNamed(jobs['build-linux'], 'Package Linux artifacts').with.command
    expect(linuxPackage).toContain('--linux AppImage deb rpm --${{ matrix.arch }} --publish never')
    expect(linuxPackage).not.toContain('--publish always')
    const macPackage = stepNamed(jobs['build-mac'], 'Package macOS artifacts').with.command
    expect(macPackage).toContain('--mac dmg --x64 --arm64 --publish never')
    for (const [name, upload] of [
      ['build-linux', 'Upload Linux artifacts'],
      ['build-mac', 'Upload macOS artifacts']
    ]) {
      const job = jobs[name]
      const step = stepNamed(job, upload)
      expect(step.with.command).toContain(
        'gh release upload "$TAG" --repo "$GITHUB_REPOSITORY" --clobber'
      )
      expect(step.env.TAG).toBe('${{ needs.draft.outputs.tag }}')
      expect(stepIndex(job, upload)).toBeGreaterThan(
        job.steps.findIndex((candidate) => candidate.name?.startsWith('Confirm the'))
      )
    }
    expect(stepNamed(jobs['build-linux'], 'Upload Linux artifacts').with.command).toContain(
      'dist/${{ matrix.manifest }} dist/${{ matrix.appimage }}'
    )
  })
})

describe('swaplabs fork build publish policy', () => {
  it('requires both Linux legs and verifies both manifests before flipping live', () => {
    expect(jobs.publish.needs).toEqual(['preflight', 'draft', 'build-linux'])
    expect(jobs.publish.needs).not.toContain('build-mac')
    expect(jobs['build-linux'].strategy['fail-fast']).toBe(false)
    expect(jobs['build-linux'].strategy.matrix.include.map((entry) => entry.manifest)).toEqual([
      'latest-linux.yml',
      'latest-linux-arm64.yml'
    ])
    const verify = stepIndex(jobs.publish, 'Verify the Linux update manifests before going live')
    const flip = stepIndex(jobs.publish, 'Publish the verified release')
    expect(verify).toBeGreaterThanOrEqual(0)
    expect(flip).toBeGreaterThan(verify)
    const verifyRun = jobs.publish.steps[verify].run
    for (const asset of [
      'latest-linux.yml',
      'latest-linux-arm64.yml',
      'orca-linux.AppImage',
      'orca-linux-arm64.AppImage'
    ]) {
      expect(verifyRun).toContain(asset)
    }
    expect(jobs.publish.steps[flip].run).toContain('--draft=false --prerelease --title "$NAME"')
    expect(jobs.publish.steps[flip].id).toBe('publish_live')
  })

  it('prunes only the fork series, after a live publish, protecting the new tag', () => {
    const prune = stepNamed(jobs.publish, 'Prune old fork releases')
    expect(prune.if).toBe("steps.publish_live.outcome == 'success'")
    expect(prune.env.TAG).toBe('${{ needs.draft.outputs.tag }}')
    expect(prune.run).toContain('startswith(\\"$SWAPLABS_TAG_PREFIX\\")')
    expect(prune.run).toContain('.[${SWAPLABS_RETAIN_COUNT}:]')
    expect(prune.run).toContain('--cleanup-tag')
    expect(workflow.env.SWAPLABS_TAG_PREFIX).toBe('swaplabs-v')
    expect(workflow.env.SWAPLABS_RETAIN_COUNT).toBe(30)
  })

  it('discards an unpublished draft after any failure but never a live release', () => {
    expect(jobs.cleanup.needs).toEqual(['draft', 'build-linux', 'build-mac', 'publish'])
    expect(jobs.cleanup.if).toContain("needs.publish.result != 'success'")
    expect(jobs.cleanup.if).toContain("needs.draft.outputs.tag != ''")
    const discard = stepNamed(jobs.cleanup, 'Discard the draft release')
    expect(discard.run).toContain('--json isDraft')
    expect(discard.run.match(/gh release delete[^\n]*/)[0]).not.toContain('--cleanup-tag')
  })

  it('keeps every gh call on this repository', () => {
    for (const job of Object.values(jobs)) {
      for (const step of runSteps(job)) {
        const joined = step.run.replace(/\\\n\s*/g, ' ')
        for (const match of joined.matchAll(/gh (?:release|api) [^\n]*/g)) {
          expect(match[0]).toMatch(/--repo "\$GITHUB_REPOSITORY"|"repos\/\$GITHUB_REPOSITORY\//)
        }
      }
    }
  })
})

describe('swaplabs fork build preflight decision', () => {
  const head = 'abcdef0123'.repeat(4)
  const mirror = '0123456789'.repeat(4)
  const freshness = stepNamed(
    jobs.preflight,
    'Check whether swaplabs/main moved since the last fork build'
  )
  const mock = `gh() {
    case "$*" in
      "api repos/SwapLabsInc/orca/git/ref/heads/swaplabs/main "*) printf '%s\\n' "$HEAD_SHA" ;;
      "api repos/SwapLabsInc/orca/git/ref/heads/main "*) printf '%s\\n' "$MIRROR_SHA" ;;
      "release list "*) printf '%s\\n' "$LAST_TAG" ;;
      "release view "*) printf '%s\\n' "$LAST_SHA" ;;
      *) return 1 ;;
    esac
  }`
  const check = (env = {}) =>
    runWorkflowShell(freshness.run, {
      mock,
      env: {
        HEAD_SHA: head,
        MIRROR_SHA: mirror,
        LAST_TAG: 'swaplabs-v1.4.197+202609241000',
        LAST_SHA: head.slice(0, 12),
        FORCED: 'false',
        ...env
      }
    })

  it.each([
    ['unchanged', {}, false],
    ['changed', { LAST_SHA: '123456789012' }, true],
    ['forced', { FORCED: 'true' }, true],
    ['first build', { LAST_TAG: '' }, true],
    ['missing prior identity', { LAST_SHA: '' }, true]
  ])('%s branch selects the expected build decision', async (_name, env, shouldBuild) => {
    const result = await check(env)
    expect(result.exitCode, `${result.stdout} ${result.stderr}`).toBe(0)
    expect(result.output).toBe(
      `head_sha=${head}\nmirror_sha=${mirror}\nshould_build=${shouldBuild}\n`
    )
  })

  it('records an empty mirror sha when the mirror cannot be read', async () => {
    const result = await check({ MIRROR_SHA: 'not-a-sha', LAST_SHA: '' })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('mirror_sha=\n')
  })

  it('fails closed when swaplabs/main cannot be resolved, even when forced', async () => {
    const result = await check({ HEAD_SHA: '', FORCED: 'true' })
    expect(result.exitCode).not.toBe(0)
  })
})

describe('swaplabs fork build manifest gate', () => {
  const verify = stepNamed(jobs.publish, 'Verify the Linux update manifests before going live')
  const version = '1.4.197-swaplabs.202609241530'
  const complete = [
    'latest-linux.yml',
    'latest-linux-arm64.yml',
    'orca-linux.AppImage',
    'orca-linux-arm64.AppImage',
    `orca-ide_${version}_amd64.deb`
  ]
  // `gh release download` writes the manifests; the mock writes whatever
  // MANIFEST_VERSION says so the version check is exercised too.
  const mock = `gh() {
    case "$*" in
      "release view "*) printf '%s\\n' $ASSETS ;;
      "release download "*)
        dir=""
        while [ $# -gt 0 ]; do
          if [ "$1" = "--dir" ]; then dir="$2"; fi
          shift
        done
        printf 'version: %s\\nreleaseDate: now\\n' "$MANIFEST_VERSION" >"$dir/latest-linux.yml"
        printf 'version: "%s"\\n' "$MANIFEST_VERSION" >"$dir/latest-linux-arm64.yml"
        ;;
      *) return 1 ;;
    esac
  }`
  const gate = (env = {}) =>
    runWorkflowShell(verify.run, {
      mock,
      env: {
        TAG: 'swaplabs-v1.4.197+202609241530',
        VERSION: version,
        ASSETS: complete.join(' '),
        MANIFEST_VERSION: version,
        ...env
      }
    })

  it('passes when both manifests and AppImages are uploaded with the stamped version', async () => {
    const result = await gate()
    expect(result.exitCode, `${result.stdout} ${result.stderr}`).toBe(0)
  })

  it.each([
    ['latest-linux.yml'],
    ['latest-linux-arm64.yml'],
    ['orca-linux.AppImage'],
    ['orca-linux-arm64.AppImage']
  ])('refuses to publish without %s', async (missing) => {
    const result = await gate({ ASSETS: complete.filter((name) => name !== missing).join(' ') })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain(`missing ${missing}`)
  })

  // The failure the whole pipeline exists to prevent: a manifest carrying the
  // bare package.json version, which the updater would never match to the fork.
  it('refuses a manifest whose version is not the stamped fork version', async () => {
    const result = await gate({ MANIFEST_VERSION: '1.4.197' })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('does not carry version')
  })
})

describe('swaplabs fork build draft cleanup', () => {
  const discard = stepNamed(jobs.cleanup, 'Discard the draft release')
  const mock = `gh() {
    case "$*" in
      "release view "*) printf '%s\\n' "$IS_DRAFT" ;;
      "release delete "*) echo "deleted $3" ;;
      *) return 1 ;;
    esac
  }`

  it('deletes a draft and leaves a live release alone', async () => {
    const draft = await runWorkflowShell(discard.run, { mock, env: { TAG: 't', IS_DRAFT: 'true' } })
    expect(draft.exitCode).toBe(0)
    expect(draft.stdout).toContain('deleted t')
    const live = await runWorkflowShell(discard.run, { mock, env: { TAG: 't', IS_DRAFT: 'false' } })
    expect(live.exitCode).toBe(0)
    expect(live.stdout).not.toContain('deleted')
    const gone = await runWorkflowShell(discard.run, { mock, env: { TAG: 't', IS_DRAFT: '' } })
    expect(gone.exitCode).toBe(0)
    expect(gone.stdout).not.toContain('deleted')
  })
})
