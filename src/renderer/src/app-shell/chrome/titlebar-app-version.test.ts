import { describe, expect, it } from 'vitest'
import { parseTitlebarAppVersion } from './titlebar-app-version'

describe('parseTitlebarAppVersion', () => {
  it('splits a fork version into its upstream base and revision', () => {
    expect(parseTitlebarAppVersion('1.4.197-swaplabs.3')).toEqual({
      upstream: '1.4.197',
      revision: '3'
    })
    expect(parseTitlebarAppVersion(' 1.4.198-rc.1.swaplabs.202609241530.resume.2 ')).toEqual({
      upstream: '1.4.198-rc.1',
      revision: '2'
    })
  })

  it('has no revision for an upstream or bare fork version', () => {
    expect(parseTitlebarAppVersion('1.4.197')).toEqual({
      upstream: '1.4.197',
      revision: null
    })
    expect(parseTitlebarAppVersion('1.4.197-swaplabs')).toEqual({
      upstream: '1.4.197',
      revision: null
    })
  })

  it('returns null for an empty version', () => {
    expect(parseTitlebarAppVersion('  ')).toBeNull()
  })
})
