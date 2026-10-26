// CI release builds substitute telemetry credentials; contributor builds use null and console-mirror only.
// No runtime env fallback: shell exports must not enable telemetry transmission.
declare const ORCA_BUILD_IDENTITY: 'stable' | 'rc' | null
declare const ORCA_POSTHOG_WRITE_KEY: string | null

// CI supplies the diagnostics token endpoint; null disables upload in contributor builds.
// ORCA_DIAGNOSTICS_TOKEN_URL overrides it for developers testing packaged builds against staging.
declare const ORCA_DIAGNOSTICS_TOKEN_URL: string | null

// Full commit the build was made from (`git rev-parse HEAD`); official skill installs pin to it.
declare const ORCA_BUILD_COMMIT: string

// ORCA_LAYOUT_OWNER is declared and read in one place: src/shared/layout-owner-switch.ts.

// ORCA_RELEASE_SOURCES (the update-source registry) is declared beside its
// reader in `src/shared/release-sources.ts`, because the renderer typecheck
// includes `src/shared` but not this directory.
//
// ORCA_SWAPLABS_UPDATE_PUBLIC_KEY (LOCAL: the key SwapLabs macOS builds verify
// update manifests with) is declared beside its reader in
// `src/shared/mac-self-update-public-key.ts` for the same reason.
