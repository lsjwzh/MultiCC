# Changelog

All notable changes to MultiCC are documented in this file.

## v2.10.0 — Reliable remote control and precise quota recovery (2026-10-25)

- Add a per-user Linux X11 desktop-agent installer and login autostart. Serialize input, interrupt active operations with Escape, release held keys on cancellation, and report unsupported Wayland sessions clearly.
- Improve mobile remote-screen frame updates, H.264 recovery, RFB framebuffer handling, and touch-to-pointer delivery. Show frame age and clearer display and agent errors.
- Read Claude five-hour and weekly quota windows from conversation response headers without automatic usage-page queries. Keep account data isolated and expire each window at its own reset.
- Classify provider rejections in Rust as temporary throttling, exhausted quota windows, model entitlement limits, or billing failures. Preserve account-wide restrictions while applying model-specific cooldowns and retry deadlines.
- Use Rust task summary reads with atomic asynchronous replay for Air, and refresh the bilingual guides and interface screenshots.
- Audit the exact release core plan at 361 suites and 336 commands, including deterministic passive-quota coverage, while keeping UI and device suites outside the core gate.
- Update the mobile app to 2.38.0 (build 180).

## v2.9.3 — Subagent routing, account sign-in, and remote control (2026-10-23)

The v2.9.0 and v2.9.1 candidates stopped at release checks. The v2.9.2
candidate passed core and clean-install checks, but Apple rejected a compressed
plugin executable during macOS notarization. This release includes the changes
below and expands compressed Mach-O plugin resources before desktop signing so
Developer ID signatures, secure timestamps, and hardened runtime cover them.

- Configure subagent providers and models directly in the run configuration panel on Web and App, with first-use guidance, saved presets, and optional synchronization across matching tasks.
- Sign in to official Claude and Codex accounts from the management interface, including pasted callback support; discover Codex models per account and keep account credentials and model catalogs isolated.
- Improve Claude credential refresh recovery and account-specific network egress, and add the Chrome Proxy Launcher plugin for managed browser and proxy profiles.
- Add an opt-in Rust provider-router backend with comparison tools while retaining the default Node backend; move task-context access, subagent defaults, publication policy, and model-catalog decisions into Rust.
- Update provider presets and model selection, and prevent transient upstream failures from exhausting the chat host retry budget.
- Reduce remote-control drag latency, keep pointer transitions ordered, resolve pinch and drag gesture conflicts, and display the latest frame after asynchronous decoding.
- Standardize new commit identity and validate English commit messages and release notes; keep core and clean-install checks running alongside release builds.
- Update the mobile app to 2.37.0 (build 173). Publish desktop and standalone packages first, then mobile OTA, with App Store submission last.

## v2.9.2 — Subagent routing, account sign-in, and remote control (2026-10-23)

The v2.9.0 and v2.9.1 candidates stopped at release checks and were not
published. This release includes the changes below with Rust formatting
corrected and Git identities configured for clean-install and isolated tests,
including the temporary home used by dispatch integration tests.

- Configure subagent providers and models directly in the run configuration panel on Web and App, with first-use guidance, saved presets, and optional synchronization across matching tasks.
- Sign in to official Claude and Codex accounts from the management interface, including pasted callback support; discover Codex models per account and keep account credentials and model catalogs isolated.
- Improve Claude credential refresh recovery and account-specific network egress, and add the Chrome Proxy Launcher plugin for managed browser and proxy profiles.
- Add an opt-in Rust provider-router backend with comparison tools while retaining the default Node backend; move task-context access, subagent defaults, publication policy, and model-catalog decisions into Rust.
- Update provider presets and model selection, and prevent transient upstream failures from exhausting the chat host retry budget.
- Reduce remote-control drag latency, keep pointer transitions ordered, resolve pinch and drag gesture conflicts, and display the latest frame after asynchronous decoding.
- Standardize new commit identity and validate English commit messages and release notes; keep core and clean-install checks running alongside release builds.
- Update the mobile app to 2.37.0 (build 173). Publish desktop and standalone packages first, then mobile OTA, with App Store submission last.

## v2.9.1 — Subagent routing, account sign-in, and remote control (2026-10-23)

The v2.9.0 candidate stopped at release checks and was not published. This
release includes the changes below with Rust formatting corrected and the
clean-install and isolated test environments configured from the repository
Git identity policy.

- Configure subagent providers and models directly in the run configuration panel on Web and App, with first-use guidance, saved presets, and optional synchronization across matching tasks.
- Sign in to official Claude and Codex accounts from the management interface, including pasted callback support; discover Codex models per account and keep account credentials and model catalogs isolated.
- Improve Claude credential refresh recovery and account-specific network egress, and add the Chrome Proxy Launcher plugin for managed browser and proxy profiles.
- Add an opt-in Rust provider-router backend with comparison tools while retaining the default Node backend; move task-context access, subagent defaults, publication policy, and model-catalog decisions into Rust.
- Update provider presets and model selection, and prevent transient upstream failures from exhausting the chat host retry budget.
- Reduce remote-control drag latency, keep pointer transitions ordered, resolve pinch and drag gesture conflicts, and display the latest frame after asynchronous decoding.
- Standardize new commit identity and validate English commit messages and release notes; keep core and clean-install checks running alongside release builds.
- Update the mobile app to 2.37.0 (build 173). Publish desktop and standalone packages first, then mobile OTA, with App Store submission last.


