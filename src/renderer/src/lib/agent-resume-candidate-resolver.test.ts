import { describe, expect, it } from 'vitest'
import {
  AGENT_RESUME_LIFETIME_SLACK_MS,
  AGENT_RESUME_SUBSTANCE_FLOOR_MESSAGES,
  type AgentResumeCandidate,
  type AgentResumeResolution
} from '../../../shared/agent-resume-candidate'
import { RESUMABLE_TUI_AGENTS } from '../../../shared/agent-session-resume'
import {
  resolveAgentResumeCandidate,
  type ResolveAgentResumeCandidateArgs
} from './agent-resume-candidate-resolver'

const WORKTREE = '/srv/repo/worktrees/feature-a'
const HOUR = 60 * 60 * 1000
const T0 = 1_750_000_000_000

function candidate(
  id: string,
  overrides: Partial<AgentResumeCandidate> = {}
): AgentResumeCandidate {
  return {
    agent: 'codex',
    providerSession: { key: 'session_id', id },
    cwd: WORKTREE,
    title: id,
    updatedAt: T0,
    messageCount: 200,
    branch: 'feature-a',
    executionHostId: 'ssh:host-1',
    ...overrides
  }
}

function resolve(overrides: Partial<ResolveAgentResumeCandidateArgs>): AgentResumeResolution {
  return resolveAgentResumeCandidate({
    candidates: [],
    paneAgent: 'codex',
    worktreePath: WORKTREE,
    claimedSessionIds: new Set(),
    ...overrides
  })
}

function summarize(resolution: AgentResumeResolution): string {
  switch (resolution.kind) {
    case 'resume':
      return `resume:${resolution.candidate.providerSession.id}:${resolution.reason}`
    case 'choose':
      return `choose:${resolution.candidates.map((c) => c.providerSession.id).join(',')}`
    case 'none':
      return `none:${resolution.reason}`
  }
}

type Row = { name: string; args: Partial<ResolveAgentResumeCandidateArgs>; expected: string }

const rungs: Row[] = [
  { name: 'rung 1: no candidates at all', args: {}, expected: 'none:no-candidates' },
  {
    name: 'rung 1: every survivor claimed by a live pane',
    args: {
      candidates: [candidate('a'), candidate('b')],
      claimedSessionIds: new Set(['a', 'b'])
    },
    expected: 'none:every-candidate-claimed'
  },
  {
    name: 'rung 1: claimed thin sessions are not "every candidate claimed"',
    args: {
      candidates: [candidate('a', { messageCount: 3 })],
      claimedSessionIds: new Set(['a'])
    },
    expected: 'none:no-candidates'
  },
  {
    name: 'rung 2: sole survivor',
    args: { candidates: [candidate('a')] },
    expected: 'resume:a:sole-candidate'
  },
  {
    name: 'rung 3: tab last-session id matches one survivor',
    args: {
      candidates: [candidate('a', { updatedAt: T0 + HOUR }), candidate('b')],
      tabLastSessionId: 'b'
    },
    expected: 'resume:b:tab-session-match'
  },
  {
    name: 'rung 4: exactly one survivor inside the tab lifetime window',
    args: {
      candidates: [candidate('a', { updatedAt: T0 + 10 * HOUR }), candidate('b')],
      tabCreatedAt: T0 - HOUR,
      tabLastSeenAt: T0 + HOUR
    },
    expected: 'resume:b:lifetime-window'
  },
  {
    name: 'rung 4: slack admits activity just past the window edge',
    args: {
      candidates: [
        candidate('a', { updatedAt: T0 + 10 * HOUR }),
        candidate('b', { updatedAt: T0 + AGENT_RESUME_LIFETIME_SLACK_MS })
      ],
      tabCreatedAt: T0 - HOUR,
      tabLastSeenAt: T0
    },
    expected: 'resume:b:lifetime-window'
  },
  {
    name: 'rung 4: two survivors inside the window fall through to choose',
    args: {
      candidates: [candidate('a', { updatedAt: T0 + 60_000 }), candidate('b')],
      tabCreatedAt: T0 - HOUR,
      tabLastSeenAt: T0 + HOUR
    },
    expected: 'choose:a,b'
  },
  {
    name: 'rung 4 skipped when tabCreatedAt is missing',
    args: {
      candidates: [candidate('a', { updatedAt: T0 + 10 * HOUR }), candidate('b')],
      tabLastSeenAt: T0 + HOUR
    },
    expected: 'choose:a,b'
  },
  {
    name: 'rung 4 skipped when a bound is non-finite',
    args: {
      candidates: [candidate('a', { updatedAt: T0 + 10 * HOUR }), candidate('b')],
      tabCreatedAt: Number.NEGATIVE_INFINITY,
      tabLastSeenAt: T0 + HOUR
    },
    expected: 'choose:a,b'
  },
  {
    name: 'rung 4 skipped when a bound is NaN or negative',
    args: {
      candidates: [candidate('a', { updatedAt: T0 + 10 * HOUR }), candidate('b')],
      tabCreatedAt: -1,
      tabLastSeenAt: Number.NaN
    },
    expected: 'choose:a,b'
  },
  {
    name: 'rung 4 skipped when the window is inverted',
    args: {
      candidates: [candidate('a', { updatedAt: T0 + 10 * HOUR }), candidate('b')],
      tabCreatedAt: T0 + HOUR,
      tabLastSeenAt: T0 - HOUR
    },
    expected: 'choose:a,b'
  },
  {
    name: 'rung 5: survivors ranked newest first',
    args: {
      candidates: [
        candidate('old', { updatedAt: T0 }),
        candidate('new', { updatedAt: T0 + 2 * HOUR }),
        candidate('mid', { updatedAt: T0 + HOUR })
      ]
    },
    expected: 'choose:new,mid,old'
  }
]

