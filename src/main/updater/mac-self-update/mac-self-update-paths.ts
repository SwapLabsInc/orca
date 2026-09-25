import { basename, dirname, join } from 'node:path'

/**
 * Where the installer keeps its files. State lives under userData; the staged and rollback
 * bundles live beside the app, because a rename is only atomic within one volume and the
 * app's parent directory is the one place guaranteed to share the bundle's.
 */
export type MacSelfUpdatePaths = {
  /** The running bundle, `/Applications/Orca.app`. */
  appPath: string
  /** `Contents/MacOS/<executable>` inside the bundle. */
  executableRelativePath: string
  /** Everything extracted goes under here; pruned whole on failure and on the next launch. */
  stagingDir: string
  /** The rollback bundle the helper moves the current app to, under its own directory. */
  rollbackAppPath: string
  stateDir: string
  downloadsDir: string
  installStatePath: string
  healthMarkerPath: string
  helperOutcomePath: string
}

export function resolveMacSelfUpdatePaths(options: {
  executablePath: string
  userDataPath: string
}): MacSelfUpdatePaths {
  const macOsDir = dirname(options.executablePath)
  const contentsDir = dirname(macOsDir)
  const appPath = dirname(contentsDir)
  const parent = dirname(appPath)
  // Why strip `.app`: a dot-directory named `.Orca.app-…` would itself read as a bundle to Finder.
  const name = basename(appPath).replace(/\.app$/i, '')
  const stateDir = join(options.userDataPath, 'mac-self-update')
  return {
    appPath,
    executableRelativePath: join(
      basename(contentsDir),
      basename(macOsDir),
      basename(options.executablePath)
    ),
    stagingDir: join(parent, `.${name}-update-staging`),
    rollbackAppPath: join(parent, `.${name}-update-rollback`, basename(appPath)),
    stateDir,
    downloadsDir: join(stateDir, 'downloads'),
    installStatePath: join(stateDir, 'install-state.json'),
    healthMarkerPath: join(stateDir, 'launch-healthy'),
    helperOutcomePath: join(stateDir, 'helper-outcome')
  }
}
