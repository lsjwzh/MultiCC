# Codex subagent provider routing

MultiCC routes Codex parent and child threads through separate provider/model
configurations while keeping Codex's native `spawn_agent` orchestration.

## Runtime structure

1. `src/providers.js` resolves MultiCC providers and delegates `CODEX_HOME`
   materialization to `cli-provider-router`.
2. A proxyable main provider is rewritten to
   `/codex-proxy/:providerId/:sessionId/main/responses`.
3. `default`, `worker`, and `explorer` agent TOMLs select the injected
   `multicc_subagent` model provider, which points to the same endpoint with the
   `sub` role and the selected child provider.
4. `cli-provider-router` resolves the provider into one of three isolated wire
   paths: direct Responses, Responses compatibility, or Chat-to-Responses.
5. Every completed upstream response reports normalized usage to the shared role
   tracker. OpenAI cached input is split from fresh input before accounting.

The package owns protocol conversion, route preparation, auth materialization and
usage normalization. MultiCC owns session state, provider CRUD, current-turn reset,
persistent token ledgers, WebSocket updates and official-main aggregate reconciliation.

An official/OpenAI subscription parent stays direct. Its main usage is the
positive remainder of Codex's aggregate turn usage after proxy-observed child
usage is removed. Official providers are not selectable as child routes because
they do not expose standalone HTTP credentials.

Project-scoped custom agents can override the generated built-in role files. To
participate in MultiCC routing, such agents must inherit or select the injected
`multicc_subagent` model provider.

## Protocol requirement

The parent model must support the Responses API tool-search protocol used by
Codex's deferred `multi_agent_v1` namespace. A Chat Completions-only provider
can be used as the routed child, because MultiCC converts that child's ordinary
function/text stream back to Responses events, but it cannot be the parent that
discovers and invokes `spawn_agent`. This is a protocol capability boundary,
not a CLI/provider-name restriction.

## Tests

```sh
npm run test:codex-subagent-routing
MULTICC_LIVE_SESSION=<codex-chat-session> npm run test:codex-subagent-live
```

The offline suite uses separate mock Responses and Chat upstreams. The live test
requires a Codex chat session whose main and subagent providers differ; it checks
the native Agent event and both runtime and persistent token buckets.
