import { parseReleaseSources } from '../../src/shared/release-sources'
import { parseMacSelfUpdatePublicKey } from '../../src/shared/mac-self-update-public-key'

// LOCAL: SwapLabs update-source defines, spread into the main and renderer `define` blocks.
// Why a compile-time define, like the build identity: the registry says which
// repos a packaged app will ever update from, so a shell export must not be able
// to re-point it, and the renderer reads the same table. Parsed with the runtime's
// own parser so a malformed literal fails the build here rather than shipping an
// app that silently falls back to updating from upstream.
const orcaReleaseSources = process.env.ORCA_RELEASE_SOURCES
const ORCA_RELEASE_SOURCES_LITERAL =
  typeof orcaReleaseSources === 'string' && orcaReleaseSources.trim().length > 0
    ? JSON.stringify(JSON.stringify(parseReleaseSources(orcaReleaseSources)))
    : 'null'
// The Ed25519 key SwapLabs macOS builds verify their update manifests with. A define for
// the same reason as the registry: a shell export must not be able to re-key the installer.
// Validated by the runtime's own parser so a bad pipeline variable fails the build here.
const orcaSwapLabsUpdatePublicKey = process.env.ORCA_SWAPLABS_UPDATE_PUBLIC_KEY
const ORCA_SWAPLABS_UPDATE_PUBLIC_KEY_LITERAL =
  typeof orcaSwapLabsUpdatePublicKey === 'string' && orcaSwapLabsUpdatePublicKey.trim().length > 0
    ? JSON.stringify(parseMacSelfUpdatePublicKey(orcaSwapLabsUpdatePublicKey))
    : 'null'

export const SWAPLABS_UPDATE_DEFINES = {
  ORCA_RELEASE_SOURCES: ORCA_RELEASE_SOURCES_LITERAL,
  ORCA_SWAPLABS_UPDATE_PUBLIC_KEY: ORCA_SWAPLABS_UPDATE_PUBLIC_KEY_LITERAL
}
