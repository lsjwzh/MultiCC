# Orchestration SQLite storage

## Decision

MultiCC uses `orchestration.sqlite` as the production authority for waits,
outbox delivery, operations, observed tasks and per-session FIFO schedules.
`better-sqlite3` is already a required runtime dependency and is verified by
opening a real in-memory database during install, update and start.

The old `orchestration.json` backend remains available to isolated unit tests
and as a rollback format. Production never falls back to JSON when a SQLite
file exists: corruption or an unsupported schema fails closed.

## Invariants

1. A state transition and all delivery rows it creates commit in one
   `BEGIN IMMEDIATE` transaction.
2. Outbox sequence allocation and the new outbox row commit together.
3. Reads observe only committed immutable state; mutations and reads retain
   their original strict FIFO ordering.
4. An idle/idempotent mutation does not advance `revision` or write WAL pages.
5. One mutation serializes only changed records, never the complete registry.
6. Database, WAL, SHM and rollback JSON files are private (`0600`).
7. Existing SQLite is authoritative. Stale JSON is never automatically
   imported over it.

## Physical model

The database has separate row stores for:

- `orchestration_waits`
- `orchestration_outbox`
- `orchestration_operations`
- `orchestration_tasks`
- `orchestration_session_schedules`

Each record keeps its reconstructable JSON payload plus bounded indexed
columns used by the domain (`session_id`, state/status, due time, sequence and
update time). `orchestration_meta` owns schema/revision/next-sequence metadata.
`orchestration_extras` preserves legacy extension fields instead of silently
dropping them.

The first implementation retains the service-level `store.mutate(draft)` API.
A copy-on-write proxy reads directly from the frozen in-memory snapshot and
clones only a record on its first write. It then persists the dirty row set in
one SQLite transaction. This removes the giant JSON clone/stringify/write hot
path without forcing a risky simultaneous rewrite of every orchestration
service.

This first phase is not strictly O(1): committing a changed collection still
creates a shallow key map, and some service selectors scan/sort the in-memory
records. The bounded guarantee is narrower and testable: only dirty record
payloads are JSON-serialized and written to SQLite.

## First-start migration

When `orchestration.sqlite` is absent:

1. Read and validate `orchestration.json` with the existing schema migration.
2. Build a temporary database in the same directory.
3. Import every collection in one transaction.
4. Run `PRAGMA quick_check` and compare a canonical digest of the reconstructed
   database state with the source snapshot.
5. Close, chmod and atomically rename the database into place.

Failure before the rename leaves JSON untouched and no partial authority.
After the rename, SQLite is the sole authority. A pre-existing JSON file is
retained but is not consulted again.

## Rollback

Graceful shutdown exports the latest committed SQLite revision to
`orchestration.json` once, outside the hot mutation path. Before deliberately
starting an older build after a crash, run:

```sh
npm run orchestration:export-json
```

The command takes a consistent read transaction and atomically writes a
private JSON snapshot. Do not replace or delete the SQLite file as part of a
normal restart.

## Failure modes and recovery

- Missing/native-incompatible `better-sqlite3`: install/update/start probes it;
  the shell path automatically rebuilds the binding once and otherwise stops
  with an actionable error.
- Corrupt/unsupported SQLite: fail closed; preserve all files for diagnosis.
- Crash before commit: SQLite rolls back every row in the transaction.
- Crash after commit before caller acknowledgement: the store reloads committed
  state; idempotency keys make the retry safe.
- Busy database: a bounded 4-second busy timeout applies. Persistent contention
  is surfaced, not converted into an in-memory success.
- Rollback export failure: SQLite remains authoritative; repair disk/permissions
  and rerun the explicit export before launching old code.

`/metrics` exposes SQLite mutation/no-op/conflict totals, dirty-row and
serialized-byte totals, commit latency, redaction checkpoints and migration
duration. These counters are the rollout signal; the presence of the database
file alone is not evidence that the CPU hot path improved.

## Follow-up phase

Copy-on-write removes full-registry serialization, but existing service code
still performs some `Object.values(...)` scans over the in-memory collections.
Only after production metrics confirm the migration should due-wait claiming,
outbox claiming and status counts move behind SQL-native repository queries
that use the new indexes. That phase must preserve the transaction and FIFO
invariants above.