## v2.9.0 — Subagent routing, account sign-in, and remote control (2026-10-23)

- Configure subagent providers and models directly in the run configuration panel on Web and App, with first-use guidance, saved presets, and optional synchronization across matching tasks.
- Sign in to official Claude and Codex accounts from the management interface, including pasted callback support; discover Codex models per account and keep account credentials and model catalogs isolated.
- Improve Claude credential refresh recovery and account-specific network egress, and add the Chrome Proxy Launcher plugin for managed browser and proxy profiles.
- Add an opt-in Rust provider-router backend with comparison tools while retaining the default Node backend; move task-context access, subagent defaults, publication policy, and model-catalog decisions into Rust.
- Update provider presets and model selection, and prevent transient upstream failures from exhausting the chat host retry budget.
- Reduce remote-control drag latency, keep pointer transitions ordered, resolve pinch and drag gesture conflicts, and display the latest frame after asynchronous decoding.
- Standardize new commit identity and validate English commit messages and release notes; keep core and clean-install checks running alongside release builds.
- Update the mobile app to 2.37.0 (build 173). Publish desktop and standalone packages first, then mobile OTA, with App Store submission last.

## v2.8.5 — Restore desktop release startup (2026-10-22)

This release carries the v2.8.4 changes below. The v2.8.4 desktop workflow was
rejected before any build could start because job-level environment variables
referenced the unavailable runner context; its tag remains unchanged.

- Initialize Rust build directories in a step after runner allocation, for both desktop and standalone packages.
- Add a regression check for the workflow context boundary and validate the release workflows with actionlint.
- Keep core and clean-install gates running alongside builds; publish only after the required jobs succeed.
- Keep the mobile app at 2.36.3 (build 172), which has not been distributed through the v2.8.4 release.

## v2.8.4 — Rust runtime, safer installation, and account visibility (2026-10-22)

- Ship Rust SQLite as the default database backend, with explicit Node emergency compatibility mode; add native task-search and token-usage kernels with parity coverage.
- Build and verify target-specific Rust modules for desktop and standalone packages. Source-checkout startup builds missing modules and reuses a cache tied to the source and build configuration.
- Harden installer and packaged-runtime checks, and improve desktop port selection and stale-process handling.
- Add workspace deletion from the directory home on Web and App, and clarify external access when sharing links.
- Show official-account subscription information with refresh and billing-page links on Web and App; improve relay model catalogs and route compatibility.
- Improve Codex proxy diagnostics, chat error persistence, and Claude Agent SDK routing.
- Start release gates and builds in parallel; publish only after core, clean-install, and required artifact checks pass.
- Update the mobile app to 2.36.3 (build 172). Publish desktop and standalone assets first, then mobile OTA, with App Store submission last.

## v2.8.3 — 桌面优先发布、安装更新与网络可靠性修复（2026-10-21）

- standalone 与桌面安装包先发布到 GitHub Release，官方签名 Android APK 随后追加，移动端不再阻塞桌面发布。
- 改进 standalone 安装与更新、桌面运行环境，以及工作区休眠和任务清理时的 Git 安全检查。
- HTTP、WebSocket、额度查询及语音子进程统一使用出站代理策略，修复 HTTP/2 请求被误判为连接超时。
- 持久化聊天错误信息，改善 CLI 切换、账号选择与额度显示。
- 改善网页与 App 的移动导航、任务列表和批量清理；App 删除请求允许较长的服务端处理时间。
- 事件触发器支持仅执行一次：成功完成后自动停用，编辑规则时保留已触发状态，显式重新启用后可再次执行。
- App 版本更新为 2.36.2（构建 171）；App Store 发布安排在桌面与 OTA 验收之后。

## v2.8.2 — The v2.8.1 changes, recut with the three red CI checks fixed (2026-10-21)

`v2.8.1` published its release assets, but the tag's CI run was red on three
checks that had already been failing before it was cut. `v2.8.2` carries exactly
the `v2.8.1` changes below, plus the three fixes:

- **A runtime root without a declared source** — `scripts/asr-compare/server.js`
  derives its model directory from `~/.multicc/asr-models`, and the write
  inventory had no source anchor for it. The entry now points at the line that
  builds `MODEL_ROOT`.
- **A Swift file over the line budget without a declared ceiling** —
  `scripts/macos-agent/MultiCCAgent.swift` had grown to 3015 lines during the
  remote-access round. It is registered as migration debt at its measured
  ceiling, with the intended split (screen capture / input injection /
  permission probing) written next to it, and the pinned debt list in the budget
  test follows.
