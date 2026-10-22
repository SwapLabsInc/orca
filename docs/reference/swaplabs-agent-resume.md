# SwapLabs agent resume after terminal loss

`LOCAL:` the SwapLabs fork keeps a pane's agent resumable when the pane's
terminal is lost, and lets a paired host resume that agent when it re-creates the
pane (fork PR #30). Upstream has no equivalent for a pane without a saved
sleeping record. This page describes the fork's rules as they stand on top of
upstream's agent-status store (`src/main/agent-hooks/server/`), so a sync can
check them against upstream's changes.

## Resume identity after terminal loss

A paired host re-creates a pane after a reboot, a daemon replacement or any
other loss of its terminal, so losing the terminal is not the agent ending. A
teardown removes the pane's live row and every latch, but keeps the row's
provider session as a hidden `providerSessionOnly` remnant. A remnant marked
`resumeAfterTerminalLoss` may be resumed automatically; an unmarked one only by
hand. The mark is persisted and hydrated with the row. The rules live in
`server-retained-identity.ts`, `server-cleanup.ts` and `clearPaneState` in
`server-tab-cleanup.ts`.

| Teardown                                                                                                                                                                             | What the pane keeps                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| PTY teardown (`clearPaneState` with no cause), and `reconcileEndedProcessForPaneKeys` with no options (runtime PTY exit, floating-workspace liveness, a replaced foreground process) | marked remnant                                                   |
| An exit only the owner's process proves: its `SessionEnd` with `other` (how a signalled Claude reports), or a probe that finds it gone (`endedPresence`)                             | marked remnant carrying the ended presence                       |
| Upstream's boot sweep for a PTY that died while Orca was down (`retireRestoredStatusesWithDeadTerminals`, which passes `terminalLost`)                                               | marked remnant                                                   |
| A shell that outlived the agent (the confirmed-shell route: `preserveResumeIdentity` without `endedPresence` or `terminalLost`)                                                      | unmarked remnant                                                 |
| A Claude `SessionEnd` whose reason is `prompt_input_exit`, `logout` or `bypass_permissions_disabled`, read live, from the spool, or from a WSL relay notice (`userEnded`)            | unmarked remnant, with the ended presence of an identified owner |
| A dismissal (`dropStatusEntry`, `dropPersistedStatusEntries`)                                                                                                                        | unmarked remnant                                                 |
| Closing the tab                                                                                                                                                                      | nothing                                                          |
| Upstream's tmux publish and unavailable paths, and OpenCode `statusUnavailable` (`retainIdentity: false`)                                                                            | nothing, as upstream                                             |

More rules:

- A marked remnant drops the terminal handle and the live process presence (a
  proven exit leaves only its ended presence), so no probe retires it. An
  unmarked remnant stays unmarked through later teardowns.
- A user-ended session is retired before the owner's exit hook applies, through
  `reconcileEndedProcessForPaneKeys`, so upstream's persisted exit evidence
  (`checkAgentPresenceSince`) is recorded as for any other proven exit. The exit
  hook that follows finds no owner and is dropped.
- Only the row's own session, route and identified process may end it: a
  `SessionEnd` from another process in the pane (a nested CLI) is ignored, both
  by the local hook server and by the WSL relay before it sends a notice.
- `/clear` needs nothing, because its `SessionStart` replaces the session.
- A remnant's status fields are placeholders. The next event in the pane never
  inherits its agent type, permission hold, verdict, compact ownership or
  terminal: the shared listener and the remote ingest read the stored row
  through `statusRowToComplete` (`src/shared/agent-hook-relay.ts`), and
  `applyNormalizedStatus` masks it the same way.

## Which pane may resume

`selectTerminalLossResume` (`server-terminal-loss-resume.ts`) answers for a pane
the host is re-creating:

- Only a local pane qualifies; an SSH relay can outlive its client.
- A WSL pane qualifies when its row carries `reportsUserEndedSessions`. A WSL
  relay stamps that on every status envelope once it forwards `SessionEnd` as a
  `userEndedSessionId` notice. The notice's payload state is one no host admits,
  so an older host drops it; a row from an older relay cannot prove the user
  kept the agent, so it is never resumed automatically. Envelopes that the
  relay's tmux owner publishes are not stamped, because a tmux-hosted agent
  survives its terminal.
- A structured (native chat) session never qualifies.
- One conversation belongs to one pane: a pane whose terminal still runs it
  keeps it, and otherwise the pane that reported it last does.

## Host resume when a pane is re-created

Upstream resumes a re-created pane from a pane-owned sleeping record
(`materializePendingMobileSessionTerminal`, `resolvePaneOwnedResumeStartup`),
with the recorded launch flags only. That path runs unchanged wherever such a
record exists. The fork's hook-store resume (`host-pane-agent-resume.ts`) runs
only as the fallback when upstream finds no record for the pane, which is the
case on a headless host after a reboot or a daemon loss:

- It launches `claude <settings default args> --resume <id>`. Upstream's
  recorded-recipe rule does not apply here, because the remnant has no recipe;
  aligning the flags is an open follow-up.
- It runs once per session and once per pane; concurrent activations share one
  spawn, and a failed spawn falls back to a plain shell and keeps the identity.
- It suppresses upstream's fresh-agent launch for the tab when the hook store
  has rows for the pane.
- It skips a workspace whose `connectionId` is set. Upstream's managed `orcad`
  SSH hosts project catalogs with `connectionId = null`, so a fork-built `orcad`
  on such a host runs the hook-store resume for its own panes.

## Known gaps

- A marked remnant has no process presence, so upstream's native-chat writer
  check cannot prove its terminal writer exited: "Resume in New Native Chat"
  and chat adoption of that conversation stay refused until the pane is
  re-created.
- When upstream switches on its layout-owner build (`ORCA_LAYOUT_OWNER_IS_MAIN`),
  main keeps resume records from hook status with upstream's clear-on-silence
  rule, and this page must be revisited.