const filters: Row[] = [
  {
    name: 'filter: agent mismatch with a known pane agent',
    args: { candidates: [candidate('a', { agent: 'gemini' }), candidate('b')] },
    expected: 'resume:b:sole-candidate'
  },
  {
    name: 'filter: unknown pane agent keeps every agent in play',
    args: { paneAgent: null, candidates: [candidate('a', { agent: 'gemini' }), candidate('b')] },
    expected: 'choose:a,b'
  },
  {
    name: 'filter: cwd must equal the worktree path exactly',
    args: { candidates: [candidate('a', { cwd: `${WORKTREE}/src` }), candidate('b')] },
    expected: 'resume:b:sole-candidate'
  },
  {
    name: 'filter: trailing separator is not an exact match',
    args: { candidates: [candidate('a', { cwd: `${WORKTREE}/` })] },
    expected: 'none:no-candidates'
  },
  {
    name: 'filter: below the substance floor',
    args: {
      candidates: [
        candidate('a', { messageCount: AGENT_RESUME_SUBSTANCE_FLOOR_MESSAGES - 1 }),
        candidate('b', { messageCount: AGENT_RESUME_SUBSTANCE_FLOOR_MESSAGES })
      ]
    },
    expected: 'resume:b:sole-candidate'
  },
  {
    name: 'filter: claimed by another live pane',
    args: { candidates: [candidate('a'), candidate('b')], claimedSessionIds: new Set(['a']) },
    expected: 'resume:b:sole-candidate'
  }
]

const regressions: Row[] = [
  {
    name: 'regression 1: a thin newer diagnostic never outranks a substantial older session',
    args: {
      candidates: [
        candidate('diagnostic', { messageCount: 39, updatedAt: T0 + HOUR }),
        candidate('work', { messageCount: 758, updatedAt: T0 - 5 * HOUR })
      ],
      tabLastSessionId: 'diagnostic',
      tabCreatedAt: T0,
      tabLastSeenAt: T0 + HOUR
    },
    expected: 'resume:work:sole-candidate'
  },
  {
    name: 'regression 2: two substantial candidates with no tab affinity ask the user',
    args: {
      candidates: [
        candidate('a', { messageCount: 758 }),
        candidate('b', { messageCount: 300, updatedAt: T0 - HOUR })
      ]
    },
    expected: 'choose:a,b'
  },
  {
    name: 'regression 3: a claimed id is not revived by tab affinity',
    args: {
      candidates: [candidate('a'), candidate('b'), candidate('c')],
      claimedSessionIds: new Set(['a']),
      tabLastSessionId: 'a',
      tabCreatedAt: T0 - HOUR,
      tabLastSeenAt: T0 + HOUR
    },
    expected: 'choose:b,c'
  },
  {
    name: 'regression 3: a claimed id is not the lifetime-window match',
    args: {
      candidates: [candidate('a'), candidate('b', { updatedAt: T0 + 10 * HOUR })],
      claimedSessionIds: new Set(['a', 'b'])
    },
    expected: 'none:every-candidate-claimed'
  },
  {
    name: 'regression 4: a sibling worktree whose path is a prefix never matches',
    args: {
      worktreePath: `${WORKTREE}-2`,
      candidates: [candidate('sibling', { cwd: WORKTREE })]
    },
    expected: 'none:no-candidates'
  },
  {
    name: 'regression 4: a basename-only match never matches',
    args: { candidates: [candidate('other', { cwd: '/elsewhere/feature-a' })] },
    expected: 'none:no-candidates'
  }
]

