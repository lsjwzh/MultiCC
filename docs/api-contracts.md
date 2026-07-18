# MultiCC API contracts

MultiCC's bounded HTTP and WebSocket contract is versioned as `v1`. The runtime
constant is `API_VERSION` in `src/api-contract.js`; the machine-readable source
is `contracts/v1/openapi.json`, with JSON Schema 2020-12 documents under
`contracts/v1/schemas/`.

## Bounded v1 surface

The initial v1 endpoints are:

- `GET /api/v1/sessions`
- `GET /api/v1/sessions/{id}`
- `GET /api/v1/providers`
- `GET /api/v1/sessions/{id}/waits`
- `POST /api/v1/sessions/{id}/dispatch`

The unversioned endpoints remain available during migration. They are legacy
compatibility surfaces, not templates for new integrations. New consumers
should use `/api/v1` and validate responses against the published schemas.

`src/session-dto.js` is the canonical session serializer. It deliberately does
not expose native CLI session ids, filesystem paths, worktree paths, prompts,
memory, credentials, command output, stack traces, or process objects. Provider
DTOs report only a `hasCredentials` boolean. Wait DTOs expose lifecycle status
but never callback tokens, callback URLs, polling commands, match strings, or
working directories. Registration endpoints may return a one-time callback
secret to the caller that created it; that operational response must not be
stored in status DTOs, logs, snapshots, or WebSocket events.

Pure query, workspace, history and status-transition services now live under
`src/session/`; see `docs/session-domain-boundaries.md`. They use injected ports
and are intentionally not connected to the host yet. Until the compatibility
switch is reviewed, `server.js` remains the active implementation for the v1
routes and workspace/chat WebSocket paths; the new services are the tested
target boundary, not a second runtime writer.

## Errors, request ids, and correlation ids

Every request receives `X-Multicc-Request-Id`, `X-Correlation-Id`, and
`X-Multicc-API-Version` response headers. A caller may supply valid
`X-Request-Id` and `X-Correlation-Id` values. v1 success responses include
`apiVersion`, `requestId`, and `correlationId`; errors use the shared shape:

```json
{
  "apiVersion": "v1",
  "requestId": "request-1",
  "correlationId": "correlation-1",
  "ok": false,
  "error": "request_error",
  "code": "invalid_request"
}
```

Error bodies are bounded and redact credential-like values and absolute paths.
Tokens, paths, command stderr, and stacks belong only in appropriately redacted
server-side diagnostics, never in public DTOs.

WebSocket messages retain their existing top-level `type` and event fields and
add `apiVersion: "v1"`. This additive envelope allows existing clients to keep
working while version-aware clients reject unsupported major versions.

## Compatibility policy

Within v1, the following changes are compatible:

- adding a new endpoint;
- adding an optional response property;
- adding an optional request property with unchanged semantics;
- documenting a previously unspecified behavior without changing wire data.

Removing or renaming a field, adding a required field, narrowing an accepted
type, removing an enum value, changing a constant, or changing field semantics
is breaking and requires a new API version. The checked-in
`compatibility-baseline.json` prevents those schema breaks. Golden examples
protect representative HTTP and WebSocket payloads. Legacy routes may be
deprecated only after their consumers have migrated and a documented support
window has elapsed.

## Deterministic and live tests

`npm run test:contracts` validates every schema, all OpenAPI references, golden
payloads, DTO redaction boundaries, and backward compatibility. It has no
network, native process, real repository, or AI dependency and runs in CI on
Node 20 and 22. `npm test` combines deterministic suites, contract validation,
and native dependency smoke checks.

Live AI and manual integration checks are intentionally separate (`test:live`,
`test:classify-live`, and other explicitly named live scripts). CI must not run
them, delete real state, or depend on local credentials.
