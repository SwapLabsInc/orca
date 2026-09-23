/**
 * The chooser is a BLOCKING decision surface: it decides which conversation a terminal resumes.
 * A missing key falls back to the inline English default with nothing at runtime to signal the
 * gap, so every shipped locale must carry the block, and none of them may ship the English source.
 */
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const CHOOSER_PATH = ['components', 'terminalPane', 'AgentResumeChooser'] as const
const KEYS = ['label', 'title', 'help', 'dismiss'] as const
const TRANSLATED = { es, fr, ja, ko, zh }

function readChild(node: unknown, key: string): unknown {
  if (typeof node !== 'object' || node === null) {
    return undefined
  }
  for (const [name, value] of Object.entries(node)) {
    if (name === key) {
      return value
    }
  }
  return undefined
}

function chooserString(catalog: unknown, key: string): unknown {
  return readChild([...CHOOSER_PATH].reduce(readChild, catalog), key)
}

describe('AgentResumeChooser locale coverage', () => {
  it('keeps the English source the component falls back to', () => {
    expect(chooserString(en, 'label')).toBe('Choose a session to resume')
    expect(chooserString(en, 'title')).toBe('Which session should this terminal resume?')
    expect(chooserString(en, 'help')).toBe(
      'Press a number or Enter to resume, Esc for a plain shell.'
    )
    expect(chooserString(en, 'dismiss')).toBe('Start a plain shell instead')
  })

  for (const [locale, catalog] of Object.entries(TRANSLATED)) {
    it(`carries every chooser key in ${locale}, translated`, () => {
      for (const key of KEYS) {
        const value = chooserString(catalog, key)
        expect(typeof value).toBe('string')
        expect(value).not.toBe(chooserString(en, key))
      }
    })
  }
})