const malformed: Row[] = [
  {
    name: 'empty session id is dropped',
    args: { candidates: [candidate('')] },
    expected: 'none:no-candidates'
  },
  {
    name: 'whitespace-padded session id is dropped rather than rewritten',
    args: { candidates: [candidate(' a ')] },
    expected: 'none:no-candidates'
  },
  {
    name: 'unknown agent is dropped even when the pane agent is unknown',
    args: {
      paneAgent: null,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates an untrusted host answer carrying a non-resumable agent.
      candidates: [candidate('a', { agent: 'not-an-agent' as AgentResumeCandidate['agent'] })]
    },
    expected: 'none:no-candidates'
  },
  {
    name: 'empty worktree path matches nothing',
    args: { worktreePath: '', candidates: [candidate('a', { cwd: '' })] },
    expected: 'none:no-candidates'
  },
  {
    name: 'duplicate ids block selection',
    args: { candidates: [candidate('a'), candidate('a', { updatedAt: T0 + HOUR })] },
    expected: 'none:ambiguous'
  },
  {
    name: 'duplicate id reported in a sibling cwd still blocks selection',
    args: { candidates: [candidate('a'), candidate('a', { cwd: '/elsewhere' })] },
    expected: 'none:ambiguous'
  },
  {
    name: 'duplicate id does not let the rival win by default',
    args: { candidates: [candidate('a'), candidate('a'), candidate('b')] },
    expected: 'none:ambiguous'
  },
  {
    name: 'non-finite updatedAt blocks selection',
    args: { candidates: [candidate('a', { updatedAt: Number.NaN }), candidate('b')] },
    expected: 'none:ambiguous'
  },
  {
    name: 'negative updatedAt blocks selection',
    args: { candidates: [candidate('a', { updatedAt: -5 })] },
    expected: 'none:ambiguous'
  },
  {
    name: 'negative messageCount blocks selection',
    args: { candidates: [candidate('a', { messageCount: -1 }), candidate('b')] },
    expected: 'none:ambiguous'
  },
  {
    name: 'non-finite messageCount blocks selection',
    args: { candidates: [candidate('a', { messageCount: Number.POSITIVE_INFINITY })] },
    expected: 'none:ambiguous'
  },
  {
    name: 'malformed evidence on a claimed session is irrelevant',
    args: {
      candidates: [candidate('a', { updatedAt: Number.NaN }), candidate('b')],
      claimedSessionIds: new Set(['a'])
    },
    expected: 'resume:b:sole-candidate'
  },
  {
    name: 'empty tab last-session id is ignored',
    args: {
      candidates: [candidate('a'), candidate('', { messageCount: 500 }), candidate('b')],
      tabLastSessionId: ''
    },
    expected: 'choose:a,b'
  }
]

describe('resolveAgentResumeCandidate', () => {
  it.each([...rungs, ...filters, ...regressions, ...malformed])('$name', ({ args, expected }) => {
    expect(summarize(resolve(args))).toBe(expected)
  })

  it.each(RESUMABLE_TUI_AGENTS)('resolves %s without an agent special case', (agent) => {
    const result = resolve({ paneAgent: agent, candidates: [candidate('a', { agent })] })
    expect(summarize(result)).toBe('resume:a:sole-candidate')
  })

  it('never returns a claimed id from any rung', () => {
    const candidates = [
      candidate('a'),
      candidate('b', { updatedAt: T0 + 10 * HOUR }),
      candidate('c', { updatedAt: T0 + 20 * HOUR })
    ]
    const affinities: Partial<ResolveAgentResumeCandidateArgs>[] = [
      {},
      { tabLastSessionId: 'a' },
      { tabCreatedAt: T0 - HOUR, tabLastSeenAt: T0 + HOUR }
    ]
    for (const affinity of affinities) {
      const result = resolve({ candidates, claimedSessionIds: new Set(['a']), ...affinity })
      const returned =
        result.kind === 'resume'
          ? [result.candidate]
          : result.kind === 'choose'
            ? result.candidates
            : []
      expect(returned.map((c) => c.providerSession.id)).not.toContain('a')
    }
  })

  it('does not mutate the caller candidate order', () => {
    const candidates = [candidate('old'), candidate('new', { updatedAt: T0 + HOUR })]
    resolve({ candidates })
    expect(candidates.map((c) => c.providerSession.id)).toEqual(['old', 'new'])
  })
})
