# Changelog

All notable changes to MultiCC are documented in this file.

## v2.0.1 — Task attribution you can see and steer (2026-09-19)

### Highlights

- **Task attribution ladder** — every incoming message is matched to a task through an escalating chain of evidence, and each decision is written to a durable journal you can audit. When a message references another task's history, the rejection now names the task it pointed at.
- **Attribution controls in chat** — accept or reject the AI Assistant's suggestion inline, re-attribute a whole turn by hand, or split it into a durable independent continuation that keeps its own task.
- **Input target** — the composer always shows which task your next message will land in. Pick any task from the full-history index; in-flight turns stay durably queued instead of being dropped.
- **Air task pins** — pin up to five tasks for one-tap access: the header tab row on desktop, the sidebar top on mobile and in the app.

### Improvements and fixes

- **Battery guard** — a new in-process guard can sleep the host when running on battery below a threshold, opt-in alongside the lid-closed-running setting, and stays latched until AC power or a manual rearm.
- **Bundled computer-use skills** — `computer-use` and `computer-use-permissions` ship as preset skills. Bundled skill install no longer wipes a same-named, unversioned user skill.
- **Task graph** — batch ranges, explicit relations, and visible source edges make the relationship network easier to read.
- **Air console polish** — sidebar boxed groups in two columns with a foldable 常用设置; the line capsule shows the provider name with a marquee; "谁在等我" now lists only actionable tasks; the directory Git card offers one-click push for unpushed commits.
- **Performance and durability** — ETag/304 conditional polling, `cursorVersion`-gated conditional writes, a receipt-index rowid watermark, and `sessionId`→task / `taskId`→link indexes reduce redundant work and keep state consistent across reconnects.

### Compatibility

- No API or data-format changes. Existing provider configurations, relay shares and imported Fleets keep working without migration. The Android and iOS packages advance to `2.29.14+127` so they upgrade the previous stable build in place.

## v2.0.0 — The Air release (2026-09-16)

### Highlights

- **The Air console is the main interface** — `/` and `/manage` now both redirect to `/air`, making the task-first surface the single entry point. Tasks, not roles, are the unit of work.
- **First-run setup guidance** — new users land on `/air` and are walked through a setup card: prepare a model (import a provider or use a CLI's own login), then configure the AI Assistant. The AI Assistant is a core service — a lightweight flash-tier model is enough.
- **AI Assistant (aux) console page** — model settings and run records for the intent-classification / task-attribution / auto-advance service, in the Air console under Settings › AI & execution.
- **Native task graph and memory graph** — `view=taskgraph` renders the task relationship network (parent/child, grouping, merges, shell links); `view=memory` renders the cross-task memory network.
- **The new-task composer remembers your last runtime** — the most recently used CLI, line, and model (`lastRuntime`) are pre-filled on the next task.
- **Provider switches broadcast instantly** — the chat page's quota bar updates as soon as the line changes, no reload needed.
- **Scheduled tasks bind to fixed Air tasks** — cron-style recurring work keeps its task, session, and context across runs; task delivery is sectioned and drag-orderable.

### Improvements and fixes

- **SakuraFrp tunnel monitoring** — launcher detection, diagnostics, and `frpc` fallback join Tailscale Funnel and 花生壳 as the third built-in public-tunnel option.
- **Share links open the chat page directly** — recipients of a password-protected snapshot land in the conversation, not an index page.
- **README fully revised for 2.0** — task-first Quick Start, the Air console section, eight-CLI feature list, and operational screenshots captured in the docker test environment.
- **Desktop releases stay in lock-step with the main tag** — the desktop packaging flow was hardened so the five desktop artifacts publish automatically with the main release.

### Compatibility

- No API or data-format changes. Existing provider configurations, relay shares and imported Fleets keep working without migration.

## v1.7.0 — The Air console, and a light native client

### Highlights

- **The Air console replaces the old control pages** — `/air` is one light surface for directories, tasks, sessions, schedules and host operations, on a pale blue-white canvas with hairline borders and a single ice-blue accent. The console opens as an overlay, the task band switches scope, `⌘K` searches both directories and tasks, and the manage sidebar's host-ops region is available without leaving the page.
- **The Flutter client is re-skinned onto the same palette** — the native Android/iOS app now reads from one `AppColors` token set that mirrors `public/air.css`, including the light launch screens, the dashboard accents, and a drawer that carries the Air sidebar's blue-white wash instead of the old dark surface.
- **Tasks, not roles, are the unit of work** — the fixed-role session UI is retired. Tasks are created against a directory, draw a durable workspace admission before any CLI starts, carry task-scoped artifacts in the chat sidebar, and expose provider routing metadata without exposing credentials.
- **A tighter mobile header** — on phones the page header is a title area rather than a second navigation bar: the breadcrumb moves into the drawer, the state summary reads on the title's line (falling back to its own line rather than truncating the title), and the refresh control returns to the tool row.

### Fixes

- **Provider identity is unified** — official providers and global account switching go through one routing path, relay (borrowed) providers report pass-through usage, and context provenance is visible in the usage details.
- **AI configuration changes are deferred** until they can be applied, and the conversation width is adjustable, so editing configuration no longer interrupts a running turn.
- **Task cleanup is complete** — every task type can be archived and permanently deleted, and the manage task panel is now a module-grouped list with status filter chips and a quick-create composer.

### Compatibility

- No API or data-format changes. Existing provider configurations, relay shares and imported Fleets keep working without migration. The Android package advances to `2.29.13+126` so it can upgrade the previous stable APK in place; the iOS package is `2.29.13+126` as well.

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
