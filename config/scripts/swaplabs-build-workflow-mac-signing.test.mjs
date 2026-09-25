import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../src/shared/child-process/run-process'
import packageJson from '../../package.json' with { type: 'json' }
import {
  SWAPLABS_MAC_SIGN_IDENTITY,
  SWAPLABS_UPDATE_PUBLIC_KEY_ENV,
  SWAPLABS_UPDATE_SIGNING_KEY_ENV,
  exportSwaplabsUpdatePublicKey,
  parseSwaplabsUpdateSigningKey,
  swaplabsMacUpdateAssetNames
} from './swaplabs-mac-update-manifest.mjs'
import {
  SWAPLABS_SIGNING_SECRETS,
  SWAPLABS_SIGNING_VARIABLE
} from './swaplabs-mac-signing-setup.mjs'
import {
  WORKFLOW_CODE,
  jobs,
  runWorkflowShell,
  stepIndex,
  stepNamed,
  workflow
} from './swaplabs-build-workflow-shell.mjs'

// LOCAL: contract for the fork build workflow's macOS leg — the signed,
// self-updating mode and its download-only fallback (plan §13.1, §13.3).

const SIGNING_GATE = "steps.signing.outputs.enabled == 'true'"
const MAC_ARCHES = ['x64', 'arm64']

