# API error policy

MultiCC classifies provider failures once at the owned turn boundary. Provider
adapters preserve structured status, code, headers and request identifiers;
`src/chat/api-error-policy.js` normalizes them, decides the action, and emits
sanitized structured logs and metrics. `src/chat/api-error-host.js` persists the
safe decision, broadcasts it, schedules an owned-turn retry when allowed, and
owns network hold/recovery. Classify state `E` is display-only and cannot start
a second retry loop.

## Production evidence snapshot

The fixture at `tests/fixtures/api-errors-sanitized.json` was derived from
MultiCC server logs and persisted assistant error events for
2026-06-24–2026-07-24. Counts are occurrences, including historical retries,
not unique incidents.

| Provider | Reliable observed evidence | Occurrences |
| --- | --- | ---: |
| Claude | 403 permission | 92 |
| Claude | 429 rate limit | 10 |
| Claude | 503 unavailable | 24 |
| Claude | 529 overload | 4 |
| Codex | 400 invalid request | 1 |
| Codex | 429 rate limit | 2 |
| Codex | 502 gateway | 1 |
| Codex | 529 overload | 3 |
| OpenCode | provider error without reliable status/code | 27 |
| Qoder | Configured, but no reliably attributable upstream error sample | 0 |
| ZCode | No configured session in the sampled state | 0 |

The fixture contains no credentials, account identifiers, filesystem paths,
user task text, or request bodies. Providers without reliable samples keep the
generic structured adapter path; no provider-specific mapping was invented.

## Decision matrix

| Normalized category | Previous behavior | Policy |
| --- | --- | --- |
| Authentication / permission | Could enter the same immediate classify retry loop | Fail fast; request login, credential, scope, or permission repair |
| Billing / quota | Could retry like a transient failure | No short retry; expose a trustworthy reset and probe only after it |
| Rate limit | Immediate retry ignored server timing | Honor `Retry-After`/reset; otherwise bounded exponential backoff with jitter |
| Provider 5xx / overload | Immediate, uncapped retry and broad global health poisoning | At most two safe pre-output attempts; provider circuit/cooldown |
| Network / DNS / TLS / reset | Shared text matching and global hold | At most two safe attempts; only this category influences the legacy global network hold |
| Timeout | Undifferentiated retry | Connect/pre-token may retry once; partial output or side effects fail safely |
| Invalid request / model | Could fall through to a fresh-session retry | Fail fast; repair input/model/provider configuration |
| Context / token limit | Same request could be repeated | Fail fast; compress, trim, or start a new session |
| Tool / protocol | Could replay the whole turn | Fail fast; repair tool arguments/schema/protocol |
| Cancellation / shutdown | Could be mistaken for an interruption | Never retry |
| Adapter / configuration | Could be treated as provider unavailability | Fail fast and mark Aux non-retryable |
| Unknown | Historically unbounded through classify `E` | At most one safe controlled attempt, then fail |

Retries retain the existing canonical user message and runner-owned turn. A
retry timer is cancelled on shutdown, deletion, a new user message, or runner
supersession. A turn with partial output or a non-thinking tool call is never
automatically replayed.

## Structured observability

Decision logs expose only category, provider, code, HTTP status, phase,
partial/side-effect flags, action, reason, delay, attempt budget, session/turn
identifier, and a hashed request identifier. Metrics use the
`multicc_api_error_*` namespace for category/provider/action, retry attempts,
success, exhaustion, fail-fast, recovery, and circuit-open totals.
