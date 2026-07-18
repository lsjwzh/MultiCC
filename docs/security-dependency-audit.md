# Dependency security audit

Last reviewed: 2026-07-18.

Safe, same-major upgrades applied:

- `ws` 8.19.0 → 8.21.1 (direct dependency; fixes memory disclosure and fragmentation DoS advisories).
- `@larksuiteoapi/node-sdk` 1.67.x → 1.71.1, pulling `axios` 1.18.1 instead of 1.13.6.
- `express` 4.18.x → 4.22.2 and `path-to-regexp` 0.1.13.

`npm audit --omit=dev` still reports 9 findings (2 critical, 7 moderate). They are all in the legacy chain below:

```text
node-telegram-bot-api 0.66
  → @cypress/request-promise
    → request 2.88.2
      → form-data / qs / tough-cookie / uuid
```

The registry's proposed remediation is `node-telegram-bot-api` 1.2.0, a major upgrade. It was deliberately not applied without a Telegram bridge compatibility migration and live Bot API test. The dependency is isolated to `plugins/bridges/telegram-bridge.js`, loaded lazily only when that bridge starts; no other HTTP/provider path imports `request`.

Follow-up: migrate the Telegram bridge in its own change, exercise polling/start/stop/send/reconnect against a test bot, then upgrade to 1.x and remove this exception. Do not use `npm audit fix --force` as a substitute for that validation.