describe('swaplabs fork build macOS signing', () => {
  const mac = jobs['build-mac']
  const index = (name) => stepIndex(mac, name)

  // Why: latest-mac.yml would hand the bundle to Squirrel.Mac, which refuses a
  // non-Developer-ID signature; the fork's own manifest is the only update path.
  it("never lets latest-mac.yml or electron-builder's zip reach the release", () => {
    expect(stepNamed(mac, 'Package macOS artifacts').with.command).not.toMatch(
      /--mac zip|--mac dmg zip/
    )
    for (const step of mac.steps) {
      expect(step.run ?? step.with?.command ?? '').not.toMatch(/upload[^\n]*latest-mac\.yml/)
    }
    expect(stepNamed(mac, 'Upload macOS artifacts').with.command).toBe(
      'gh release upload "$TAG" --repo "$GITHUB_REPOSITORY" --clobber dist/*.dmg'
    )
    expect(stepNamed(mac, 'Verify the macOS assets published').run).toContain(
      "grep -qx 'latest-mac.yml'"
    )
  })

  it('references the signing secrets only in the mac leg, and only by their documented names', () => {
    const secretNames = [...WORKFLOW_CODE.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(
      (match) => match[1]
    )
    expect(new Set(secretNames)).toEqual(new Set(Object.values(SWAPLABS_SIGNING_SECRETS)))
    const variableNames = [...WORKFLOW_CODE.matchAll(/vars\.([A-Z0-9_]+)/g)].map(
      (match) => match[1]
    )
    expect(new Set(variableNames)).toEqual(new Set([SWAPLABS_SIGNING_VARIABLE]))
    for (const [name, job] of Object.entries(jobs)) {
      const text = JSON.stringify(job)
      if (name !== 'build-mac') {
        expect(text, `${name} must not read a secret`).not.toMatch(/secrets\./)
        expect(text, `${name} must not sign`).not.toMatch(/CSC_|keychain/)
      }
    }
    // The public key is a build-time define for every leg, from the workflow env.
    expect(workflow.env[SWAPLABS_UPDATE_PUBLIC_KEY_ENV]).toBe(
      `\${{ vars.${SWAPLABS_SIGNING_VARIABLE} }}`
    )
    expect(mac.env.SWAPLABS_MAC_SIGN_IDENTITY).toBe(SWAPLABS_MAC_SIGN_IDENTITY)
  })

  // The app compiles the key in (electron.vite.config.ts, PR #16) from the env
  // `pnpm build:release` runs electron-vite under, which is the workflow-level
  // value only while no job or step redefines it.
  it('lets the workflow-level public key reach the electron-vite build unshadowed', () => {
    expect(packageJson.scripts['build:release']).toContain('build:electron-vite')
    for (const [name, job] of Object.entries(jobs)) {
      expect(job.env?.[SWAPLABS_UPDATE_PUBLIC_KEY_ENV], `${name} job env`).toBeUndefined()
      for (const step of job.steps) {
        expect(step.env?.[SWAPLABS_UPDATE_PUBLIC_KEY_ENV], `${name}: ${step.name}`).toBeUndefined()
      }
    }
    for (const name of ['build-linux', 'build-mac']) {
      expect(stepNamed(jobs[name], 'Build app').run).toBe('pnpm build:release')
      expect(stepNamed(jobs[name], 'Build app').env).toBeUndefined()
    }
  })

  it('decides first, then imports the keychain before the identity check and the build', () => {
    const decide = stepNamed(mac, 'Decide whether the SwapLabs signing material is available')
    expect(decide.id).toBe('signing')
    expect(index(decide.name)).toBe(0)
    expect(Object.values(decide.env)).toEqual([
      `\${{ secrets.${SWAPLABS_SIGNING_SECRETS.signingKey} != '' }}`,
      `\${{ secrets.${SWAPLABS_SIGNING_SECRETS.certificate} != '' }}`,
      `\${{ secrets.${SWAPLABS_SIGNING_SECRETS.certificatePassword} != '' }}`,
      `\${{ vars.${SWAPLABS_SIGNING_VARIABLE} != '' }}`
    ])
    expect(decide.run).toContain('::warning::')
    expect(decide.run).toContain('swaplabs-mac-signing-setup.mjs')

    const keychain = stepNamed(
      mac,
      'Import the SwapLabs signing certificate into a temporary keychain'
    )
    expect(keychain.if).toBe(SIGNING_GATE)
    expect(keychain.env).toEqual({
      SWAPLABS_MAC_CERT_P12: `\${{ secrets.${SWAPLABS_SIGNING_SECRETS.certificate} }}`,
      SWAPLABS_MAC_CERT_PASSWORD: `\${{ secrets.${SWAPLABS_SIGNING_SECRETS.certificatePassword} }}`
    })
    expect(index(keychain.name)).toBeGreaterThan(index('Checkout'))
    expect(index(keychain.name)).toBeLessThan(index('Verify the fork packaging identity'))
    expect(index('Verify the fork packaging identity')).toBeLessThan(index('Build app'))
    for (const fragment of [
      'security create-keychain',
      'security import',
      'security set-key-partition-list',
      'security list-keychains -d user -s',
      'security add-trusted-cert -d -r trustRoot -p codeSign',
      'security find-identity -v -p codesigning',
      'echo "CSC_NAME=$SWAPLABS_MAC_SIGN_IDENTITY"',
      'echo "CSC_KEYCHAIN=$keychain"',
      'rm -f "$cert_p12"'
    ]) {
      expect(keychain.run).toContain(fragment)
    }
    // The decoded secret is never echoed and never lands in the workspace.
    expect(keychain.run).toContain(
      'printf \'%s\' "$SWAPLABS_MAC_CERT_P12" | base64 --decode >"$cert_p12"'
    )
    expect(keychain.run).toContain('$RUNNER_TEMP/')
    const cleanup = stepNamed(mac, 'Remove the temporary keychain')
    expect(cleanup.if).toBe(`always() && ${SIGNING_GATE}`)
    expect(index(cleanup.name)).toBe(mac.steps.length - 1)
    expect(cleanup.run).toContain('security delete-keychain')
    expect(cleanup.run).toContain('security remove-trusted-cert -d')
  })

  it('zips with ditto, signs with the secret key and verifies locally before any upload', () => {
    const produce = stepNamed(mac, 'Produce the update zips and signed manifests')
    expect(produce.if).toBe(SIGNING_GATE)
    expect(produce.env).toEqual({
      [SWAPLABS_UPDATE_SIGNING_KEY_ENV]: `\${{ secrets.${SWAPLABS_SIGNING_SECRETS.signingKey} }}`
    })
    expect(index(produce.name)).toBeGreaterThan(index('Package macOS artifacts'))
    expect(index(produce.name)).toBeLessThan(index('Confirm the release still exists'))
    expect(produce.run).toContain('for arch in x64 arm64; do')
    expect(produce.run).toContain('ditto -c -k --keepParent "$app" "$zip"')
    expect(produce.run).toContain('dist/mac-arm64/Orca.app')
    expect(produce.run).toContain('swaplabs-mac-update-manifest.mjs emit')
    expect(produce.run).toContain('--app "$app" --zip "$zip"')
    expect(produce.run).toContain(
      '--version "$ORCA_LOCAL_BUILD_VERSION" --commit "$ORCA_BUILD_COMMIT" --out-dir dist'
    )
    expect(produce.run.indexOf('swaplabs-mac-update-manifest.mjs verify')).toBeGreaterThan(
      produce.run.indexOf('swaplabs-mac-update-manifest.mjs emit')
    )
    // Only the signing step sees the private key's value; the decision step sees a boolean.
    for (const step of mac.steps) {
      if (step !== produce) {
        expect(JSON.stringify(step.env ?? {})).not.toContain(
          `secrets.${SWAPLABS_SIGNING_SECRETS.signingKey} }}`
        )
      }
    }
  })

  it('uploads DMG, then both zips, then each signature before its manifest, then verifies', () => {
    const zips = stepNamed(mac, 'Upload the macOS update zips')
    const manifests = stepNamed(mac, 'Upload the macOS update manifests')
    const verify = stepNamed(mac, 'Verify the macOS assets published')
    expect(zips.if).toBe(SIGNING_GATE)
    expect(manifests.if).toBe(SIGNING_GATE)
    // Runs after a failed zip or manifest upload too, so a partial set is
    // reconciled; skipped when no DMG (so no release) is there to reconcile.
    expect(stepNamed(mac, 'Upload macOS artifacts').id).toBe('upload_dmg')
    expect(verify.if).toBe("${{ !cancelled() && steps.upload_dmg.outcome == 'success' }}")
    expect(index('Confirm the release still exists')).toBeLessThan(index('Upload macOS artifacts'))
    expect(index('Upload macOS artifacts')).toBeLessThan(index(zips.name))
    expect(index(zips.name)).toBeLessThan(index(manifests.name))
    expect(index(manifests.name)).toBeLessThan(index(verify.name))
    for (const step of [zips, manifests]) {
      expect(step.env.TAG).toBe('${{ needs.draft.outputs.tag }}')
      expect(step.with.command).not.toContain('latest-mac.yml')
    }
    expect(zips.with.command).toBe(
      'gh release upload "$TAG" --repo "$GITHUB_REPOSITORY" --clobber dist/orca-macos-x64.zip dist/orca-macos-arm64.zip'
    )
    const uploads = manifests.with.command.split(' && ')
    expect(uploads).toEqual(
      MAC_ARCHES.flatMap((arch) => {
        const names = swaplabsMacUpdateAssetNames(arch)
        // Signature first: a manifest the app can see always has its signature.
        return [names.signature, names.manifest].map(
          (name) => `gh release upload "$TAG" --repo "$GITHUB_REPOSITORY" --clobber dist/${name}`
        )
      })
    )
    expect(verify.env).toMatchObject({
      VERSION: '${{ needs.preflight.outputs.version }}',
      COMMIT: '${{ needs.preflight.outputs.commit }}',
      SIGNING_ENABLED: '${{ steps.signing.outputs.enabled }}'
    })
    expect(verify.run).toContain('gh release download')
    expect(verify.run).toContain('swaplabs-mac-update-manifest.mjs verify')
    expect(verify.run).toContain('gh release delete-asset')
  })

  it('leaves the Linux legs and the publish gate untouched by signing', () => {
    for (const name of ['build-linux', 'publish']) {
      const text = JSON.stringify(jobs[name])
      expect(text).not.toMatch(/swaplabs-update-mac|orca-macos-|signing|CSC_/)
    }
    expect(jobs.publish.needs).toEqual(['preflight', 'draft', 'build-linux'])
  })
})

describe('swaplabs fork build macOS signing decision', () => {
  const decide = stepNamed(
    jobs['build-mac'],
    'Decide whether the SwapLabs signing material is available'
  )
  const present = {
    HAS_SIGNING_KEY: 'true',
    HAS_CERT: 'true',
    HAS_CERT_PASSWORD: 'true',
    HAS_PUBLIC_KEY: 'true'
  }
  const decideWith = (env) =>
    runWorkflowShell(decide.run, { mock: '', env: { ...present, ...env } })

  it('enables signing only when all three secrets and the variable are present', async () => {
    const enabled = await decideWith({})
    expect(enabled.exitCode).toBe(0)
    expect(enabled.output).toBe('enabled=true\n')
    expect(enabled.stdout).not.toContain('::warning::')
  })

  it.each([
    ['HAS_SIGNING_KEY', 'secret SWAPLABS_UPDATE_SIGNING_KEY'],
    ['HAS_CERT', 'secret SWAPLABS_MAC_CERT_P12'],
    ['HAS_CERT_PASSWORD', 'secret SWAPLABS_MAC_CERT_PASSWORD'],
    ['HAS_PUBLIC_KEY', 'variable SWAPLABS_UPDATE_PUBLIC_KEY']
  ])('falls back to download-only with a warning naming a missing %s', async (flag, named) => {
    const result = await decideWith({ [flag]: 'false' })
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('enabled=false\n')
    expect(result.stdout).toContain(
      `::warning::macOS fork build is ad-hoc signed and download-only: missing ${named}`
    )
  })
})

describe('swaplabs fork build macOS asset verification', () => {
  const verify = stepNamed(jobs['build-mac'], 'Verify the macOS assets published')
  const version = '1.4.197-swaplabs.202609241530'
  const commit = 'abcdef012345'
  const script = fileURLToPath(new URL('./swaplabs-mac-update-manifest.mjs', import.meta.url))
  const dmgs = ['orca-macos-x64.dmg', 'orca-macos-arm64.dmg']
  const signedAssets = [
    ...dmgs,
    ...MAC_ARCHES.flatMap((arch) => Object.values(swaplabsMacUpdateAssetNames(arch)))
  ]
  // `gh release view` lists $ASSETS minus what delete-asset removed, and fails
  // once VIEW_CALLS_BEFORE_OUTAGE calls have been made; `gh release download`
  // fails its first DOWNLOAD_FAILURES calls, then copies the fixtures into
  // --dir; delete-asset fails DELETE_FAILURES times for DELETE_FAILS and
  // records everything it removed.
  const mock = `gh() {
    case "$*" in
      "release view "*)
        echo view >>"$RUNNER_TEMP/view-calls"
        if [ "$(grep -c view "$RUNNER_TEMP/view-calls")" -gt "\${VIEW_CALLS_BEFORE_OUTAGE:-1000}" ]; then
          echo "HTTP 503: service unavailable" >&2
          return 1
        fi
        for name in $ASSETS; do
          grep -qx "$name" "$RUNNER_TEMP/deleted" 2>/dev/null || printf '%s\\n' "$name"
        done
        ;;
      "release download "*)
        echo download >>"$RUNNER_TEMP/download-calls"
        if [ "$(grep -c download "$RUNNER_TEMP/download-calls")" -le "\${DOWNLOAD_FAILURES:-0}" ]; then
          echo "HTTP 502: bad gateway" >&2
          return 1
        fi
        dir=""
        while [ $# -gt 0 ]; do
          if [ "$1" = "--dir" ]; then dir="$2"; fi
          shift
        done
        cp "$FIXTURES"/* "$dir"/
        ;;
      "release delete-asset "*)
        echo "$4" >>"$RUNNER_TEMP/delete-calls"
        if [ "$4" = "\${DELETE_FAILS:-}" ] && [ "$(grep -cx "$4" "$RUNNER_TEMP/delete-calls")" -le "\${DELETE_FAILURES:-0}" ]; then
          echo "HTTP 502: bad gateway" >&2
          return 1
        fi
        echo "$4" >>"$RUNNER_TEMP/deleted"
        echo "deleted $4"
        ;;
      *) return 1 ;;
    esac
  }
  sleep() { :; }`

  async function signedFixtures() {
    const directory = mkdtempSync(join(tmpdir(), 'swaplabs-mac-assets-'))
    const { privateKey } = generateKeyPairSync('ed25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const publicKey = exportSwaplabsUpdatePublicKey(parseSwaplabsUpdateSigningKey(pem))
    for (const arch of MAC_ARCHES) {
      const names = swaplabsMacUpdateAssetNames(arch)
      writeFileSync(join(directory, names.zip), `zip bytes for ${arch}`)
      const emitted = await runProcess({
        program: process.execPath,
        args: [
          script,
          'emit',
          '--arch',
          arch,
          '--zip',
          join(directory, names.zip),
          '--version',
          version,
          '--commit',
          commit,
          '--out-dir',
          directory,
          '--designated-requirement',
          'identifier "com.stablyai.orca" and certificate leaf = H"0123456789abcdef0123456789abcdef01234567"'
        ],
        env: { ...process.env, [SWAPLABS_UPDATE_SIGNING_KEY_ENV]: pem }
      })
      expect(emitted.code, emitted.stderr).toBe(0)
    }
    return {
      directory,
      publicKey,
      cleanup: () => rmSync(directory, { recursive: true, force: true })
    }
  }

  const check = (fixtures, env = {}) =>
    runWorkflowShell(verify.run, {
      mock,
      env: {
        TAG: 'swaplabs-v1.4.197+202609241530',
        VERSION: version,
        COMMIT: commit,
        SIGNING_ENABLED: 'true',
        ASSETS: signedAssets.join(' '),
        FIXTURES: fixtures.directory,
        [SWAPLABS_UPDATE_PUBLIC_KEY_ENV]: fixtures.publicKey,
        ...env
      }
    })

  it('passes when the uploaded zips, manifests and signatures verify against the compiled-in key', async () => {
    const fixtures = await signedFixtures()
    try {
      const result = await check(fixtures)
      expect(result.exitCode, `${result.stdout} ${result.stderr}`).toBe(0)
      expect(result.stdout).toContain(`Signed macOS update assets verified for ${version}`)
      expect(result.stdout).not.toContain('deleted')
    } finally {
      fixtures.cleanup()
    }
  })

  // The reconciliation the plan requires: a manifest that does not verify must
  // not stay where a live release's updater can fetch it.
  it('removes both manifests and their signatures when an uploaded zip does not match', async () => {
    const fixtures = await signedFixtures()
    try {
      writeFileSync(join(fixtures.directory, 'orca-macos-arm64.zip'), 'corrupted upload')
      const result = await check(fixtures)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('sha512 does not match')
      for (const arch of MAC_ARCHES) {
        const names = swaplabsMacUpdateAssetNames(arch)
        expect(result.stdout).toContain(`deleted ${names.manifest}`)
        expect(result.stdout).toContain(`deleted ${names.signature}`)
      }
      expect(result.stdout).toContain('did not verify and were removed')
    } finally {
      fixtures.cleanup()
    }
  })

  it('removes the manifests when the compiled-in public key does not match the signing key', async () => {
    const fixtures = await signedFixtures()
    try {
      const other = exportSwaplabsUpdatePublicKey(generateKeyPairSync('ed25519').privateKey)
      const result = await check(fixtures, { [SWAPLABS_UPDATE_PUBLIC_KEY_ENV]: other })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('signature does not verify')
      expect(result.stdout).toContain('deleted swaplabs-update-mac-x64.json')
    } finally {
      fixtures.cleanup()
    }
  })

  it.each(signedAssets.filter((name) => !name.endsWith('.dmg')))(
    'fails, removing the manifests that did upload, when %s never uploaded',
    async (missing) => {
      const fixtures = await signedFixtures()
      try {
        const result = await check(fixtures, {
          ASSETS: signedAssets.filter((name) => name !== missing).join(' ')
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).toContain(`missing ${missing}`)
        // Only what the release holds is deleted: a missing name is already gone.
        const deleted = result.stdout.split('\n').filter((line) => line.startsWith('deleted '))
        expect(new Set(deleted)).toEqual(
          new Set(
            signedAssets
              .filter((name) => /\.json(\.sig)?$/.test(name) && name !== missing)
              .map((name) => `deleted ${name}`)
          )
        )
        expect(result.stdout).toContain('did not verify and were removed')
      } finally {
        fixtures.cleanup()
      }
    }
  )

  // The step's promise is that a failed run leaves no manifest behind, so a
  // delete that fails must be retried and, if it keeps failing, said out loud.
  it('retries a transient delete failure and confirms from the release that nothing is left', async () => {
    const fixtures = await signedFixtures()
    try {
      writeFileSync(join(fixtures.directory, 'orca-macos-arm64.zip'), 'corrupted upload')
      const result = await check(fixtures, {
        DELETE_FAILS: 'swaplabs-update-mac-arm64.json',
        DELETE_FAILURES: '1'
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('HTTP 502')
      expect(result.stdout).toContain(
        '::warning::Attempt 1 could not delete swaplabs-update-mac-arm64.json from swaplabs-v1.4.197+202609241530.'
      )
      expect(result.stdout).toContain('deleted swaplabs-update-mac-arm64.json')
      expect(result.stdout).toContain('did not verify and were removed')
      expect(result.stdout).not.toContain('could not be removed')
    } finally {
      fixtures.cleanup()
    }
  })

  it('reports the manifest still attached when every delete attempt fails', async () => {
    const fixtures = await signedFixtures()
    try {
      writeFileSync(join(fixtures.directory, 'orca-macos-arm64.zip'), 'corrupted upload')
      const result = await check(fixtures, {
        DELETE_FAILS: 'swaplabs-update-mac-arm64.json',
        DELETE_FAILURES: '99'
      })
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain(
        '::warning::Attempt 3 could not delete swaplabs-update-mac-arm64.json'
      )
      expect(result.stdout).toContain(
        '::error::Fork release swaplabs-v1.4.197+202609241530: the macOS update manifests did not verify and could not be removed; still attached: swaplabs-update-mac-arm64.json.'
      )
      expect(result.stdout).not.toContain('were removed')
      // The other three were removed and are not reported as attached.
      expect(result.stdout).toContain('deleted swaplabs-update-mac-x64.json')
      expect(result.stdout).not.toContain('still attached: swaplabs-update-mac-x64')
    } finally {
      fixtures.cleanup()
    }
  })

  it('never claims the manifests were removed when the release cannot be listed again', async () => {
    const fixtures = await signedFixtures()
    try {
      writeFileSync(join(fixtures.directory, 'orca-macos-arm64.zip'), 'corrupted upload')
      // One listing for the verification itself; every later one fails.
      const result = await check(fixtures, { VIEW_CALLS_BEFORE_OUTAGE: '1' })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('HTTP 503')
      expect(result.stdout).toContain('whether they were removed could not be confirmed')
      expect(result.stdout).not.toContain('were removed;')
    } finally {
      fixtures.cleanup()
    }
  })

  // The upload steps failed before any manifest landed (the verify step now runs
  // anyway): nothing to remove, and the message must not claim a removal.
  it('reports that no manifest was attached when the uploads never got that far', async () => {
    const fixtures = await signedFixtures()
    try {
      const result = await check(fixtures, { ASSETS: dmgs.join(' ') })
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('missing orca-macos-x64.zip')
      expect(result.stdout).not.toContain('deleted')
      expect(result.stdout).toContain(
        'did not verify; none was attached, so the DMGs stay as download-only assets.'
      )
      expect(result.stdout).not.toContain('were removed')
    } finally {
      fixtures.cleanup()
    }
  })

  it('retries a transient download failure and still verifies the assets', async () => {
    const fixtures = await signedFixtures()
    try {
      const result = await check(fixtures, { DOWNLOAD_FAILURES: '1' })
      expect(result.exitCode, `${result.stdout} ${result.stderr}`).toBe(0)
      expect(result.stdout).toContain(
        '::warning::Attempt 1 could not download the macOS update assets of swaplabs-v1.4.197+202609241530 for verification.'
      )
      expect(result.stdout).toContain(`Signed macOS update assets verified for ${version}`)
      expect(result.stdout).not.toContain('deleted')
    } finally {
      fixtures.cleanup()
    }
  })

  // A check that never ran leaves the manifests as unverified as a check that
  // failed; the release may already be live.
  it('removes the manifests when the assets cannot be downloaded for verification', async () => {
    const fixtures = await signedFixtures()
    try {
      const result = await check(fixtures, { DOWNLOAD_FAILURES: '99' })
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('::warning::Attempt 3 could not download')
      for (const arch of MAC_ARCHES) {
        const names = swaplabsMacUpdateAssetNames(arch)
        expect(result.stdout).toContain(`deleted ${names.manifest}`)
        expect(result.stdout).toContain(`deleted ${names.signature}`)
      }
      expect(result.stdout).toContain(
        'could not be downloaded from the release for verification and were removed'
      )
      expect(result.stdout).not.toContain('did not verify')
    } finally {
      fixtures.cleanup()
    }
  })

  it('in download-only mode requires a DMG and refuses any manifest or latest-mac.yml', async () => {
    const fixtures = await signedFixtures()
    try {
      const ok = await check(fixtures, { SIGNING_ENABLED: 'false', ASSETS: dmgs.join(' ') })
      expect(ok.exitCode, ok.stdout).toBe(0)
      expect(ok.stdout).toContain('Download-only macOS assets verified')
      const stray = await check(fixtures, {
        SIGNING_ENABLED: 'false',
        ASSETS: [...dmgs, 'swaplabs-update-mac-x64.json'].join(' ')
      })
      expect(stray.exitCode).not.toBe(0)
      expect(stray.stdout).toContain('carries an update manifest although')
      const squirrel = await check(fixtures, {
        ASSETS: [...signedAssets, 'latest-mac.yml'].join(' ')
      })
      expect(squirrel.exitCode).not.toBe(0)
      expect(squirrel.stdout).toContain('carries latest-mac.yml')
      const noDmg = await check(fixtures, { SIGNING_ENABLED: 'false', ASSETS: '' })
      expect(noDmg.exitCode).not.toBe(0)
      expect(noDmg.stdout).toContain('missing a DMG')
    } finally {
      fixtures.cleanup()
    }
  })
})
