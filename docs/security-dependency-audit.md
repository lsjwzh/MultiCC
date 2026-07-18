# Dependency security audit

Last reviewed: 2026-07-18.

Resolved production dependency findings:

- `ws` 8.19.0 → 8.21.1 (direct dependency; fixes memory disclosure and fragmentation DoS advisories).
- `@larksuiteoapi/node-sdk` 1.67.x → 1.71.1, pulling `axios` 1.18.1 instead of 1.13.6.
- `express` 4.18.x → 4.22.2 and `path-to-regexp` 0.1.13.
- `node-telegram-bot-api` 0.66.0 → 1.2.0. The 1.x rewrite uses the built-in
  `fetch` transport and removes the vulnerable
  `@cypress/request-promise → request` dependency chain.
- `multer` 1.4.5-lts.2 → 2.2.0.

`npm audit --omit=dev --json` now reports zero production findings:

```json
{
  "vulnerabilities": {
    "info": 0,
    "low": 0,
    "moderate": 0,
    "high": 0,
    "critical": 0,
    "total": 0
  }
}
```

## Telegram 1.x compatibility boundary

`plugins/bridges/telegram-client-adapter.js` contains the only lazy SDK import.
It accepts both the legacy direct-constructor export and the 1.x CommonJS
`{ TelegramBot, default }` shape. Polling/webhook constructor auto-start is
disabled; listeners are registered before the bridge explicitly starts the
transport, and shutdown awaits the asynchronous stop/close method. MultiCC's
Telegram bridge continues to use polling, while the adapter contract also
tests webhook open/close for migration safety.

No test connects to Telegram or sends a real message. Polling, webhook,
message-event and send contracts use an injected fake SDK; a package smoke test
constructs the installed SDK with auto-start disabled.

Compatibility risk: 1.x replaced the old `request` option surface with native
`fetch` options and returns an object from CommonJS `require`. MultiCC did not
use custom request/proxy options, and the adapter normalizes the export and
lifecycle differences. Deployments that monkey-patched the SDK outside this
bridge are not covered.

## Upload limits and failure mapping

Both upload endpoints use Multer 2 memory storage behind one shared admission
gate. The enforced limits are one file, zero text fields, 25 MiB per file, 100
header pairs, and four active upload requests across chat and voice. Chat
attachments accept explicitly listed document/archive application types plus
text/image/audio/video and `application/octet-stream` for the Flutter arbitrary
file picker. Voice STT accepts audio, WebM, and Ogg only. MIME is client-declared
and is treated as compatibility filtering, not content authenticity.

Persisted chat uploads are written with mode `0600`, collision-safe names and a
shared temporary-storage ceiling of 200 files / 512 MiB. Limit errors map to
stable JSON codes with 400/413/415/429/507 responses instead of reaching the
generic 500 handler.

No audit ignore, forced remediation, or dependency override is used. The final
`qs` advisory was resolved by a normal lockfile refresh to the already-compatible
patched transitive version.
