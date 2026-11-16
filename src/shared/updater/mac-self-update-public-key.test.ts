import { afterEach, describe, expect, it, vi } from 'vitest'
import { setMacSelfUpdatePublicKeyForTest } from './mac-self-update-public-key.fixture'
import {
  MacSelfUpdatePublicKeyError,
  parseMacSelfUpdatePublicKey,
  readMacSelfUpdatePublicKey
} from './mac-self-update-public-key'

const RAW_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64')

describe('parseMacSelfUpdatePublicKey', () => {
  it('accepts the raw 32-byte key in base64, trimmed', () => {
    expect(parseMacSelfUpdatePublicKey(` ${RAW_KEY_BASE64}\n`)).toBe(RAW_KEY_BASE64)
  })

  it.each([
    ['empty', '   '],
    ['too short', Buffer.alloc(31, 7).toString('base64')],
    ['too long', Buffer.alloc(33, 7).toString('base64')],
    ['a PEM block', '-----BEGIN PUBLIC KEY-----'],
    ['hex', '07'.repeat(32)]
  ])('rejects %s so the build fails instead of shipping a dead installer', (_label, literal) => {
    expect(() => parseMacSelfUpdatePublicKey(literal)).toThrow(MacSelfUpdatePublicKeyError)
  })
})

describe('readMacSelfUpdatePublicKey', () => {
  afterEach(() => {
    setMacSelfUpdatePublicKeyForTest(null)
    vi.restoreAllMocks()
  })

  it('is null without the define, the key with it, and null again for a bad literal', () => {
    expect(readMacSelfUpdatePublicKey()).toBeNull()
    setMacSelfUpdatePublicKeyForTest(RAW_KEY_BASE64)
    expect(readMacSelfUpdatePublicKey()).toBe(RAW_KEY_BASE64)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    setMacSelfUpdatePublicKeyForTest('not-a-key')
    expect(readMacSelfUpdatePublicKey()).toBeNull()
    expect(consoleError).toHaveBeenCalledTimes(1)
  })
})
