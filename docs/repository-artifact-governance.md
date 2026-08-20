# Repository artifact and remaining-data governance

Reviewed: 2026-07-18.

## Enforced policy

`npm run governance:artifacts` scans Git-tracked content and rejects newly
tracked APKs, backup files, runtime-state files, raw audit dumps, credential
files/high-confidence credential material, large binaries and sensitive test
fixtures. The scanner reports only category and path; it never prints matched
credential values.

Historical findings are recorded in
`governance/repository-artifact-baseline.json`. The baseline is an explicit debt
ledger, not an allow pattern: only exact reviewed category/path pairs pass.
Adding a similar file under another name fails CI. Removing or migrating an old
finding requires updating the baseline in the same reviewed change, so stale
exceptions cannot accumulate.

`npm run governance:runtime-writes` validates
`governance/runtime-write-inventory.json`. Each remaining path outside
`MULTICC_DATA_DIR`/StateStore must name its owner, classification, rationale,
migration strategy and a live source anchor. A new risky `~/.multicc`, package-
root config/memory or legacy cron root fails unless it is classified.

Both checks run inside `test:deterministic` on Node 20 and 22 in CI.

## Existing repository artifacts: migration strategy

The APK migration is complete; the remaining entries below retain their own
separate migration plans.

- `public/multicc.apk`: resolved by an explicit on-demand local build from the
  `/manage` APK controls or `./multicc apk`. Install/update never build it. The
  APK and metadata sidecars are ignored, `scripts/publish-apk.sh` publishes
  atomically, and repository governance rejects any future tracked APK.
- `server.js.bak.task*`: compare each file with reachable Git history and any
  active recovery tooling. Archive unique recovery evidence outside Git, then
  remove all backups in one owner-approved cleanup.
- `.arch-review-findings.json` and `classify-test-cases.json`: convert durable
  conclusions into Markdown or small curated fixtures; move raw diagnostic
  output to ephemeral CI artifacts with retention limits.
- `whisper_vocab.json`: copy forward to the existing data-root vocabulary file,
  retain a read-only compatibility import for one release, then untrack it.
- `public/agent-presets.json`: the high-confidence credential signature is
  baseline-only pending history-aware secret review. If it is a real secret,
  revoke/rotate first; if it is generated example text, sanitize the generator
  and regenerate before removing the exception.

## Runtime-data migration in this phase

New artifact and detached-job writes now use `createPaths()` under
`MULTICC_DATA_DIR`, private directory/file modes and atomic metadata writes.
Artifacts inject `MULTICC_ARTIFACTS_DIR` for bundled child tools. Old artifact
and detached directories remain read-only fallbacks so existing links and job
status survive the transition; they are not automatically deleted or rewritten.

Large ASR models, upstream CLI transcripts/skills, repository safety backups,
gateway workspaces, provider CODEX_HOME materializations, package-root `.env`
and the legacy memory tree remain governed by the machine inventory. Their
ownership or rollback requirements make an automatic move unsafe.
