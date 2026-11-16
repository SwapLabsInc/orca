import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from '../../db/messages/mailbox-routing-page'
import {
  LIVENESS_ONLY_POINTER_TYPES,
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'

const MAILBOX = 'dispatch:d1'

function waiters(...filters: (string[] | undefined)[]): ReadonlySet<OrchestrationMessageWaiter> {
  return new Set(filters.map((typeFilter) => ({ typeFilter })))
}

describe('selectOrchestrationPointerBatch', () => {
  // A full page of heartbeats must not hide a newer report that still warrants the pointer.
  it.each([
    ['a few heartbeats alone', 2, null, 0],
    ['heartbeats behind a filtered report', 2, 'question', 0],
    ['heartbeats with a report', 2, 'status', 3],
    [
      'a full page of heartbeats ahead of a report',
      ORCHESTRATION_DELIVERY_BATCH_LIMIT,
      'status',
      50
    ]
  ] as const)('selects silent mail only beside other mail: %s', (_l, beats, other, expected) => {
    const db = new OrchestrationDb(':memory:')
    try {
      const heartbeat = { runId: 'run_legacy_local', from: 'w', to: MAILBOX, subject: 'alive' }
      db.insertMessages(Array.from({ length: beats }, () => ({ ...heartbeat, type: 'heartbeat' })))
      // Inserts now store heartbeats handled; rows stored before that are still unread mail.
      db.db
        .prepare("UPDATE messages SET read = 0, delivered_at = NULL WHERE type = 'heartbeat'")
        .run()
      if (other) {
        db.insertMessage({ ...heartbeat, subject: 'report', type: other })
      }
      const batch = selectOrchestrationPointerBatch({
        db,
        mailboxHandle: MAILBOX,
        waiters: waiters(['question']),
        reservedTypes: undefined,
        silentTypes: LIVENESS_ONLY_POINTER_TYPES
      })
      expect(batch.messages).toHaveLength(expected)
      expect(db.getUndeliveredUnreadMessages(MAILBOX)).toHaveLength(beats + (other ? 1 : 0))
    } finally {
      db.close()
    }
  })
})
