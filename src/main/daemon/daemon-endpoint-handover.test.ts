import { describe, expect, it } from 'vitest'
import { handedOverEndpointArg } from './daemon-endpoint-handover'
import { parseArgs } from './daemon-entry'

describe('handedOverEndpointArg', () => {
  it('reads the endpoint a draining launch hands over, and refuses one it cannot read', () => {
    const args = ['--socket', '/tmp/test.sock', '--token', '/tmp/test.token']
    expect(handedOverEndpointArg(args)).not.toHaveProperty('handedOverEndpoint')
    expect(handedOverEndpointArg([...args, '--handed-over-endpoint', '64769:1234'])).toHaveProperty(
      'handedOverEndpoint',
      { dev: 64769n, ino: 1234n }
    )
    for (const value of ['', '64769', '64769:', 'a:b', '-1:2', '1:2:3']) {
      expect(() =>
        handedOverEndpointArg([...args, '--handed-over-endpoint', value, '--x'])
      ).toThrow()
    }
  })

  it('leaves the rest of the daemon arguments to upstream parseArgs unchanged', () => {
    const args = ['--socket', '/tmp/test.sock', '--token', '/tmp/test.token']
    expect(parseArgs([...args, '--handed-over-endpoint', '64769:1234'])).toEqual(parseArgs(args))
  })
})
