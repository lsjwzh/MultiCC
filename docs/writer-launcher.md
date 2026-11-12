# multicc-writer — fail-closed writer-lease launcher

Rust owns writer registration for every workspace checkout (the
`workspace:writer-leases` records and the `workspace:writer-fence` in the
task-shell SQLite store). Every host spawn path acquires its lease through the
native addon **before** the child is launched and releases it only after the
child's whole process group is gone. CLIs started outside the repo — custom
entrypoints, CI fixtures, docker lab tools — cannot call the addon, so they
must be wrapped by the `multicc-writer` binary instead. An unwrapped writer is
a structural bug: the drain fence aborts any workspace release while a writer
lease is active, and a writer that never registered can never hold that fence.

## Usage

```
multicc-writer exec -- <command> [args...]
```

Environment contract (fail closed: a missing or invalid variable refuses the
launch before the child exists):

| Variable | Meaning |
| --- | --- |
| `MULTICC_TASK_STORE` | Path to the task-shell SQLite database (`task-shells.sqlite` under the data dir). |
| `MULTICC_WRITER_FENCE` | JSON of the ACTIVE workspace lease identity: `{"workspaceId","leaseId","epoch","generation","sessionId"}`. Read it from the `workspace:lease` row of the workspace you are about to write; a stale identity refuses with exit 75. |
| `MULTICC_WRITER_KIND` | `session` \| `background` \| `stream` — the same taxonomy the host uses. |
| `MULTICC_WRITER_ID` | Optional stable writer id (alphanumeric plus `_ . : -`, ≤160 chars). Default: random. |

Exit codes: `64` usage/env error, `66` store unreadable, `75` lease refused
(`workspace_lease_stale`, `writer_lease_id_reused`, …), `126` spawn failure,
otherwise the child's own exit status (`128+signal` on signal death).

## Semantics

1. **Acquire before launch.** The writer lease row is inserted in the same
   transaction that validates the fence identity against the current
   `workspace:lease`. The child is spawned only after that commit; the
   write-before-registration window does not exist.
2. **Process-group lifetime release (POSIX).** The child becomes a process
   group leader (`process_group(0)`), signals arriving at the launcher are
   forwarded to the group, and the lease is released only when
   `kill(-pgid, 0)` reports the group empty — background descendants the CLI
   spawns without telling anyone keep the lease held. On Windows the group
   probe degrades to the direct child's exit; document any entrypoint that
   depends on detached grandchildren as POSIX-only.
3. **Crash recovery.** The child's pid is annotated onto the lease right after
   spawn (exactly once; a repoint is refused as `writer_lease_stale`). The
   host's per-second reaper releases leases whose recorded pid and process
   group are both provably dead, so a killed launcher cannot wedge a
   workspace. A launcher that cannot release cleanly says so on stderr and
   still exits with the child's status — the reaper owns the leftovers.

## Where it is wired

- `native/writer-launcher/` — the crate (workspace member, so
  `cargo build --workspace` / `cargo test --workspace` cover it).
- `native/core/tests/writer_leases.rs` — store-level races: external writer
  before the notification, release racing acquisition, annotate-once.
- `tests/test-writer-launcher.js` — host-side end-to-end contract (also in
  `npm run test:rust`); locates the binary via `MULTICC_WRITER_BIN`,
  `native/prebuilt/<platform>/`, then `native/target/{release,debug}/`.
- `docker/task-shell/Dockerfile` (regression stage) stages the binary next to
  the other kernels and `docker/task-shell/run-tests.js` runs the suite, so
  the Docker release gate fails if the launcher regresses.

## Out of scope (idle-state spawn paths)

The interactive tmux terminal (`server.js`), `tui-mirror`, the detached
runner, `secret-tools` and the wait injector spawn processes while the
workspace holds no turn permit and no writer identity exists to lease under.
Leasing them requires a workspace-level (not turn-level) lease ownership
design and is tracked as a follow-up; they must not be wrapped ad hoc.
