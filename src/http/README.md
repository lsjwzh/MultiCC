# HTTP Error Boundary

This directory is a pure, unwired boundary for gradually replacing ad hoc HTTP
error shapes in `server.js`.

Flow:

1. Domain code throws `DomainError`; infrastructure code may wrap failures in
   `InfrastructureError`. Neither type owns an HTTP status.
2. `mapError()` converts only branded errors to a trusted `HttpError`. Unknown
   errors, including objects with forged `status` or `statusCode`, become 500.
3. `asyncRoute()` forwards the trusted error to the existing
   `safeErrorHandler`. `HttpError` intentionally exposes compatible
   `status`, `safe`, `code`, and sanitized `message` properties.
4. `presentError()` creates the v1 error DTO. Legacy routes may explicitly opt
   into the fixed compatibility-field whitelist; v1 routes should not.
5. `presentDiagnosticResult()` is only for legacy diagnostic endpoints where
   HTTP 200 plus `{ ok:false }` describes dependency health. It is not a
   substitute for failed-request HTTP statuses.

Suggested wiring order: add characterization tests, migrate leaf diagnostic
routes, migrate isolated controllers, then migrate larger `server.js` route
groups. Keep the terminal `safeErrorHandler` until every route is migrated.

This boundary does not implement authentication, authorization, provider
routing, orchestration, bridge behavior, logging policy, or business rules.