- **A directory delete that raced task attribution** —
  `tests/test-session-bundle-api.js` deleted the fixture directory once, after its
  last empty sweep; adoption is asynchronous, so a card could land between the
  sweep and the delete and history disposal would then refuse with
  `TASK_HISTORY_REFERENCED`. The test force-deletes exactly the tasks the refusal
  names and retries, instead of failing on a timing window.

## v2.8.1 — The v2.8.0 changes, cut again with a gate that stops exiting early (2026-10-21)

`v2.8.0` published its tag but never produced release assets: the shared core
gate failed on the same assertion twice, so there was nothing to install behind
the tag. `v2.8.1` carries exactly the v2.8.0 changes below, plus the two gate
fixes that made it fail — both are about waiting on the wrong thing:

- **A timeout the caller is awaiting no longer lets the process walk away** —
  the delegated-refresh wait in `src/claude-auth/account-credentials.js` created
  its 8s `setTimeout` with `unref()`. An unref'd timer is not event-loop work, so
  when that wait was the only thing pending the process exited before the timer
  could fire and the read never settled; `node --test` reports it as "Promise
  resolution is still pending but the event loop has already resolved". It now
  stays referenced — a read that is genuinely in flight may keep the process
  alive for at most `refreshWaitMs`, which is what the caller asked for.
- **A stderr assertion waits for the line instead of reading once** — the
  resident-bridge test awaited `turn/completed` on stdout and then read stderr
  immediately; the two pipes have no ordering between them, so a fast runner
  could see an empty string. It now gives the warning a bounded window.

## v2.8.0 — A quota gate that refuses first, a refresh ladder that stops, and the dsh lane back (2026-10-21)

### Highlights

- **Official accounts get a quota guard in front of them** — `authorizeProxyRequest` now checks the account before it spends a request: when any of the 5h / weekly / monthly windows is at or past its threshold the call is refused with the reason, and Auto's candidate pool skips the same accounts. It is on by default at 98%, scoped by default to `*-official` accounts, treats a stale reading as its lower bound, and never blocks a window that publishes no reset time (`src/quota/quota-guard.js`, `src/routes/quota-guard.js`). Every threshold is yours to set: `quota-guard.json` under the data directory (5s mtime cache, hot reload), `MULTICC_QUOTA_GUARD*` environment overrides, and `GET`/`PUT /api/quota/guard`. The Provider page grows a 额度保护 card (switch, three thresholds, scope) that saves as you edit, mirrored in the App's provider sheet.
- **A refresh ladder that backs off instead of knocking forever** — one account had been retried every twelve minutes for thirteen days, and a three-day window produced 413 identical `claude -p ok` turns. Failures now back off exponentially to a six-hour ceiling, a run of failures — or a single explicit server-side rejection — parks the credential until the credential itself changes, and one expired token gets a small fixed budget of "is it due yet" questions and at most two real turns (`src/claude-auth/oauth-refresh.js`). Failures are classified (rejected / network / unknown) from redacted CLI output instead of being judged by exit code, and the ladder's state is readable through `refresh-health.js`. Claude usage now refreshes only when you ask it to.
- **The dsh lane works again** — dsh-base removed the synchronous `session.events` read, so the vendored runner threw "not iterable" *after* the answer had already streamed, turning every dsh turn into an error. The runner feature-detects `session.snapshotEvents(fromSeq)` and falls back to `ownEvents()`/`events`, and profiles re-provision themselves (`DSH_PROFILE_VERSION` 3). The web client no longer re-filters the server's `compatibleClis` through a stale whitelist, so dsh and grok keep their line dropdowns and no longer show "no usable route".
- **Chinese can be typed into the Air console search** — every keystroke rebuilt the whole console page, which silently ended the input-method composition, so pinyin never became characters. Rebuilds are now deferred while a composition is open and replayed once on `compositionend`, on the overview, the all-tasks and the mobile recent lists alike.
- **Smaller things** — the 服务与文档 group headers collapse and expand (with expand/collapse-all), and the App's remote screen gains a touch controller with direct and trackpad modes (slip-tolerant left-button drag, two-finger scroll, two-finger tap for right click, hold-then-drag in trackpad mode).

### Release tier

- Core grew to 337 entries. The new gates are the quota guard pair (`tests/test-quota-guard.js`, `tests/test-quota-guard-routes.js`), `tests/test-claude-refresh-park.js` (a fake CLI in a temp dir, no network), `tests/test-official-egress-per-account.js` and the App's `remote_touch_controller_test.dart`; none of them touches a real account or device.

## v2.7.1 — The v2.7.0 changes, cut again with a green release gate (2026-10-20)

