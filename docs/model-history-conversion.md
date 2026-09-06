# Model history conversion and upstream errors

MultiCC keeps each CLI's native transcript. Cross-CLI handoff transfers a bounded
visible-text checkpoint, not another CLI's raw tool records. A single native
Codex thread can nevertheless contain records from multiple model providers.

`src/model-history-converter.js` owns Responses request preprocessing. It runs
before the official OAuth relay and before falling through to the CPR proxy,
including its Responses-to-Chat-Completions bridge. It never edits the native
transcript, renames executable tools, changes call IDs, or replays tools itself.

## Inventory and conversion rules

A read-only structural inventory on 2026-09-06 covered 145 Codex transcripts
(78,197 JSONL records) and 501 Claude transcripts (184,103 records). Only type,
field-shape and ID-prefix counts were collected, not message or argument text.
Four Claude lines could not be parsed and were counted rather than rewritten.
Counts are a diagnostic snapshot, not a runtime allowlist.

| Native shape | Observed identifier | Treatment at the Responses request boundary |
| --- | --- | --- |
| `message` | `msg_…` | Preserve content, role and phase; normalize incompatible item IDs |
| `function_call` | `fc_…`, two `tool_…` records | Generate a deterministic `fc_…` item ID when incompatible; preserve `call_id`, name and namespace; serialize object arguments, preserve string arguments verbatim |
| `function_call_output` | `fco_…` | Normalize incompatible item ID; preserve output and `call_id` |
| `custom_tool_call` / output | `ctc_…` / `ctco_…` | Normalize incompatible item ID; preserve free-form input, multimodal output and `call_id` |
| `reasoning` | `rs_…` | Preserve as opaque data, including encrypted content |
| `agent_message` | `amsg_…` | Preserve as native data; no guessed translation |
| `item_reference` | References a record | Update a local reference alongside a converted ID; leave ambiguous references for explicit diagnosis |
| Claude `tool_use` / `tool_result` | `call_…`, `toolu_…`, `tool_…`, tool-name prefixes | These IDs correlate calls with results. Do not apply Responses item-ID rules or transplant the records into another native session |
| Claude `thinking`, `text`, `server_tool_use` | Native fields | Retain the native CLI/protocol handling |
| Unknown future types | Unknown | Preserve and surface an upstream rejection; do not silently drop |

The optional Responses item `id` and the semantic `call_id` are separate. CPR's
current Chat-to-Responses stream converter may conflate them. Normalizing the
request boundary repairs old and newly saved foreign item IDs without patching
installed dependency files. Known valid IDs and all original disk bytes remain
unchanged. Generated IDs are stable for repeated identical requests; occupied
IDs and local references are accounted for.

## Rejection-driven fallback

Only an HTTP 400 received before a successful response stream can trigger one
additional request. The upstream must identify a specific rejected parameter.
The converter can omit an explicitly rejected optional item `id`, `status` or
`internal_chat_message_metadata_passthrough`, or an unsupported function-tool
`strict`, `defer_loading` or `cache_control` field. An ID with a live item reference
is not omitted. The fallback is request-local, not a learned global deletion rule.

Calls, results, tool definitions, names, arguments, schemas and reasoning are
never deleted as a blanket error-recovery tactic. Unknown/semantic errors,
authentication/rate-limit/server failures and errors after streaming starts are
reported rather than retried by this converter. Subsequent schema rejections
are also reported; there is no unbounded trial-and-error loop.

`model_history_preprocessed` and `model_history_repaired_after_rejection` log
the affected paths, types and rules. No history text, arguments or raw IDs are
logged by the converter.

## Error propagation

`src/upstream-error.js` reads bounded error bodies, preserves the upstream
`message`, `type`, `code`, `param` and request ID, and redacts credentials. It
also unwraps JSON embedded in CLI HTTP error sentences before presentation
truncation. The OAuth relay retains its outer compatibility code but no longer
replaces the original error with a generic sentence. The final error after a
fallback retains the preceding error and the list of applied field changes.

The Codex decoder and shared API error policy use the underlying diagnostic.
Persisted/broadcast `rootCause` retains up to 2,048 sanitized characters, with
`param` available separately; compact summary messages remain bounded at 240.
Network exceptions include their nested cause. HTTP 200 streams containing
`response.failed` are recorded as failed requests and never replayed by the
converter. Restart MultiCC manually after upgrading to activate these modules.
