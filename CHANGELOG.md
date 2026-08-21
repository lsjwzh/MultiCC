# Changelog

All notable changes to MultiCC are documented in this file.

## v1.6.2 — Secure LAN access and Official OAuth relay sharing

### Highlights

- **Password-gated LAN access by default** — normal installations now listen on the IPv4 LAN automatically when the installer-generated `ACCESS_TOKEN` is present. Direct HTTP and WebSocket peers are limited to private, loopback, and Tailscale networks; public access still goes through Tailscale Funnel or another explicitly configured reverse proxy.
- **Reliable LAN address discovery** — MultiCC prefers physical Wi-Fi/Ethernet addresses, filters VPN, Docker, bridge, and Tailscale virtual adapters, and reports every usable LAN URL instead of advertising the first arbitrary interface.
- **Actionable installation diagnostics** — the installer reports when LAN binding is explicitly disabled or no physical IPv4 adapter is available, and points to host-firewall and Wi-Fi client-isolation checks when the service is listening but another device still cannot connect.
- **Official Codex OAuth relay** — relay sharing can use the host's current ChatGPT/Codex OAuth session without exporting access or refresh tokens. The host owns token refresh, account selection, upstream requests, and fail-closed login-expiry handling.
- **Installable Android release artifact** — the signed Android package advances to `2.29.8+120`, so it can upgrade the prior stable APK instead of being rejected as the same Android version.

### Security and compatibility

- Explicit `HOST` / `MULTICC_ALLOW_REMOTE` settings remain authoritative; `HOST=127.0.0.1` or `MULTICC_ALLOW_REMOTE=0` keeps a loopback-only installation.
- Existing API-key and non-official relay providers retain their previous paths and authentication contracts.
- Automatic LAN mode does not create router port forwarding, change the system firewall, or expose a public tunnel.

## v1.6.1 — Task-bound sessions, scheduled messages, and signed APK releases

### Highlights

- **Task board with bound chat sessions** — every task now owns a dedicated 1:1 hidden chat session. Open a task to see its live transcript, send follow-ups, cancel runs, and clean up worktrees. Tasks carry stable short codes (`#CODE`) and archived tasks release their bound sessions.
- **Scheduled messages** — queue messages into a session FIFO and review them in a floating dock before they are sent.
- **Signed APK distribution** — Android APKs are built on demand and attached to GitHub Releases, signed with the project release key. The `/manage` APK area prefers a local `public/multicc.apk` and falls back to the exact release asset for the server's package version.
- **Relay sharing for remote access** — generate relay tokens and pick addresses from `/manage`; share provider configurations securely via the `MULTICC_PROXY_TOKEN` CPR proxy.
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