`v2.7.0` published its tag but never produced release assets: the shared core
gate caught `tests/test-cli-switch-api.js` still assuming a fork stays a plain
fleet session, and that job blocks asset creation, so there is nothing to
install behind the tag. `v2.7.1` carries exactly the v2.7.0 changes below, with
the release gates fixed:

- **A fork is a task-bound room now** — task-first adopts every chat record onto
  the board, so the CLI-switch integration asserts the human-shaped fleet and
  workspace projections keep the adopted fork out (and their wire bounded),
  then disposes its card before the directory goes.
- **Handoff teardown follows the live board** — the session-bundle integration
  swept a `task_board.json` snapshot that can lag the Air producer, so a card
  adopted mid-teardown blocked the directory delete; it now sweeps
  `/api/air` until nothing is left to release.
- **The Air sync push test waits for its frames** — the delta/reset assertions
  read the socket immediately after `flush()`; they now give the pushed frame a
  bounded window instead of assuming one event-loop turn is enough.

## v2.7.0 — Air keeps one source of truth, and every request follows your proxy (2026-10-20)

### Highlights

- **Air has one producer and an incremental sync channel** — the `/api/air` snapshot used to be rebuilt per request from the task board, Git and ownership queries, and roughly seven of ten rounds still ended in a 304 after all that work. A single runtime now owns the data, publishes per-card deltas over a revisioned read index (`src/workspace/air-sync-runtime.js`, `src/workspace/air-read-index.js`, `src/workspace/air-card-cache.js`), and reconciles periodically as a safety net. Web and the App subscribe to the same event stream instead of polling the whole snapshot: the web gains `public/air-sync.js`, and the App's console, directories and task lists all read from a shared `AirSyncService`/`AirSyncStore`.
- **Every outbound request goes through your proxy** — MultiCC now installs a process-wide proxy from the explicit environment first and the macOS system settings otherwise (`src/network/global-proxy.js`, over Node's own `http.setGlobalProxyFromEnv`), so provider calls, updates and downloads stop bypassing a proxy the user configured; loopback addresses and the system exceptions list stay direct, keeping local CLI traffic on the machine.
- **Model requests get a real budget, and stalls recover instead of hanging** — the timeout only starts once an upstream inference request is admitted (never counting tool execution or queue waits), connection establishment and stream progress are watched separately via Node diagnostics channels, and a stalled or timed-out turn is recovered from the current attempt's evidence without being mislabelled as a user cancel (`src/chat/model-request-policy.js`, `src/providers/model-connect-watch.js`, `src/providers/model-stream-progress.js`, `src/chat/model-timeout-recovery.js`).
- **A new `pi` CLI lane** — `src/cli-adapters/pi.js` drives pi through a bundled router extension, with thinking levels and the same completion/error contracts as the other lanes.

## v2.6.4 — Uncommitted files are readable from the phone, and H.264 taps land where you aim (2026-10-19)

### Highlights

- **The uncommitted files of a main checkout open as a diff sheet on the phone** — tapping a dirty file in the Air workspace card shows that file's working-tree diff against HEAD (an untracked file reads as one whole addition), which is the mobile counterpart of the web directory page's "tap a filename to see the change". The list and the diff come from the same two endpoints the web uses (`/api/git/directory-status`, `/api/git/directory-file-diff`), and session worktrees stay filtered out server-side (`app/lib/widgets/air/air_dirty_files_sheet.dart`, `app/lib/services/session_service.dart`).
- **Remote-screen taps land where you aim on the H.264 channel** — the native decoder caps the decoded width at 1280 (1470×956 becomes 1280×832) while the agent reads pointer coordinates in encoded/logical points, so every click used to drift up-left; the App now scales the coordinate back into the encoded domain before sending it (`app/lib/services/remote_screen_h264.dart`).

### Internal

- `server.js` is back inside the 3000-line budget after the secret-tools wiring pushed it to 3002; the release gate that caught it (`test-source-line-budget`) is green again.

## v2.6.3 — A vault that reaches live sessions, a voice that learns its words (2026-10-18)

### Highlights

- **A secret added mid-session reaches the running CLI at the next turn** — a resident process fixes its environment at spawn, so the chat stream, the Claude Agent SDK lane and the codex app-server now recycle at the turn boundary when a vault entry changed (resuming the conversation), while never restarting when nothing changed and never refusing a turn that a background task is still holding. Vault names are now required to be real env identifiers (`[A-Za-z_][A-Za-z0-9_]*`) so an entry can actually be injected, with the old laxer names kept loadable/lookup-able so legacy entries can still be deleted or renamed instead of silently dropped (`src/secrets-vault.js`, `src/chat/chat-stream*.js`, `src/voice/host.js`).
- **Tool requests can carry a secret without ever printing it** — `{{secret:NAME}}` placeholders are resolved inside the request and the value is redacted from anything written back, so an API call can be described in a task without the key entering the transcript (`src/secret-tools.js`).
- **Voice learns the words it keeps getting wrong** — every correction (raw transcript → what the user actually sent) is diffed, and distinctive identifiers from the user's own messages become candidates; a fix only becomes an active hotword after being seen twice, and a pair is vetoed outright when it would rewrite normal prose (`src/voice/hotword-miner.js`, `hotword-learner.js`, `hotword-corrector.js`). The App gains a voice setup panel and composer that follow the same readiness report as the web.
- **A task can suggest its own directory, and the user still decides** — the attribution decision now carries a `directoryHint` suggestion; the client shows a card and only a tap calls the task-level relocate, never an automatic move (`src/task-shell/attribution-decisions.js`, `app/lib/services/task_directory_hint.dart`, `app/lib/widgets/task_directory_hint_prompt.dart`).
- **The Air console is rebuilt around ordering and to-dos** — manual task order, ignored "to-do" entries and the richer per-task cards land in the console on both web and App (`public/air.js`, `app/lib/widgets/air/air_console.dart`, `src/workspace/todo-ignores.js`).

### Release tier

- Core grew to 328 entries (279 deterministic, 26 isolated, 23 non-UI Flutter). Four vault tests were previously unclassified and are now pinned: three drive the turn-boundary recycle by injection (no spawn, no server) and one starts a real SDK child against a fake upstream; `tests/test-secret-tools.js` only uses an in-process 127.0.0.1:0 server and `.example.com` strings.

## v2.6.2 — Live model lists, a talking liveness pill, and HD remote screens (2026-10-18)

### Highlights

- **Model pickers read the CLI's own catalogue instead of a hardcoded table** — Command Code and Grok now list whatever `--list-models` / `models` reports, so a model that disappears upstream disappears from the picker, and a new one shows up without a release. Command Code's vendor grouping is carried through, the surrounding non-model chatter is ignored, and the headless-only section is dropped; an unauthenticated Grok list is served but never cached (`src/routes/commandcode-models.js`, `src/routes/grok-models.js`, `app/lib/services/live_model_catalog.dart`, `public/shared/models.js`). Both the run-config sheet and the App's session dialog share the same searchable menu (`app/lib/widgets/model_menu.dart`).
- **The liveness pill says what the turn is doing** — the per-lane turn timeline now exposes a stage (requesting / thinking / output / running tool) plus how long it has been silent, so the pill distinguishes "waiting on the model" from "stuck" instead of showing one opaque "Working". Lanes that never stream partials (codex-style) mark the stage imprecise rather than claiming a pure network wait (`src/chat/turn-timeline.js`, `src/liveness/runtime.js`, `app/lib/utils/session_status_helpers.dart`).
- **A deleted task stops pretending to reconnect** — when the session behind a task is gone, the App stops its reconnect loop and shows a "this task was deleted" notice instead of spinning on "Connecting…" forever (`app/lib/services/chat_service.dart`, `app/lib/widgets/chat_session_gone_banner.dart`).
- **Remote screen gets an HD/Smooth switch** — the phone can pick the H.264 live stream (sharper, lighter) or the compatibility RFB path with a local cursor, and the macOS agent's H.264 encoder was adjusted to match (`public/chat-remote-screen-h264.js`, `app/lib/services/platform_h264_decoder.dart`, `scripts/macos-agent/MultiCCAgentH264.swift`).
- **Session creation and the Air console fill in** — the create-session dialog picks up the live catalogues for CodeBuddy / Command Code / Grok with a filter, and the Air workspace card, task actions and mobile navigation gained the remaining detail views (`app/lib/widgets/create_session_dialog.dart`, `app/lib/widgets/air/air_workspace_card.dart`, `app/lib/widgets/air/air_task_actions.dart`).

### Release tier

- The reviewed core set grew to 318 entries (271 deterministic, 25 isolated, 22 non-UI Flutter) with `tests/test-commandcode-grok-models-route.js`: pure parsing of a captured `--list-models` output plus fake-CLI catalogues in a temp dir, no network and no real account.

## v2.6.1 — A to-do lens on tasks, the mobile directory tab, and hook fixes (2026-10-17)

### Highlights

- **The task list grows a "to do" lens** — a task can be marked as to-do by hand and filtered to that state, on the web task list and in the App's Air console alike; the same three state chips drive both surfaces, so a task marked on the phone reads the same on the desktop (`public/air-admin.js`, `app/lib/widgets/air_task_details.dart`, `app/lib/widgets/air_tasks_view.dart`).
- **Phones get the directory tab back** — the mobile bottom bar restores 工作目录 as its fourth entry and the directory home highlights it, instead of leaving "recent tasks" as the only way back to a project (`app/lib/widgets/air/air_mobile_shell.dart`, `public/air-mobile.js`).
- **A brand-new task no longer hides from the mobile recent list** — the mobile workspace request now carries the same recency ordering the desktop list uses, so a task created a second ago appears at the top instead of being pushed out by older ones (`src/workspace/air-routes.js`).
- **Hooks fired into a task session are no longer dropped silently** — an event action targeting a task now injects into that task's shell session (the shell runtime accepts the same injection the chat host does), and the chat header's hook button can open the rule it fired for editing (`src/events/actions.js`, `src/task-shell/runtime.js`, `public/chat-hooks.js`).
- **Artifacts stay attached to the turn that produced them** — retention now keeps a turn's artifact links together instead of letting a later cleanup orphan them, and the docs/task pages group them accordingly (`src/artifact-retention.js`, `public/task-artifacts.js`).
- **The Claude Agent SDK is pinned to 0.3.301** — the dependency is pinned rather than floated so a release build cannot pick up an upstream SDK revision that changed streaming behaviour (`package.json`).

## v2.6.0 — API-key accounts, per-plan Codex quota windows, and one-shot Esc (2026-10-16)

### Highlights

- **Keep several API keys per CLI and pick one per session** — CLIs that authenticate with a plain key rather than an OAuth login (Command Code, and OpenCode's own `opencode.ai` Zen/Go lines) can now hold a named list of accounts, and each session picks one per lane (`session.cliAccounts`). The key reaches only the spawned child — never the CLI's global files — so a session without a pick keeps the CLI's own login exactly as before (`src/cli-key-accounts.js`, `src/routes/cli-key-accounts.js`).
- **The Codex quota bar reads the real windows, not the slot names** — `chatgpt.com`'s usage endpoint names its windows `primary`/`secondary`, but which cycle each holds is plan-dependent (Plus puts the 5h window in primary; prolite has only a weekly one). The windows are now classified by their actual length into 5h / 1wk / 1m, and the same classifier drives both the turn-boundary poller and the click-to-refresh route so the passive and clicked bars can never disagree (`src/codex/rate-limit-windows.js`, `src/quota/quota-bar-view.js`).
- **A Claude OAuth 401 recovers without replaying the turn** — the host now stages the first authentication rejection, refreshes the credential, and re-runs the original handler; a successful stream is never cached, so neither the turn nor its tool calls replay (`src/claude-auth/proxy-recovery.js`).
- **Event triggers can spawn a fresh session** — a rule action gains `newSession` (dir / CLI / title) to create a new chat session per firing instead of reusing one, and the App's trigger screen follows (`src/events/rules.js`).
- **One Esc is one cancel, not a latched halt** — the macOS agent used to latch a halt that blocked every later computer-use call until a manual resume; a halt now clears when the interrupted operation ends (or at the next dispatch if nothing was in flight) (`scripts/macos-agent/MultiCCAgent.swift`).
- **The App's background-task board and hook editor grow up** — the task board renders richer per-task state, and the trigger/hook editor gains full create/edit/test coverage with matching tests (`app/lib/models/background_task_board.dart`, `app/lib/widgets/hook_list_view.dart`).

## v2.5.2 — Event triggers, a clearer re-login path, and a human-handoff README (2026-10-14)

### Highlights

- **Event triggers (hooks) turn "when X happens, do Y" into a rule** — a new events engine (`src/events/`) watches catalogued events (turn finished, task transition, schedule, push, …), evaluates rules against a fixed envelope, and runs actions (notify, dispatch, run a session turn). One shared form drives both entry points — the 🪝 button in a chat header (scoped to that session) and the **Triggers** tab in the schedule center (global or a specific session) — so the form, validation and "test" flow can't drift (`public/hook-editor.js`, `public/air-trigger-center.js`, `public/chat-hooks.js`).
- **The same triggers live in the App** — the schedule screen gains a **Trigger tasks** tab that mirrors the web trigger center: list global + per-session rules, create/edit in a bottom sheet, and test them (`app/lib/widgets/hook_list_view.dart`, `app/lib/services/event_trigger_service.dart`).
- **A 401 now tells you where to fix it** — an authentication failure points at the **model lines** panel to sign in again, and the panel grows a re-login button for official lines that were logged in from the terminal (`claude-official` / `codex-official`) and previously had no re-login entry at all (`0534b70b`, `24a1cc95`).
- **The macOS agent stops mistaking its own events for a human** — events the agent posts itself no longer count as human input, so an automation no longer pauses against itself during a drag or key hold (`scripts/macos-agent/MultiCCAgent.swift`).
- **README leads with the human-handoff workflow** — the intro and a new "Step in, then let the agent continue" section explain the assign → help-request → take-over → continue loop (with the platform support matrix), instead of burying it below the feature list (`README.md`, `README.zh.md`).
- **App icons are regenerated from the branding SVG** — the icon generator's background-strip regex still matched the old 1024 background rect and threw against the current 512-viewBox SVG, so it could not run at all; it now matches any `fill=url(#bg)` rect and every iOS/Android launcher slot is rasterised from the single agent-chips source again (`scripts/generate-app-icons.js`).

## v2.5.1 — Session doctor, faster chat search, and a run-config cleanup (2026-10-13)

### Highlights

- **The Session Doctor diagnoses a stuck chat for you** — a "diagnose" action spins up a small tool-using model agent (independent of any CLI session, running through the Aux HTTP target) that snapshots a misbehaving session, forms hypotheses, and confirms each with real evidence (`session_info`, `chat_tail`, log tails, `git status/log`, `ps/lsof`) before believing it. Read-only by default; an autofix mode makes the smallest reversible fix and re-checks. A confirmed-but-unsolvable case drafts a GitHub issue for you to submit — nothing is posted automatically (`src/doctor/*`, `public/chat-doctor.js`).
- **Chat search gets a slice runner and a bigger corpus** — the message corpus is rebuilt to index far more history, search runs in bounded slices instead of one full pass, and the runtime streams results so a large workspace stays responsive (`src/search/message-corpus.js`, `src/search/slice-runner.js`, `src/search/runtime.js`).
- **Run-config presets show their names** — the auto-route pill now prints the preset name it came from (matched against machine-saved presets by exact route-pool identity), and the picker keeps scroll position, accepts Enter inline for the preset name, and gains per-preset delete; IME submissions no longer misfire (`public/run-config.js`, `public/run-config.css`).
- **Egress-IP routing refines** — the egress allowlist policy is reworked to cover more provider shapes with clearer diagnostics (`src/providers/egress-ip.js`).
- **The openrouter-usage demo service is removed** — the MacroMicro-token demo page and its daily fetch job no longer ship; `.gitignore` and `whisper_vocab.json` housekeeping follow.

## v2.5.0 — Visible Codex sub-agents, native background progress, and mobile fleet control (2026-10-12)

### Highlights

- **Codex sub-agents show up as real tools** — `collabAgentToolCall` items are no longer invisible: the timeline now renders agent orchestration steps (spawn/wait/send-input/close-agent/follow-up) as `tool_start` … `tool_result` entries with per-agent states, so a turn that forks into sub-agents reads like the Bash/tool calls next to it (`src/cli-adapters/codex-exp.js`).
- **Native Codex background tasks report live progress** — a native background thread now streams its tool labels, running status and completion back instead of staying a black box; the CLI's own result delivery wakes the main Agent once, avoiding duplicate wake-ups (`src/cli-adapters/codex-background-events.cjs`, `src/chat/native-background-tasks.js`).
- **CLI switching stops recycling dead native sessions** — before reusing a remembered stream/cli session id, MultiCC probes the target CLI's real store (claude/claude-exp/opencode/composio layout), and a definitely-gone id is dropped on the spot. Reusing a pruned id used to make the CLI silently start a new session that the turn engine then rejected as `cli_resume_mismatch` (`src/cli/native-session-exists.js`, `src/cli-switch.js`).
- **The macOS agent lets you watch the room** — typed input from the human automatically suspends an ongoing automation with a visible countdown HUD, then resumes once you stop; automation now also supports drag gestures on one private event source (`scripts/macos-agent/MultiCCAgent.swift`).
- **Mobile fleet management lands in the App** — the Air task list grows a *switch server* entry that flips the whole App to another remembered host (reconnecting the shell, leaving server-side tasks untouched), and settings are reorganised into named panels with a back affordance; a new mobile Air shell/workspace renders the fleet for phones (`app/lib/widgets/air/air_mobile_shell.dart`, `app/lib/widgets/server_switch_dialog.dart`, `app/lib/screens/air_settings_screen.dart`).
- **Air gets a mobile layout and a setup nudge** — the web dashboard gains a phone-first navigation layout and a 3-step onboarding card (provider → account → project) that dismisses only when real work is configured (`public/air-mobile.js`, `public/air-navigation.js`, `public/air-onboarding.js`).
- **Desktop packages are verified before shipping** — a new after-pack hook (and a CI re-check after packaging) resolves every packaged server dependency inside the built Resources tree, so a staging that skipped `node_modules` no longer slips into the installer silently (`scripts/desktop-verify-resources.js`, `desktop/after-pack.js`).

## v2.4.3 — Compressed snapshots and fewer dead ends (2026-10-11)

### Highlights

- **API responses are gzipped** — `/api/*` JSON now honors `Accept-Encoding`, shrinking the payloads that hurt most on a tunneled phone connection: an `/api/air` snapshot drops from ~900KB to ~115KB and `/api/providers` from ~33KB to ~6KB, so one snapshot no longer saturates the tunnel while the run-config read/save queues behind it (`src/http/json-compression.js`). Streaming, SSE and already-encoded pass-throughs are untouched.
- **Local images with non-ASCII names render again** — markdown image paths are percent-encoded twice (renderer + query string), which made `![](/Users/…/中文.png)` 404. The download route now retries once with the escapes decoded when the literal path misses (`src/routes/file-transfer.js`), and the bundled `multicc-local-resource` skill documents the workaround for older servers.
- **Old Codex threads stop failing on strict upstreams** — a `web_search_call` recorded before the `queries` field existed made every replayed turn fail with a deterministic 422 ("missing field `queries`") on strict third-party Responses upstreams such as DeepSeek. The converter now fills `queries` from the recorded single query (`src/model-history-converter.js`).
- **Cached quota bars keep counting down** — a bar persisted by a server that predates the `|<window>` countdown half used to stick on the bare word "已重置" after its deadline passed; the renderer now reads the window back out of the label the token follows, and the same fix ships in the App with a frozen golden fixture (`public/quota-bar-view.js`, `app/lib/models/quota_bar_view.dart`).
- **The App's run-config sheet opens faster** — when the lane is already known, the session-runtime and provider-pool requests run in parallel instead of serially, halving the round trips a tunneled open used to pay (`app/lib/widgets/run_config/run_config_sheet.dart`).
- **CI stops tripping over its own scripts** — the Linux-agent workflow invokes `verify.sh` via `bash` so a lost exec bit can't red a release again (7db80b08), and the service-routes skeleton shimmer now animates `transform` instead of `background-position`, keeping every perpetual animation on compositor-only properties (`public/service-routes.css`).

## v2.4.2 — A Linux agent and quieter permissions (2026-10-09)

### Highlights

- **Remote control reaches Linux** — a first Linux desktop agent (`scripts/linux-agent`, a small C program over X11/XTest) drives the same human-assist remote screen on Linux hosts, with an Xvfb conformance suite in CI that runs whenever the agent source changes. The cross-platform contract is now written down in `docs/desktop-agent-protocol.md`.
- **Login terminals no longer need a git-friendly directory** — the interactive `codex login` / `claude auth login` terminal used to create a git worktree inside your session directory, which failed outright when that directory lives in a macOS protected location (Desktop/Documents/Downloads/iCloud) with a confusing "git cannot access this directory" error. Login terminals are now gitless and work under MultiCC's own `~/.multicc/login-workspaces/`, independent of where your sessions live.
- **Input monitoring is no longer a required permission** — the macOS agent no longer requests "Input Monitoring" (it only ever served the optional Esc halt; typing goes through Accessibility). Stopping local automation now uses the chat's existing ■ stop button, and Esc remains available as a bonus when you had already granted it.
- **Revoked official credentials stop burning retries** — when an official Claude account's credentials are revoked, the lane no longer retries the 401 forever; it parks the alias onto the specific dead account so the failure is visible and other accounts keep serving (f20888c6).
- **Remote-screen links open in place** — `#rs=control` links in chat no longer navigate away from the conversation (a `<base href="/">` quirk); they open the remote screen overlay in place, with right-click/⌘-click as the escape hatch to a real tab (`public/chat-remote-links.js`).
- **Battery and host power, visible in Air** — lid state, power source and battery telemetry from the host land in a dedicated Air panel (`public/air-battery.js`, `src/host-battery.js`), alongside the service-routes management page gaining its own UI.

## v2.4.1 — A crash fix and a sharper remote screen (2026-10-06)

### Highlights

- **Voice PCM alignment crash fixed** — a frame that was not a whole number of samples could crash the voice path; frames are now aligned before processing (5465d88e).
- **Region zoom stays sharp on the remote screen** — a box-zoomed area is now cropped from the source capture before compression instead of enlarging the already-compressed stream, so the enlarged region keeps its original detail (`src/remote-screen-rfb-bridge.js`, agent-side capture changes).
- **#rs deep links land in the App** — human-assist remote-screen links now route natively in the App (skill v1.3.0), and the browser keeps running in the background while reusing the account profile you already signed into.
- **iOS keeps moving toward the store** — a new demo mode (an in-process loopback server with demo data) lets the App pass review without any real host, and the App Store workflow produces an unsigned archive when signing secrets are not configured.

## v2.4.0 — Local speech recognition that installs itself (2026-10-05)

### Highlights

- **One-click local ASR models** — the voice settings panel grows a "Local model" group with a live progress bar: one click downloads the SenseVoice weights (~229MB) and the silero VAD, so on-device dictation no longer requires a shell. Progress and failures ride on `GET /api/settings/voice`, and a stuck download can be cancelled or retried in place (`POST /api/settings/voice/asr-model`).
- **First-boot background download** — on a machine that has never held the weights, the server fetches them in the background eight seconds after boot (unref'd, re-checking every gate), so local ASR is simply ready the first time you reach for the microphone. Set `ASR_LOCAL_AUTO_DOWNLOAD=off` to opt out.
- **Machines that cannot load the addon are told so up front** — the panel now probes whether the sherpa-onnx native addon can actually load before offering anything; unsupported machines show a plain explanation instead of a download button that would fetch 229MB of weights the process could never use, and the boot hook skips them too.
- **The offline script ships in the box** — `scripts/setup-local-asr.sh` is now staged into the standalone bundle (`app-server/scripts/`), with a sanity-gate assertion in the bundle builder, so an air-gapped install can still pull the models through a mirror of your choosing.

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
