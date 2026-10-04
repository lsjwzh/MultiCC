# Changelog

All notable changes to MultiCC are documented in this file.

## v2.3.2 — Quieter turns, one place for notifications (2026-10-04)

### Highlights

- **One "Notifications & announcements" panel** — voice announcements, task reminders and system push used to live in three different places (an Air boolean, the chat frame's own read-aloud toggle, and the console push page); they are now configured from a single panel on the brand row, and the standalone chat page got a proper task-notification controller to match.
- **A per-turn model timeline** — chat frames can now show the spans of a turn that are not tool execution (request in flight, thinking, streaming) instead of a flat "running" state, so you can see what the model is actually doing.
- **Consistent status presentation across surfaces** — the App's dashboard cards, chat header, tool cards and Air task rows now share one status/presentation layer (with decluttering of the dashboard), instead of each widget hard-coding its own wording and colors.
- **Housekeeping** — notify-preferences, session-git routes, status presentation and turn-timeline all gained their own tests; the human-assist and secrets skills were updated in-tree.

## v2.3.1 — A smoother remote screen (2026-10-04)

### Highlights

- **Smooth mode uses ~30× less bandwidth** — the RFB stream now captures at half resolution and trims each frame to a 32px column band, so cursor-move frames drop from ~247KB to ~3KB; the perceived stutter that looked like a stalled stream was really the old frames saturating the link.
- **Region zoom instead of squinting** — a new ⛶ button on the remote screen switches to box-select zoom (pick a rectangle to enlarge) on both the chat page and the App, instead of only pinch/full-image scaling.
- **The "right-click" button works in smooth mode** — it used to be a dead button whenever the RFB stream was live; now the capture layer routes the next tap as a right click, and the App maps a long press to right-click as well.
- **Zoom taps land where you aimed** — taps in the enlarged view were offset because the HTTP path speaks CSS points while the zoom tap sent framebuffer pixels (2× apart after the half-resolution switch); the tap is now normalized against the logical screen width. The bundled noVNC client also gets its view-only and viewport-scaling flags set the way it actually reads them, so portrait phones no longer show a cropped, input-forwarding "view-only" stream.

## v2.3.0 — See and drive the Mac from the chat (2026-10-04)

### Highlights

- **Remote screen in the chat page and the App** — a new 🖥 Screen overlay shows the Mac's main display and lets you click, drag, scroll and type on it without leaving the conversation. It needs no VNC or RustDesk install: it rides on the screen-capture and input permissions the MultiCC Agent already holds (`src/remote-screen.js`). A JPEG polling path always works, and a smooth mode streams through a minimal RFB server embedded in the Agent plus the bundled noVNC client (`public/vendor/novnc`), falling back to polling if the stream drops. The Flutter App has its own native RFB client with pinch-to-zoom.
- **Annotate a frozen frame to act on it** — freeze one frame of the remote screen into the annotator and every mark becomes an action the moment you draw it: a point clicks, a box clicks its centre, an arrow drags, and "re-capture" refreshes the picture in place. The same realtime relay (`/api/annotation-live`) can forward marks on any screenshot to a local webhook configured in `~/.multicc/annotation-live.json`, so new automation targets plug in with one config line.
- **Android push via FCM, iOS push via Bark devices** — the Android App can register for Firebase Cloud Messaging (optional: builds without Firebase config simply skip it), with task notifications rendered natively. Bark devices can be managed from the Air settings panel and the App. FCM credentials stay on the server, and missing credentials disable only FCM, never the other push channels.
- **Several official accounts per vendor, kept fresh** — signed-in Claude accounts now refresh their OAuth tokens through the claude CLI itself, each with its own config dir, so accounts no longer log each other out. The accounts panel notices the login your CLI already holds and offers to sign in here too, without copying the single-use refresh token. When a vendor has two or more accounts, a slow sweeper records each account's usage windows so Auto can tell which one still has headroom.
- **Resume guard for every resume-capable CLI lane** — zcode, kimi, codebuddy, qoder and dsh native sessions that grow past 10MB are moved to a MultiCC archive (never deleted) before a resume, the same contract the codex rollout guard already enforced, so an oversized native history can no longer stall startup. Auto Provider also stops resetting a session's current route when a handoff merely clones an unchanged policy.

## v2.2.3 — One run-config dialog instead of three (2026-10-01)

### Highlights

- **A single "run config" capsule replaces the three separate CLI / model / effort buttons** — picking a lane, CLI and model used to take two passes (choose the CLI in the task bar, then choose it again inside the Auto Provider editor); the new `public/run-config.js` dialog shows both the fixed-lane and auto-pick-pool modes in one place and reuses the provider catalog and AI-config logic as pure functions instead of duplicating them. The old `air-task-settings.js` three-step form is gone.
- **Voice input is a shared composer module** — streaming dictation (with the floating refine HUD) and the legacy one-shot recording path were extracted out of `chat-composer.js` into `public/voice-composer.js`, so the Chat page and the Air directory's quick-task composer now share one implementation instead of two copies drifting apart.
- **Codex per-turn usage accounting** — `src/codex/usage.js` gained a `perTurn` mode for the app-server adapter, which already sums request-level usage updates itself; only `codex exec`'s cumulative thread snapshot still needs the old baseline-diffing path.
- **Chat history framing and finalize-plan fixes** — `src/chat/history-frame-budget.js`, `finalize-plan.js` and `finalize-host.js` picked up edge-case fixes alongside broader i18n coverage in `public/i18n.js` and `public/i18n-catalog.js`.

## v2.2.2 — Auto Provider knows what each model costs (2026-10-01)

### Highlights

- **A built-in per-model price table** — the Auto Provider router can now compare candidate lanes by cost before picking one. The table follows the public models.dev catalog (~225 providers, ~8300 models) and answers synchronously from local copies: a refreshed cache first, an OpenCode cache if one is already on disk, and a shipped first-party seed as the offline fallback — never a network round trip inside a turn.
- **`/api/pricing/*` read endpoints** — status, bulk lookup (up to 50 model ids), an awaited refresh, and search, so the chat and manage UIs can show why one lane is cheaper than another.
- **The Auto Provider editor shows pricing** — the web editor and the App's AI configuration sheet display per-model input/output (and cache) prices next to the candidates, and the router's cost reasoning is visible instead of implicit.
- **Classify, composer and notification copy updates** — the classify state machine and vocab, the message composer and the push notification copy were tightened alongside, with the App's admission notes, classify bar and session status helpers following the same contracts.

## v2.2.1 — English by default outside Chinese locales (2026-09-30)

### Highlights

- **The Web UI and desktop shell now default to English outside Chinese locales** — interface language resolves in three stages: your explicit choice wins, otherwise the system locale decides, falling back to English when it is not Chinese. Chinese locales keep Chinese as before, and every page gained a language switcher so the choice is always one click away. The terminal page and the task board were fully wired into i18n along the way. (The Flutter app still defaults to Chinese; its switch is tracked separately.)
- **The session dashboard is gone** — the standalone dashboard web page, the App screen and its API were removed entirely; the Air view and the task board remain the way to watch sessions. If you linked to the old dashboard, those links now lead nowhere by design.
- **macOS lid-closed mode keeps the desktop alive with the backlights off** — the Agent can keep working on a lid-closed Mac without waking the displays, and enabling lid mode now walks you through the desktop permissions it needs instead of failing silently. Installer source hashing no longer depends on the Perl locale.

## v2.2.0 — Auto-commit that fires even when no page is watching (2026-09-29)

### Highlights

- **Auto-commit moved server-side** — a finished turn now commits and merges back to the base branch from the server's turn engine, so turns that end while no chat page is connected (closed laptop, evicted Air frame, app in the background) are merged too instead of piling up in the worktree until the next online turn. Results land in the conversation as transient system messages.
- **The per-turn auto-commit checkbox is gone** — the little checkbox under the last user message could never cover offline turns by design, so the session-level header toggle is now the single control (Web header and App menu alike), defaulting to on as before.
- **Planned tasks can be deleted again** — a task whose workspace was never materialized (no turn ever ran) refused deletion with `task_workspace_unverifiable`, which also blocked deleting its directory. A never-created branch now reads as "nothing to lose"; a missing checkout with a surviving branch keeps the old conservative refusal.

## v2.1.6 — A settings drawer that stays tidy, and unlock checks that do not nag (2026-09-28)

### Highlights

- **The settings drawer is a two-level cascade** — the Air settings panel groups related options under sections instead of one long flat list, so host power, tunnel, update and account settings are each one click away instead of a scroll away.
- **The uncommitted-files pill opens its list** — the main checkout's "N uncommitted files" capsule is now clickable and shows the actual file list with a diff on demand, instead of being a static count.
- **Unlock access is probed instead of assumed** — the macOS Agent auto-unlock gained a bounded readiness probe (an explicit check, or saving a password, may show the system sheet while the screen is unlocked). The old `privileged-helper` was removed and its routes were folded into the host power surface, with a probe that never returns credentials and stays inside the web client's request timeout.
- **The main repo's shared `data/` is ignored** — root `data/` is local shared data and no longer a candidate for the git watch.

### Release integrity

- The paint budget now registers the admin-stats marquee keyframe (it only runs while the label overflows, pauses on hover/focus and drops under reduced-motion), keeping the CI gate green.

## v2.1.5 — Task runs folded into the board, and reminders that know you're away (2026-09-27)

### Highlights

- **Task runs live under the task board now** — the separate `task-run` module (store, host, recovery, cleanup, provider bridge, production) was folded into the board's ownership, deleting thousands of lines of duplicated lifecycle. The public surface you rely on — running a task, watching its progress, cancelling it — is unchanged, but there is one place that owns task state instead of two.
- **The directory card got a Git history browser** — a shared `git-manager` component shows commit history right in the Air directory card, with patches fetched only on demand and repository text always inserted as text.
- **Reminders know whether anyone is looking** — a shared user-presence probe (page visible and touched within the last five minutes) is the single answer both the task reminders and the chat notifications read, so they never disagree about whether to narrate. Several reminders stack into a fan-out deck with a count badge (errors first), each card with its own open/dismiss.
- **A directory's schedules are one click away** — the directory overview gains a "schedules for this directory" entry that filters the global cron rules by the directory you are looking at, as a page-internal dialog (bottom sheet on phones).
- **The Sakura Frp tunnel installer is gone** — the tunnel surface ships without the bundled Sakura installer; the tunnel API is unchanged and manual/third-party installers keep working.

### Release integrity

- The runtime write inventory was trimmed to the surviving write roots, keeping the governance assertion green in CI's deterministic stage.

## v2.1.4 — One-click upgrades from the web, and a Mac that stays awake when asked (2026-09-27)

### Highlights

- **The upgrade button now runs the real installer** — the web UI's update path stops pointing at an in-package re-pack; it fetches `install.sh` from the target tag and runs it against the existing install directory, so an upgrade is byte-for-byte the same flow as a first install (stop, back up, replace, carry port/token across, start). A git checkout still uses `./multicc update`.
- **Keep the machine awake while a task runs** — an opt-in runtime switch (global settings) holds a `caffeinate` assertion so the display and the lock screen do not come up mid-task; the assertion is released automatically when the server exits, so no orphan process keeps the screen on forever.
- **The unlock password stays in the login keychain** — the optional auto-unlock password for the MultiCC Agent is written to the macOS login keychain only, never through the vault and never through an LLM.
- **A directory's artifacts got their own page** — the directory overview's artifact list now opens as a dedicated page (same data as the overview grid), with its own refresh, its own pinned and permanent toggles, and an App counterpart.
- **The macOS Agent grew a native companion** — the MultiCCAgent framework now carries its own keep-awake and unlock-password plumbing, so the desktop client can keep the screen on and unlock without shelling out through a fragile path.

### Release integrity

- The runtime write inventory is complete again — the human-assist screenshot root was registered as ephemeral, which clears the governance assertion that had been red in CI's deterministic stage since 2026-09-25. The release core gate itself was never affected (it does not run that tier), which is why the release went out while CI was red.

## v2.1.3 — Terminals you can actually work in, and screenshots you can point at (2026-09-26)

### Highlights

- **Point at a screenshot instead of describing it** — a remote assist screenshot can be annotated in the web lightbox or in the App's annotation page: points, boxes and arrows with notes, serialized into a text block the agent reads. The block is byte-identical across the web editor, the App and the agent-side contract, so an annotation made on either end arrives with the same meaning. Screenshots are swept after 7 days per file, emptied session directories are dropped, and symlinks are left alone.
- **The terminal page became a workspace** — an info bar names the cwd, worktree, branch and the provider·model the terminal runs on, with switching between terminals in the same directory. Sessions gain find, font zoom and shortcuts, and a reconnect or a return to the page replays the screen instead of doubling the scrollback.
- **Every terminal row says whether it is still usable** — a status dot, how long it has been idle, rename and copy id, plus two repairs: delete (behind a second confirmation) and restart, which also heals a terminal whose managed route has died.
- **New terminals are configured the way chat is** — pick the CLI first, then Provider and model, in the same dialog the chat composer uses.
- **Entering a terminal no longer returns 409** — the managed route for a terminal session now carries the capability token.
- **The CLI catalog is two layers** — family × scenario, with derived lanes. `claude-exp` is Claude and `codex-exp` is Codex again, and one-shot lanes left the chat picker.
- **Deleting a referenced provider shows what references it** — a structured list of the sessions and configurations involved, with an explicit force delete, instead of a refusal with nothing to act on.
- **The Air directory overview is five operational stat cards** — each one a quick filter. Active counts what is actually running rather than the unarchived backlog.
- **The pending-answer bubble can be dragged**, and there is a rebase button next to merge.

### Release integrity

- The reviewed core set was re-audited and the tier manifest is complete again: the three human-assist annotation tests are registered as core, and the release core assertion — red on main since `tests/test-global-lane-tier-alias.js` was registered without moving it — is back in step with the manifest.
- The monitor-admission core tests no longer race the CLI child they spawn: three of them probed the background hold with a fixed 500ms window, which a loaded machine misses while the child is still starting, so they failed a turn that was in fact held correctly. They now wait for the child's own output before asking whether the turn settled. The file was red on main — 5 of 17 failing on a clean checkout — before this release.

## v2.1.2 — Upgrading from an installation the installer cannot see (2026-09-26)

### Highlights

- **An older installation that is not at the install path is found instead of ignored** — installers from before the standalone package put MultiCC wherever they were run from (`$PWD/MultiCC`), while this release installs to a fixed `~/MultiCC`, so the installation holding a user's history is routinely somewhere else entirely. The installer now looks where that installation can be evidenced — the directory the login service starts MultiCC from, and the directory this run was started in — and reports it.
- **`--adopt-data <path>` brings the old data across** — sessions, chat history, task databases, memories and provider settings are copied into the new per-user data directory, and the old installation is left exactly as it was: not stopped, not renamed, not upgraded, its own token and port untouched.
- **Nothing is copied from a directory the user did not name without an answer** — an installation the installer found on its own is reported and left alone; the copy happens only when the user names the path, confirms the question, or passes `--yes`. Where there is no terminal to ask on, the answer is the one that changes nothing, on both platforms.
- **Windows has the same two paths** — `-AdoptData` and the same "found it, left it alone" report, with the copy verified against a real PowerShell run.

### Installer

- In-place upgrades of a pre-standalone installation (data root inside the package root) are unchanged: the old directory is stopped and kept as a backup, and its data is brought across.
- The Windows data list and the POSIX one are still identical name-for-name, and both installers derive the destination from `multicc config path` rather than a hard-coded per-user path.

## Unreleased

### Improvements and fixes

- **A half-installed macOS Agent now repairs itself** — the installer staged the prebuilt agent through `mktemp` (0600) and `cp`, which keeps an existing destination's mode, so a machine that used the packaged binary got the agent installed *without its executable bit*: launchd could never start it, every request failed, and automatic unlock reported "check access" no matter how often the user clicked. Installing now sets the mode explicitly and accepts a prebuilt whose mode was lost in transit (instead of falling back to a local build that needs the Xcode command line tools), the startup provisioning step treats a non-executable binary or a missing client symlink as "install it again" rather than "up to date", and after installing it pings the agent and warns when it is not answering. The unlock probe now separates "no executable bit" / "not installed" / "agent too old" from a plain failed check, so the panel says to restart MultiCC — which repairs it — instead of offering a button that cannot help.

## v2.1.0 — Smarter routing, full-history search, and one unified Air console (2026-09-25)

### Highlights

- **Difficulty-aware Auto Provider routing** — Auto pools can keep a fixed failover order or route each message by difficulty. Jev evaluates the request before admission and sends simple work to economical models while reserving stronger models for complex work. Vercel AI Gateway, OpenRouter, TypeSafe, and custom HTTPS endpoints are supported. Keys remain in the local secrets vault, route decisions are visible in chat, and unavailable or uncertain evaluations follow a configurable safe fallback.
- **Search the conversation, not just the task title** — Air can search task metadata and the full text of chat history, with ranked and highlighted snippets. A derived FTS index warms incrementally without blocking startup, updates after live turns, and also gives automatic task attribution stronger retrieval evidence.
- **The Control Center is now fully native in Air** — provider management, official-account switching, relay sharing, ZCode/Kimi native login, workspace hibernation, orphan reconciliation, ignored-file audit, schedules, memory, voice, secrets, and host operations now live in the Air shell. Existing `/manage` and `/manage.html` bookmarks redirect to the corresponding Air view.
- **Faster, safer long-running sessions** — Codex app-server sessions join Claude in a bounded resident-process pool, preserving native continuity while avoiding unbounded idle processes. Workspace leases serialize writers, restore hibernated worktrees before delivery, and keep active or queued turns from being reclaimed.
- **Durable task-first dispatch** — `route_task` and `dispatch_master` can create an independent task and its execution session atomically through `new_task`, with idempotent creation and delivery receipts. Existing dispatch-to-session calls remain supported.

### Air, Web, and App improvements

- Added full-history versus task-only search scopes, quick directory switching, drag-to-reorder directories, and server-persisted ordering.
- Missing coding CLIs can now be installed directly from the CLI update panel; model pickers refresh their Claude and Codex catalogs more reliably.
- Task rows now show when a worktree has uncommitted changes or commits still waiting to merge.
- Auto Provider editors on Web and App now suggest local Claude models for provider lines without their own catalog, while retaining a custom-model escape hatch.
- Provider quota and balance bars now behave consistently across Web and App, including relayed and experimental CLI families, cached last-known-good readings, provider switches, and expired reset windows.
- Per-message token usage now presents main and separately routed sub-agent usage consistently on Web and App.
- Task deletion failures now name the tasks retaining a conversation and no longer leave cards stuck in a permanent “deleting” state.
- English README screenshots are generated from a deterministic mocked fixture.

### Reliability and orchestration

- Release qualification is now explicit and auditable: every test file is classified as core, flow-impacting, or other; stable releases require the exact core manifest plus a pristine standalone installation test, while broader UI, live, CDP, and optional-flow suites remain available without blocking a release.
- Resident background and sub-agent work may finish after the main reply without being rejected as stale proxy traffic.
- Monitor admission, process-close handling, watchdog recovery, queued-delivery reporting, and workspace backpressure were tightened so long-running work is not mistaken for completion.
- A terminal turn ledger now runs in shadow mode, recording Claude/Codex hook evidence for diagnostics without taking over lifecycle decisions.
- Provider routing rejects mismatched or stale capabilities more precisely and preserves retryable backpressure without consuming delivery budgets.
- Task-history retention, stale task-run recovery, and worktree capacity reclamation received additional safeguards.
- **Upgrade-time cleanup of cron fan-out residue** — `./multicc update` archives the per-firing duplicate tasks that releases ≤ 2.0.2 left on the board. The cleanup runs once per data directory, reports its count, and never blocks readiness.
- Updated the bundled Claude Agent SDK from 0.3.278 to 0.3.280.

### macOS onboarding

- **`computer-use` → `multicc-computer-use`** — the bundled GUI-automation skill now drives the optional MultiCC Agent through one shared Accessibility and Screen Recording grant across every CLI, provider, and `-p` session. It adds element-level see/click/set/press actions, an Esc emergency stop, a one-session lease, locked-screen refusal, automatic install/update, and a fallback path when the agent is absent.
- The installer now verifies that Git actually works. It distinguishes the `/usr/bin/git` Command Line Tools shim from a real Homebrew, MacPorts, Xcode, or git-scm installation.
- When Git is unavailable, Air can open the macOS Command Line Tools installer directly.
- Full Disk Access errors now offer a one-click jump to the correct System Settings pane and identify the exact app or executable that needs permission.
- The optional lid-sleep helper is narrowly scoped to `pmset -a disablesleep`, validates its sudoers entry before installation, and still falls back to the normal administrator prompt.
- Desktop builds now enable the hardened runtime, include the Electron/Node entitlements it requires, and declare usage descriptions for Desktop, Documents, Downloads, removable volumes, and network volumes.

### Compatibility

- **No intended REST API or persisted task/provider format break.** Existing ordered Auto Provider pools continue to work unchanged; difficulty routing is opt-in.
- The old `/manage` document and its private frontend modules were removed. `/manage` and `/manage.html?view=…` bookmarks redirect to Air, but custom tooling that imported legacy `public/manage-*.js` assets must move to supported APIs or Air panels.
- MultiCC still ships its own Node runtime, but **a working Git installation is required at runtime** because every coding session owns a Git worktree. The installer continues when Git is missing and prints the exact remediation.
- Full-history search creates a rebuildable derived SQLite index; chat history remains authoritative and no manual migration is required.
- Jev makes an external evaluation request only when difficulty routing is enabled. Its API key stays in the local vault, and evaluation failure never drops the user message.
- The Flutter app advances to `2.29.15+133`. Node.js remains `>=22.16`; existing desktop and standalone platform floors are unchanged.

## v2.0.1 — Task attribution you can see and steer (2026-09-19)

### Highlights

- **Task attribution ladder** — every incoming message is matched to a task through an escalating chain of evidence, and each decision is written to a durable journal you can audit. When a message references another task's history, the rejection now names the task it pointed at.
- **Attribution controls in chat** — accept or reject the AI Assistant's suggestion inline, re-attribute a whole turn by hand, or split it into a durable independent continuation that keeps its own task.
- **Input target** — the full-history index shows and switches which task your next message will land in (the ◎ marker); in-flight turns stay durably queued instead of being dropped.
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
