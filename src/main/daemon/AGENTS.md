# AGENTS.md — Terminal Daemon

## Endpoint Ownership: Who May Touch the Socket Path

Two invariants govern the daemon's canonical socket path. Read this before changing anything that
links, renames, unlinks or stats it — or that treats its existence as evidence a daemon is running.

> **Only a daemon publishing itself onto the canonical endpoint may mutate that directory entry,
> and only by replacing an entry it has itself just proven dead.**
>
> **No actor removes a name it did not create.**

**Why it exists.** `net.Server.close()` unlinks the pathname it bound with no ownership check, so a
departing daemon deleted whichever socket then sat at the canonical path — including a live
replacement's. The replacement stayed alive hosting PTYs no client could reach, which reads to the
user as terminals that accept keystrokes and never run them. Seven review rounds against the older
"launcher reclaims a dead process's name" shape produced twenty-three defects, all the same
interleaving: a third party observing liveness at T and acting on the directory entry at T+1.

**The protocol** (`daemon-endpoint-ownership.ts`): bind a private `.p<hex>` name → try an exclusive
`link` → on `EEXIST` prove the incumbent dead by connecting → re-check the entry hasn't changed
hands → probe once more → `rename` in one syscall → verify we kept it.

## Traps That Already Cost Us

- **Never collapse "can't tell" into "dead."** Only `connected` means occupied; only
  `refused`/`missing` prove death. A timeout or `EPERM` proves nothing and must decline — treating
  it as death deletes an endpoint still serving every terminal on the host.
- **`link` first, never an unconditional `rename`.** `rename` replaces whatever it finds, so it
  would let a starting daemon destroy a healthy one. `link` fails loudly and forces the liveness
  question.
- **`rename`, never `unlink`-then-`link`.** The latter leaves the name absent between two calls;
  measured across a live handover it gapped on essentially every observation, where `rename` gapped
  on none in ~14,500 probes.
- **Do not identify an entry by `birthtimeMs`.** Node documents it as sometimes holding the ctime,
  filesystems without a birth time report the epoch, and its granularity is often coarser than the
  events it must separate. Three attempts to patch around this produced three more defects; inode
  recycling is now settled by asking whether anything is _serving_.
- **Do not add a sweeper.** Deciding whether someone else's leftover is safe to delete is the
  question this design retired; the last one produced five defects, including deleting a live
  listener's only pathname. Every actor removes its own scratch name on each non-crash path.
- **Scratch namespaces must stay out of released builds' patterns.** Shipped versions sweep
  `^\.b[0-9a-f]{10}$` on age alone with no liveness check, which is why the bind name is `.p`.
  Deleting our sweeper does not un-ship theirs.
- **Never remove the endpoint on shutdown.** A departing daemon leaves a dead entry; the next
  publisher replaces it in one rename.

**Residual risk.** The final probe and the `rename` are two syscalls, and POSIX has no
rename-if-target-is-inode-X. The harm is separately unreachable: a daemon never creates a session
on an endpoint it no longer holds (`daemon-server.ts`), and it drains rather than serving on.

## Draining a Stale Daemon (fork, off by default)

`ORCA_DAEMON_DRAIN_STALE_BUNDLE=1` (`daemon-drain.ts`) lets a daemon launched from an older app
bundle keep its live sessions while a fresh daemon serves new terminals. Without it, such a daemon
is preserved until it owns no session, so a host that is never idle never runs new daemon code.

It is the one sanctioned exception to "only replace an entry proven dead", and it is narrow:

- **The app never touches the canonical name.** It gives the verified, stale incumbent a second,
  app-owned name (`drain-v<N>-<hex>.sock`, by `link`), copies its token, and moves its PID record
  there. Then it launches the fresh daemon with `--handed-over-endpoint <dev>:<ino>`.
- **Only the publishing daemon replaces the live entry**, only while it is still that exact inode,
  and still in one `rename`. The drain link holds the inode, so the number cannot be recycled.
- **The incumbent drains itself.** Its ownership watch sees the name lost; it refuses to create,
  still attaches (`attachOnly`), and retires once its last session ends. The router only ever
  attaches to a draining adapter, and creates on the current daemon once the session is gone.
- **Drain names are the app's own and never reused.** Daemon init finds them beside the legacy
  protocol endpoints, and removes a slot only when nothing serves it and its process is dead.
- **First launch only.** Daemon init discovers drained daemons once; a respawn under a live router
  would strand every session left on a daemon drained beneath it.
- **Undo while nothing changed.** If the fresh daemon never takes the name, the launcher puts the
  PID record back and removes the drain names, but only while the incumbent still holds the name.
  A launch killed mid-drain leaves a slot aliasing the canonical inode: every launch undoes such a
  slot first, and discovery never registers a name aliasing one it already has.
