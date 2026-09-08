# CLI completion contract

Each adapter creates a tracker per runner. `observe(raw, decoded)` collects native
evidence. `finish(boundary)` combines it with process exit or persistent-send
settlement and returns a frozen version 1 outcome:

- `state`: `completed`, `failed`, `cancelled`, or `unknown`.
- `reason`, `source`: bounded diagnostic metadata.
- `settled: true`: present only after the execution boundary.

The host commits a final answer only after completion and checks persistence
separately. Upstream errors and provider error envelopes still veto success.
Only a structured downstream disconnect can be reconciled, after the **same
runner** completes and saves its answer. An output marker, idle process, or zero
exit alone is insufficient for adapters with native evidence. A rejected send
cannot be repaired by an earlier success-looking result. Aux classification
does not participate in this protocol decision.

## Source evidence reviewed on 2026-09-08

| CLI | Evidence | Adapter rule |
| --- | --- | --- |
| Codex 0.153.4 | `openai/codex`, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`; exec JSONL maps app-server turn status to `turn.completed` / `turn.failed` | Require `turn.completed` without terminal error and clean execution settlement; transient errors may recover |
| OpenCode 1.18.2 | `anomalyco/opencode`, commit `70b56a0a93d366889cae950379cc9d2537148fa2`; prompt loop continues after tool steps; run command tracks errors separately from idle | Require a final tool-free step with `reason=stop`, no pending tools/errors, and exit 0 |
| dsh 0.1.1-rc.2 | Installed `@deepseek-ai/dsh-agent-loop/lib/index.js` and `@deepseek-ai/dsh-headless/lib/index.js`, readable JavaScript | Capture starting sequence, wait for idle, flush, inspect this turn's `turn/end.reason.kind`; only `completed` succeeds |
| Claude 2.1.251 | Installed Mach-O executable, embedded SDK schema and result builder inspected | Main result only; explicit `subtype=success` and `is_error=false`; terminal reason must be completed when present; absent reason is permitted for local slash commands |
| Qoder | Installed `qoderclicn`, embedded `buildResultSuccess` / `buildResultError` inspected | Success subtype alone is insufficient: auth/API failure can have `is_error=true`; native builder omits terminal reason |
| CodeBuddy 2.143.0 | Installed `@tencent-ai/codebuddy-code/dist/codebuddy-headless.js`, readable bundled result builder | Explicit success/non-error result; provider error or incomplete status builds an error result; terminal reason omitted |
| Kimi Code 0.32.0 | Official npm `@moonshot-ai/kimi-code` package, `dist/main.mjs`: `runNativeTurn`, `runV2Print`, `writeResumeHint` | Native runner accepts only `result.type=completed` before writing resume hint; hint plus exit 0 and no pending tools/errors required, because cleanup can still fail |
| ZCode | Installed `ZCode.app/Contents/Resources/glm/zcode.cjs`, `runPrompt` / EventReducer inspected; `TurnComplete` sets idle and `TurnError` sets error | After awaited submit, native JSON must have a real session ID, string response and idle projection without errors; bridge no longer invents `stop` for arbitrary parsed output; exit 0 also required |

Public source anchors:

- [Codex terminal JSONL mapping](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L506)
- [Codex terminal error semantics](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/protocol/src/protocol.rs#L2141)
- [Codex rejects EOF before response completion](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/session/turn.rs#L2330)
- [OpenCode agent loop](https://github.com/anomalyco/opencode/blob/70b56a0a93d366889cae950379cc9d2537148fa2/packages/opencode/src/session/prompt.ts#L1103)
- [OpenCode CLI exit/error handling](https://github.com/anomalyco/opencode/blob/70b56a0a93d366889cae950379cc9d2537148fa2/packages/opencode/src/cli/cmd/run.ts#L776)

All eight currently registered CLIs have explicit policies. The generic exit
fallback is reserved for adapters without a native completion factory: it needs
exit 0, nonempty assistant output, no decoded errors, and no pending tools.
It is not used to reinterpret unknown native terminal reasons as success.

Regression traces include historical Claude `success + api_error`, Qoder-style
success without terminal reason, tool steps ending with stop, post-result exit
failure, rejected persistent send after a durable result, and child/background
results inside the same persistent process. No credentials or full private
transcripts are included in fixtures.
