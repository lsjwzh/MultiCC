# Changelog

All notable changes to MultiCC are documented in this file.

## v1.6.4 — Automatic provider failover and interactive external Fleets

### Highlights

- **Safe automatic provider failover** — when a provider attempt fails on a retryable upstream condition, MultiCC now falls back to the next healthy candidate instead of surfacing the failure. Each failover attempt is bound to its own candidate model, so a retry never inherits the previous candidate's model and lands on a mismatched endpoint.
- **Fenced provider attempts** — every turn resolves a concrete provider attempt behind an explicit fence, giving each attempt its own routing token, home directory and proxy policy. Attribution and quota accounting stay correct across retries and failovers.
- **Fully interactive imported Fleets** — an imported external Fleet is no longer a read-only card. Its sessions can be opened and driven, and the memo and Git views are reused for external Fleets so remote work is inspected with the same surfaces as local work.
- **Installable Android release artifact** — the signed Android package advances to `2.29.10+122`, so it can upgrade the prior stable APK instead of being rejected as the same Android version.

### Fixes

- **Provider-producer and persisted-delivery wedge (P0 x3)** — cancelling a proxied turn could leave the in-memory producer count undrained, wedging every later attempt of that session on `PROVIDER_PRODUCER_NOT_DRAINED` until a server restart, while the outbox retry blindly acknowledged a persisted-but-never-executed message. Cancel now force-releases the session's main producer accounting, an orphaned producer is force-drained past a stale grace with a `provider_producer_force_drained` audit event, and a per-delivery handoff probe keeps "persisted" from being mistaken for "delivered".
- **Active agents self-sync their worktrees** — an agent working in its own worktree can align with the base branch without waiting for an external sync that skips active sessions.
- **Official Android signer validation** — the release pipeline verifies the APK against the pinned official signing key, surfaces the actual signer digest on mismatch, and parses `apksigner` output across build-tools 36 and 37 formats.

### Compatibility

- No API or data-format changes. Existing provider configurations, relay shares and imported Fleets keep working without migration.

## v1.6.3 — Secure LAN access, Official OAuth relay, and cross-instance Fleet sharing

### Highlights

- **Password-gated LAN access by default** — normal installations now listen on the IPv4 LAN automatically when the installer-generated `ACCESS_TOKEN` is present. Direct HTTP and WebSocket peers are limited to private, loopback, and Tailscale networks; public access still goes through Tailscale Funnel or another explicitly configured reverse proxy.
- **Reliable LAN address discovery** — MultiCC prefers physical Wi-Fi/Ethernet addresses, filters VPN, Docker, bridge, and Tailscale virtual adapters, and reports every usable LAN URL instead of advertising the first arbitrary interface.
- **Actionable installation diagnostics** — the installer reports when LAN binding is explicitly disabled or no physical IPv4 adapter is available, and points to host-firewall and Wi-Fi client-isolation checks when the service is listening but another device still cannot connect.
- **Official Codex OAuth relay** — relay sharing can use the host's current ChatGPT/Codex OAuth session without exporting access or refresh tokens. The host owns token refresh, account selection, upstream requests, and fail-closed login-expiry handling.
- **Cross-instance Fleet sharing** — one instance can issue a password-protected, bounded share capability for a Fleet, and another MultiCC instance imports it as a read-only metadata snapshot over loopback or the LAN. Imported Fleets never enter local directories or the Git/worktree lifecycle.
- **Installable Android release artifact** — the signed Android package advances to `2.29.9+121`, so it can upgrade the prior stable APK instead of being rejected as the same Android version.

### Security and compatibility

- Explicit `HOST` / `MULTICC_ALLOW_REMOTE` settings remain authoritative; `HOST=127.0.0.1` or `MULTICC_ALLOW_REMOTE=0` keeps a loopback-only installation.
- Existing API-key and non-official relay providers retain their previous paths and authentication contracts.
- Automatic LAN mode does not create router port forwarding, change the system firewall, or expose a public tunnel.

## v1.6.1 — Task-bound sessions, scheduled messages, and signed APK releases

### Highlights

- **Task board with bound chat sessions** — every task now owns a dedicated 1:1 hidden chat session. Open a task to see its live transcript, send follow-ups, cancel runs, and clean up worktrees. Tasks carry stable short codes (`#CODE`) and archived tasks release their bound sessions.
- **Scheduled messages** — queue messages into a session FIFO and review them in a floating dock before they are sent.
- **Signed APK distribution** — Android APKs are built on demand and attached to GitHub Releases, signed with the project release key. The `/manage` APK area prefers a local `public/multicc.apk` and falls back to the exact release asset for the server's package version.
- **Relay sharing for remote access** — generate provider-scoped relay links and pick addresses from `/manage`; each link has independent credentials, usage records and revocation.
- **Hibernate idle task worktrees** — idle task-bound chat worktrees are automatically hibernated to free system resources.
- **Voice task announcements** — voice mode announces the identity of completed tasks so you can stay hands-free.
- **Dynamic Claude model list** — the Claude model picker is populated from your local Claude CLI bundle and cached for one day.

### Improvements and fixes

- Task-run failures are now visible with bounded automatic retry and clearer wrapper exit / compile-input streams.
- Tool cards show running-state animations; native prompt/confirm/alert dialogs are replaced with in-page dialogs.
- Streaming markdown renders are coalesced on a 50 ms timer for a smoother chat experience.
- Cancel escalation now moves from SIGTERM to SIGKILL after a grace period.
- Codex Agent Wait cards display the wait scope instead of empty agent IDs.
- Claude/Codex login banners are shown only for official providers.
- Server route mounting was refactored into a chained `mountRoutes` pipeline while keeping `server.js` within its 3 000-line migration budget.
