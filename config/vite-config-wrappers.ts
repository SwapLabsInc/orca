// LOCAL: electron.vite.config.ts sits at its max-lines limit, so it imports the two wrappers it
// applies through this module instead of adding an import line for the fork's.
export { createDevServeConfig } from './build-plugins/dev-serve-config'
export { withSwaplabsUpdateDefines } from './build-plugins/swaplabs-update-defines'
