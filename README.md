<p align="center">
  <img src="public/icon.svg" width="120" height="120" alt="MultiCC Logo" />
</p>

<h1 align="center">MultiCC</h1>

<p align="center">
  <strong>Keep agents working. Step in from your phone when they need you.</strong>
</p>

<p align="center">
  <em>A self-hosted workspace for coding agents: assign tasks, follow progress, and take over a desktop step when needed.<br/>
  Reply when you're done, and let the agent continue in the same task.</em>
</p>

<p align="center">
  <a href="#step-in-then-let-the-agent-continue">Human handoff</a> &bull;
  <a href="#download-multicc"><strong>Downloads</strong></a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#what-else-it-does">Features</a> &bull;
  <a href="#documentation">Docs</a> &bull;
  <a href="#how-multicc-compares">Comparison</a> &bull;
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/lsjwzh/MultiCC?label=latest%20release" alt="Latest Release" />
  <img src="https://img.shields.io/badge/node-%3E%3D22.16-brightgreen" alt="Node.js >=22.16" />
  <img src="https://img.shields.io/badge/CLIs-claude%20%7C%20codex%20%7C%20opencode%20%7C%20zcode%20%7C%20kimi%20%7C%20qoder%20%7C%20workbuddy%20%7C%20dsh%20%7C%20gemini%20%7C%20commandcode%20%7C%20grok%20%7C%20pi-8A2BE2" alt="Supported CLIs" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/flutter-Android%20%7C%20iOS-02569B" alt="Flutter app" />
  <img src="https://img.shields.io/badge/desktop-macOS%20%7C%20Windows%20%7C%20Linux-47848F" alt="Desktop app (Electron)" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
</p>



---

## Download MultiCC

**Prefer a desktop app? Download an installer below, then open MultiCC to start working.** The desktop app includes the server and interface; no separate Node.js installation is needed.

### Desktop app

| System | Device | Installer |
|---|---|---|
| macOS 13+ | Apple silicon (M1 / M2 / M3 / M4 and later) | [Download DMG](https://github.com/lsjwzh/MultiCC/releases/download/v2.12.0/multicc-desktop-2.12.0-macos-arm64.dmg) |
| macOS 13+ | Intel | [Download DMG](https://github.com/lsjwzh/MultiCC/releases/download/v2.12.0/multicc-desktop-2.12.0-macos-x64.dmg) |
| Windows | 64-bit Intel / AMD | [Download installer](https://github.com/lsjwzh/MultiCC/releases/download/v2.12.0/multicc-desktop-2.12.0-windows-x64.exe) |
| Linux | 64-bit Intel / AMD, general distributions | [Download AppImage](https://github.com/lsjwzh/MultiCC/releases/download/v2.12.0/multicc-desktop-2.12.0-linux-x64.AppImage) |
| Linux | 64-bit Intel / AMD, Debian / Ubuntu | [Download DEB](https://github.com/lsjwzh/MultiCC/releases/download/v2.12.0/multicc-desktop-2.12.0-linux-x64.deb) |

### Mobile app

The mobile app connects to your own MultiCC server. Install the desktop app or standalone server on your computer or server first.

| System | Download |
|---|---|
| Android | [Official signed APK](https://github.com/lsjwzh/MultiCC/releases/download/v2.12.0/multicc.apk) |
| iPhone / iPad | [App Store](https://apps.apple.com/app/id6807642727) (availability follows Apple review) |

<details>
<summary>Standalone server downloads (servers, terminal users, macOS 11–12)</summary>

Standalone packages include Node.js. Use the [one-line installer](#quick-start) or download a package directly:

| System | Architecture | Package |
|---|---|---|
| macOS 11+ | Apple silicon | [Download](https://github.com/lsjwzh/MultiCC/releases/download/v2.12.0/multicc-standalone-2.12.0-darwin-arm64.tar.gz) |
| macOS 11+ | Intel | [Download](https://github.com/lsjwzh/MultiCC/releases/download/v2.12.0/multicc-standalone-2.12.0-darwin-x64.tar.gz) |
| Linux | x64 | [Download](https://github.com/lsjwzh/MultiCC/releases/download/v2.12.0/multicc-standalone-2.12.0-linux-x64.tar.gz) |
| Linux | ARM64 | [Download](https://github.com/lsjwzh/MultiCC/releases/download/v2.12.0/multicc-standalone-2.12.0-linux-arm64.tar.gz) |
| Windows | x64 | [Download](https://github.com/lsjwzh/MultiCC/releases/download/v2.12.0/multicc-standalone-2.12.0-win32-x64.zip) |

</details>

Desktop and standalone version: **v2.12.0**. See [Releases](https://github.com/lsjwzh/MultiCC/releases) for checksums, signing information, and older versions; [download SHA256SUMS.txt](https://github.com/lsjwzh/MultiCC/releases/download/v2.12.0/SHA256SUMS.txt). [Desktop installation guide](docs/desktop.md).

## Step in, then let the agent continue

A task can reach a step that needs you: a sign-in confirmation, a visual decision, or a desktop interaction. MultiCC brings the task and the host's screen into the same conversation, accessible from your computer or phone.

1. **Give the agent a task.** It works in a task-bound conversation; code changes have their own Git worktree.
2. **Get a specific request for help.** The agent explains what is blocked and can provide a remote-control link or a screenshot to annotate.
3. **Handle that step.** Open the host's screen from the chat, click or type as needed, then close the controls and reply that you're done.
4. **Continue to a result.** The agent checks the new state and carries on with the same task. Review its output and, for code changes, the diff and relevant checks.

Remote desktop control requires a desktop agent on the host and its OS permissions. macOS uses MultiCC Agent; Linux requires X11 and its agent. Windows desktop control and Wayland are not currently supported. The host and MultiCC service must remain running, and your phone needs an authenticated LAN or tunnel connection. **Reply in the chat after completing the desktop action to let the agent continue.**

**→ [Getting started](#quick-start) · [Human-assistance workflow](skills/multicc-human-assist/SKILL.md) · [Host setup and permissions](skills/multicc-computer-use/SKILL.md)**

## Choose how to work

| When you need to… | MultiCC gives you… |
|---|---|
| Step away from your desk | The same task on the web or mobile app, with notifications and remote desktop access on supported hosts |
| Work on several changes | Separate task worktrees, visible diffs, and a merge workflow with syntax checks; conflicts still need resolution |
| Ask another coding agent to continue | In-place engine switching, with the same task and worktree plus a visible handoff checkpoint |
| Wait for a build or external result | Background commands, scheduled tasks, and registered waits that return results to the conversation |

Supported engines include **Claude Code, Codex, OpenCode, ZCode, Kimi Code, Qoder, WorkBuddy, DSH, Gemini CLI, Command Code, Grok, and pi**. Provider and model controls, subagent routing, memory, voice, and IM bridges support these workflows; see the [feature catalogue](docs/features.md).

<a id="the-headline-one-chat-eight-clis"></a>

## Keep the task when you switch engines

You are three hours into a refactor with Claude Code. You want a second opinion from Codex, or your Anthropic quota just ran out, or GLM is simply cheaper for the next mechanical stretch.

Normally that means a new terminal, a new session, and re-explaining everything.

In MultiCC it is one click. The **conversation** is yours; the CLI is just the engine currently driving it.

```text
Task + conversation + Git worktree
                 │
     visible handoff checkpoint
                 │
     choose a supported CLI engine
                 │
     continue in the same task
```

<details>
<summary>How engine handoff works</summary>

### What actually carries over

MultiCC does **not** try to translate one vendor's transcript into another's format. That is lossy in ways you cannot audit. Instead it preserves **native sessions where the CLI supports them**. Continuity between engines is an explicit, bounded, **visible-text checkpoint**:

| ✅ Carried over | ❌ Not carried over |
|---|---|
| Up to 16 recent messages / 12 000 chars of visible transcript | The source CLI's hidden internal state |
| Task state — goal, phase, latest summary | The other vendor's system prompt or cached reasoning |
| Git snapshot — HEAD, branch, working-tree changes | Anything the source CLI never printed |
| Your working directory and git worktree (unchanged) | |

The receiving CLI is told, in the prompt, not to pretend otherwise:

> *Continue the current user request using this checkpoint. Do not claim access to the source CLI's hidden state.*

### Switch back and it picks up where it left off

Each CLI remembers its own native session id, model, effort, provider and subagent routing. Claude → Codex → Claude returns you to **the Claude conversation that already exists**, brought up to date with a fresh checkpoint — not a blank slate. Pass `fresh: true` when you *want* the clean slate.

Clearing a chat invalidates **all** native sessions, so a switch can never resurrect context you deliberately discarded.

### Missing a CLI? Install it from the switcher

The picker shows installed engines and saved sessions, with installation actions where available. ZCode ships inside its desktop app. Engine-specific login, model, and provider support varies; use the options shown for the selected CLI.

**→ Full details: [Multi-CLI switching](docs/cli-switching.md)**

</details>

> Multi-CLI switching applies to **chat** sessions. Terminal sessions stay pinned to the CLI they were created with.

---

## The Air console

The screenshots below were refreshed from the v2.9.3 source on 2026-10-24. They show the current web UI with isolated example data, not live task results or real account activity. The phone image is responsive web UI, not the Flutter app. See [capture details](docs/images/README.md).

`/air` is MultiCC's home screen — both `/` and the old `/manage` now redirect there. Tasks, not roles, are the unit of work: you describe what you want done, and each task carries its own bound session, worktree, and transcript.

![The Air console: directories and tasks at a glance](docs/images/en/air-tasks.png)

- **Directory home** — every registered repo with its tasks and sessions in one list
- **New-task composer** — describe a goal, pick a CLI / line / model (it remembers your last choice), and the task spins up a bound session
- **Full-history search** — search task titles and excerpts, or include complete conversation history with ranked, highlighted matches
- **Fast directory switching** — use the workspace selector or ⌘K / Ctrl+K, and drag directories into a persistent order
- **Native control center** — providers, official accounts, relay connections, workspace reclamation, schedules, AI Assistant, and host operations all live in Air
- **Delivery state at a glance** — task rows show worktrees with uncommitted changes or commits still waiting to merge
- **Code and worktrees** — one directory card shows Git status and workspace lifecycle; task filters, ordering, and pagination stay beside the list
- **Scheduled tasks** — cron-style recurring work bound to fixed Air tasks
- **Task pins** — pin up to five tasks to the header tab row (sidebar top on mobile and in the app)
- **Input target** — see and switch which task your next message lands in from the full-history index (the ◎ marker); in-flight turns stay durably queued
- **Attribution controls** — accept or reject the AI Assistant's task suggestion inline, re-attribute a whole turn by hand, or split it into a durable independent continuation

**→ First run, task graph, memory graph, console pages: [Features](docs/features.md)**

---

## Why people run it

| | |
|---|---|
| 🔄 **Not locked to one vendor** | Quota exhausted, model deprecated, or a task better suited to another engine — switch instead of starting over. |
| 🧵 **Real parallelism** | Each session gets its own git worktree on branch `multicc/<sessionId>`. Code changes stay separate until you review and merge them through a syntax-gated API; overlapping changes can still conflict. |
| 💸 **Cheap subagents** | Main agent on a frontier model, subagents routed to DeepSeek / GLM / Qwen through a local provider router. Choose models for each role and inspect their actual usage. |
| 📱 **Sessions outlive the client** | Reconnect from your phone while the host and service remain running. Terminal sessions live in `tmux`, chat sessions as stateful turns. |
| 🗣️ **Voice, including full duplex** | Dictate prompts, or hold a real-time speech-to-speech conversation with your agent while your hands are busy. |
| 🔔 **It finds you** | Web Push, Bark, webhooks, and bridges to WeChat, Feishu, Telegram, Discord and Slack. |

---

## Quick Start

### 1. Install

```bash
# macOS / Linux
curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v2.12.0/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/lsjwzh/MultiCC/v2.12.0/install.ps1 | iex
```

One line, no flags: the tag in the URL *is* the version. The script downloads that
release's **standalone package** — the server plus a pinned Node runtime plus every
production dependency, in one archive — verifies its SHA-256, installs it at the
stable `~/MultiCC` path (`%USERPROFILE%\MultiCC` on Windows), clears macOS download quarantine, generates an
`ACCESS_TOKEN`, starts the service and opens the browser, and optionally registers
a login service (macOS `launchd` / Linux systemd user / Windows Startup). The UI is ready when
the command returns. Nothing is compiled, and **the target machine needs no Node,
npm, Homebrew or Xcode**. MultiCC does require a working `git` at runtime because
every session gets its own worktree; the installer checks it and prints the shortest
platform-specific fix when it is missing.

<details>
<summary>Install options, and building from source</summary>

```bash
# Install somewhere else (default ~/MultiCC), or skip the auto-start question
curl -sSL .../install.sh | bash -s -- --dir /opt/multicc --no-service

# Always the newest release, instead of the tag in the URL
curl -sSL .../install.sh | bash -s -- --version latest

# From a package you already downloaded
curl -sSL .../install.sh | bash -s -- --from ./multicc-standalone-2.12.0-darwin-arm64.tar.gz

# Server/automation installs: install without starting, or start without a browser
curl -sSL .../install.sh | bash -s -- --no-start
curl -sSL .../install.sh | bash -s -- --no-open

# Coming from an installation that predates the standalone package, somewhere else
# on this machine (the oldest installers put it wherever they were run from)
curl -sSL .../install.sh | bash -s -- --adopt-data "$HOME/MultiCC"
```

Windows exposes the same choices as PowerShell parameters (`-InstallDir`,
`-Version`, `-From`, `-AccessToken`, `-Port`, `-Yes`, `-NoData`, `-AdoptData`,
`-NoService`, `-NoStart`, `-NoOpen`). Download `install.ps1` first when passing
options; the flagless `irm ... | iex` command above remains the normal path.

An installation from before the standalone package is upgraded in place when it is
the directory being installed into: it is stopped, kept as a backup, and its
settings and data come across. One that lives somewhere else is reported and left
exactly as it is — nothing is copied from a directory you did not point the
installer at without an answer — and `--adopt-data <path>` brings its sessions,
chat history and memories over as a copy, leaving the original untouched.

To hack on MultiCC itself, run it from a checkout — that path is for developers, and
`./multicc update` there is a `git pull` + `npm install`:

```bash
git clone https://github.com/lsjwzh/MultiCC.git
cd MultiCC && npm install && node server.js
```

</details>

**Prerequisites:** a working `git`, `tmux` (terminal mode only), and at least one
coding CLI on your `PATH`, already logged in. Node.js is **not** required — the
package brings its own.

<details>
<summary><strong>Not a terminal person? Install the desktop app instead</strong> (macOS / Windows / Linux)</summary>

MultiCC ships as a regular desktop application — double-click the icon and the whole
stack (backend + web UI) starts locally. No Node, no CLI commands, no ports to
remember.

1. Choose your platform from the **[desktop downloads above](#desktop-app)**:
   `multicc-desktop-<version>-macos-arm64/x64.dmg`, `-windows-x64.exe`, or
   `-linux-x64.AppImage` / `.deb` (each has a `.sha256` sidecar; `SHA256SUMS.txt`
   covers everything).
2. Launch it. A splash window starts the backend on a local loopback port and the
   UI opens automatically once it is ready.
3. Data, settings, and logs live in the standard per-user app folder — nothing in
   a terminal, nothing in the repo. Updates arrive as new installers.

On a Mac that cannot run it (the Electron shell needs macOS 13+, and Homebrew no
longer builds Intel bottles), use the one-line install above instead — the desktop
app and the installer ship **the same standalone tree**, just with a window around
it. It supports macOS 11+ including Intel Macs:
`multicc-standalone-<version>-darwin-x64.tar.gz`.

Stable releases include native desktop installers; developers can run the shell
from source with `npm run desktop:dev`.

**→ Install, first launch, startup failures, data/log locations, security model,
signing status: [Desktop app](docs/desktop.md)** — or, for old/Intel Macs and
machines without a window manager, the **[standalone package](docs/standalone.md)**.

</details>

Android APKs are built once by the GitHub release workflow when a `vX.Y.Z` tag is
published, signed with the project release key, and attached to that exact GitHub
Release. The **APK area in the web console** prefers a non-empty local
`public/multicc.apk`; when none exists, it links only to the `multicc.apk` asset
for the server's exact package version. It never falls forward to `latest`.
Installation and `./multicc update` never build an APK. Current stable releases
ship a signed APK asset, so the remote fallback is available immediately. The
same Release carries the **standalone packages** that
`install.sh` downloads, the desktop installers built on top of them, and their
checksums (`SHA256SUMS.txt` covers everything).

### 2. Start it

```bash
cd ~/MultiCC        # the installer's default directory (--dir changes it)
./multicc start     # from a checkout, it is the same command
```

Open **<http://localhost:3000>** — you land on the **Air console** (`/air`). Installer-created, password-protected instances also listen on the IPv4 LAN automatically; public access is never configured automatically and should use a tunnel (Tailscale Funnel, 花生壳, or SakuraFrp) — see [Configuration](docs/configuration.md).

### 3. Run your first task

1. Open **Console** on `/air`. Its first-run guide has three stages: configure models and the AI Assistant, add a project, and start a task. Prepare a provider or a CLI login, then configure the **AI Assistant**; a lightweight flash-tier model is enough.
2. **Add a workspace** pointing to your Git repo, or choose the sample project from the guide to try a read-only first task.

   ![The first-run setup card on /air](docs/images/en/air-first-run.png)
3. Open **New task** or expand the composer, describe a goal — *"summarise what this project does and list the three riskiest files; do not change any files yet."* — and create the task. **Run config** selects the CLI, line, model, reasoning effort, and supported subagent routing. It remembers your recent choices.

   ![Run config: engine, provider, model and subagent controls](docs/images/en/air-new-task.png)
4. The task binds a chat session and gets to work. Open it to watch the transcript; when it answers, open **Run config** from the chat header and pick a different CLI, then send a follow-up: *"you're a different model now — do you agree with the previous assessment?"*

The second CLI receives a bounded checkpoint of recent visible conversation, task and Git state, on the same branch and worktree. Switch back and the first CLI resumes its own session.

Then open your server’s reachable, authenticated address on your phone, or use the [Flutter app](docs/installation.md#build-the-flutter-app). Open the same task to follow its progress or answer a question. Use the host’s LAN address or configured tunnel; a phone’s `localhost` points to the phone itself.

For desktop handoff, install and authorize the [host agent](skills/multicc-computer-use/SKILL.md), open **Screen** from the chat, and check that you can view and control the intended desktop. When the agent needs help, complete the requested action, close remote control, and reply in the task to resume. Keep the host awake for this workflow.

![MultiCC on a phone-width screen](docs/images/en/air-mobile.png)

### 4. Keep it up to date

```bash
./multicc update           # install the newest release; your data is untouched
./multicc update --check   # just compare versions
```

Installed from a package, that is the whole story: `update` downloads the new
standalone archive for your platform, verifies its SHA-256, unpacks it next to your
install, and swaps the directory in place — a detached helper waits for the running
server to exit, renames the old tree aside, moves the new one in, and restarts. If
any of that fails, the previous version is restored. Sessions, providers and chat
history live in the per-user data directory, so an update never touches them (and the
in-app update entry is disabled for packaged installs on purpose: for those, the
package *is* the upgrade).

<details>
<summary>Running from a source checkout (git semantics)</summary>

In a checkout `./multicc update` is a `git pull` + `npm install` + restart, and it
copes with an everyday dirty tree: on the dev channel it stashes your changes as
`multicc-auto-update`, fast-forwards `main`, and pops them back. `--force` is for
when that isn't enough — the pop conflicts with what was just pulled, the stable
channel's `git checkout <tag>` refuses over a local edit, or your branch carries
local commits and plain `update` just says *nothing to update*. It puts you on the
remote's code regardless: everything in the tree, **including untracked files**, goes
into a labelled `multicc-force-update-<timestamp>` stash first, then the checkout is
forced (`git reset --hard origin/main` on dev, `git checkout -f <tag>` on stable).
**Nothing is deleted, but the stash is not restored** — you land on a clean checkout
and recover your work yourself with `git stash list` / `git stash pop`. One exception:
on the stable channel `--force` still only acts when a newer release exists; at the
newest tag it stops and prints the `git checkout -f` to run by hand.

From the browser: click the **version number at the bottom of the Air console
sidebar** → a dialog shows current vs. latest and a *Force update* checkbox → confirm, and
MultiCC runs the same update in the background, streams the log into the dialog,
restarts itself, and reloads the page once it's back. If the update fails, the dialog
keeps the full output and offers a force retry.

</details>

**→ Install flags, `./multicc` service manager, systemd unit, app builds: [Installation](docs/installation.md)**

---

## What else it does

<table>
<tr><td width="50%" valign="top">

**Sessions & orchestration**
- Two modes: full `tmux` **terminal** and a **chat** UI with tool cards and inline images
- Per-session **git worktree** on `multicc/<sessionId>`
- Merge back with **syntax-gated** validation; safe sibling worktrees sync after a merge, while dirty or conflicting worktrees need attention
- **Cross-session dispatch** — one agent hands work to another
- **Task-first MCP dispatch** — route work to an existing task or atomically create a new independent task with durable, idempotent receipts
- **Resident Claude and Codex lanes** — bounded warm processes reduce turn startup overhead while preserving each CLI's native resumable session
- **Agent Commander** — a fleet-conductor session seeded into every new directory
- Shared **task board** with a **unified task chat view** — every task owns a bound chat session with live transcript, cancel/cleanup, and stable short codes
- **Task attribution ladder** — each incoming message is matched to a task through escalating evidence, with every decision written to a durable journal you can audit and override
- Native **task graph** and **memory graph** views in the Air console
- **Scheduled message dock** — persist one-time messages across service restarts; overdue messages send when the service returns
- **Hibernate idle task worktrees** — auto-suspend idle task sessions to free resources
- **run-detached** tasks, **cron** schedules, post-turn / file-change **triggers**
- Inter-agent **notes**

</td><td width="50%" valign="top">

**Models & cost**
- **Multi-provider**: bind any Anthropic- or OpenAI-compatible endpoint per CLI
- **Auto Provider routing & failover** — use ordered failover, or let Jev route simple and complex requests to different provider/model tiers before the first byte or tool side effect; evaluation failures follow a configurable safe fallback
- **AI Assistant (aux)** — intent classification, task attribution, and auto-advance; configured from its own console page (a lightweight flash-tier model is enough)
- Read-only import from **cc-switch**
- **Official account management** — sign in to separate Claude/Codex accounts and discover account-specific models
- **Account egress and private relays** — bind supported account model requests to a dedicated proxy, or share a provider from your own VPS; see [network setup](#proxies-accounts-and-a-private-relay)
- **Subagent routing** — choose a separate line/model in Run config, save presets, and optionally apply defaults to matching Claude/Codex tasks
- Per-provider `CODEX_HOME` isolation
- **Token accounting** — global, per-session, per-role, daily windows

</td></tr>
<tr><td width="50%" valign="top">

**Clients & reach**
- **Human handoff** — remote desktop controls, screenshot annotations, and a reply in the task to let the agent continue; host support and permissions apply
- Zero-build web UI + installable **PWA**
- Native **desktop app** (Electron) for macOS / Windows / Linux — backend included, loopback-only, no terminal needed
- Native **Flutter app** for Android and iOS
- **IM bridges**: WeChat, Feishu, Telegram, Discord, Slack
- **Session sharing** via password-protected snapshot links; share links open the chat page directly
- **Cross-instance Fleet sharing** — password-protected read-only snapshots, imported and interactively driven on the other side
- **Relay-token remote sharing** — grant access and share provider configs securely from the console
- Public tunnels built in: **Tailscale Funnel**, **花生壳**, and **SakuraFrp** with live monitoring
- Web Push / Bark / webhook **notifications**
- Chinese + English UI — starts in English outside Chinese locales; switch with EN/中 in the sidebar

</td><td width="50%" valign="top">

**Voice & resilience**
- **Speech-to-speech** mode with VAD and barge-in
- Classic voice input with **on-device ASR** (sherpa-onnx SenseVoice) and LLM prompt polishing
- **Voice task announcements** — hands-free status of completed tasks
- 500-event **replay buffer** — reconnect rebuilds state deterministically
- In-process **battery guard** — opt-in sleep when running on battery below a threshold, latched until AC power or a manual rearm
- Serialized git queue, graceful shutdown/restart
- Password-gated automatic LAN binding, HMAC cookies, WebSocket tickets

</td></tr>
</table>

![CLI and provider settings in the Air console](docs/images/en/air-provider.png)

![The AI Assistant page in the Air console](docs/images/en/aux-console.png)

**→ Every feature in detail: [Features](docs/features.md)**

---

## Proxies, accounts, and a private relay

- **Host proxy:** MultiCC follows configured proxy environment variables and, on macOS, system proxy settings when explicit variables are absent. Loopback traffic stays local.
- **Separate accounts and exits:** manage official logins from **Settings → Model routes**. For Claude official model traffic, create proxy identities in the **Chrome isolated-egress launcher** plugin, then edit each account's **Dedicated egress** binding. Different identities need different upstream exits to obtain different public IPs. This does not guarantee that every login, refresh, or quota request is isolated; see the [plugin's scope](plugins/chrome-proxy-launcher/README.md).
- **Your own VPS relay:** install MultiCC on a VPS, configure providers there, and use **Share with another device** on a provider card. Import the share code on your local instance through **More connection options → Connect or share another device**. The receiver gets a revocable provider-scoped credential, not the upstream API key or OAuth token. Use an authenticated HTTPS or private-network address for off-host access. See [remote provider relay](docs/configuration.md#remote-provider-relay).

![A Claude account bound to its own proxy identity](docs/images/en/air-account-proxy.png)

## Keep working with the Mac lid closed

On a supported Mac, open **Settings → General → Mac power and unlock** and enable **Run with lid closed**. Complete first-time setup on that Mac: save the login password in its local keychain, grant the agent permissions and confirm read access. macOS may also request administrator approval. This setting includes automatic unlock when computer tools need the desktop.

Keep the Mac and MultiCC service running, connected to the network, and adequately powered and ventilated. Your phone opens the same task through an authenticated reachable address. Closing the browser does not stop the task; shutting down, losing host connectivity, or a battery-guard sleep stops remote availability.

![Current Mac power and automatic-unlock settings](docs/images/en/air-power.png)

[Watch the 38-second lid-closed scenario video](https://x.com/multicc_ai/status/2113283616532996247). This is an illustrated demo with AI-generated people and interface animation, not a continuous live recording.

## Documentation

| Document | What's in it |
|---|---|
| **[Multi-CLI switching](docs/cli-switching.md)** | Checkpoint format, reuse semantics, API, one-click install |
| [Installation & service management](docs/installation.md) | Install flags, updating, `./multicc` commands, systemd, Flutter builds |
| [Desktop app](docs/desktop.md) | macOS / Windows / Linux desktop installers: first launch, failures, data & log locations, security model, signing |
| [Standalone package](docs/standalone.md) | The distribution form everything else wraps: layout, `multicc` commands, updates, data locations, and why it runs on macOS 11+/Intel with no compiler and no Homebrew |
| [Browser automation on macOS 11+](skills/multicc-browser/references/mbrowser.md) | MultiCC's own `mbrowser` executor: dedicated Chrome profiles, resident CDP daemon, per-session tabs, macOS 11–12 tiers. The Python [Browser Harness route](skills/multicc-browser/references/browser-use-local.md) stays as an opt-in alternative |
| [Configuration](docs/configuration.md) | Every environment variable, providers, voice, notifications |
| [Features](docs/features.md) | The complete feature reference |
| [Architecture](docs/architecture.md) | Repository layout, message flows, design decisions |
| [API reference](docs/api-reference.md) | REST endpoints by domain + WebSocket protocol |
| [Router tools](docs/router-tools.md) | Task-first MCP contracts for durable dispatch, `new_task`, waits, secrets, and artifacts |
| [How MultiCC compares](docs/ecosystem-comparison.md) | 12-project landscape, head-to-head tables, what MultiCC is *worse* at |
| [FAQ](docs/faq.md) | Troubleshooting and common questions |
| [Tech stack](docs/tech-stack.md) | Runtime dependencies and what each one is for |

The full index — design contracts, voice, provider routing, governance reviews, and modularization history — is in **[docs/README.md](docs/README.md)** (50+ documents).

---

## Configuration in 30 seconds

Everything lives in a single env file. Installed from a package, that file is
`multicc.env` in the per-user data directory — `./multicc config path` prints it,
`./multicc config set PORT 3000` edits it. Running from a checkout it is `.env` at
the repo root. Either way the installer writes `ACCESS_TOKEN` and `PORT` for you.
A port you specify (`--port`, `PORT=…`, or `config set PORT`) is pinned: if it is
taken, startup fails with a message instead of silently moving to the next port.

```env
PORT=3000
ACCESS_TOKEN=<generated-by-install.sh>

# With a token and no explicit network policy, IPv4 LAN access is automatic.
# To force loopback-only access, set either:
# HOST=127.0.0.1
# MULTICC_ALLOW_REMOTE=0
```

Requests from loopback bypass `ACCESS_TOKEN`. MultiCC serves **plain HTTP** and does not terminate TLS — use one of the built-in tunnels (Tailscale Funnel, 花生壳, or SakuraFrp, managed from the console's host settings), ngrok, or your own reverse proxy for public access.

Providers, subagent routing, voice, TTS/ASR and notification settings are configured from the Air console; the underlying variables are documented in **[Configuration](docs/configuration.md)**.

---

## How MultiCC compares

Projects that **harness** the official CLIs — spawning and managing the real `claude` / `codex` binaries rather than reimplementing them — cluster into remote-access wrappers, web IDEs, and multi-agent orchestrators.

**MultiCC combines these workflows:**

- **Human handoff within a task** — remote desktop controls and screenshot annotations, followed by the agent continuing after your reply

- **In-place cross-CLI switching** across the supported engines with a bounded handoff checkpoint
- **Task board with bound chat sessions** — every task gets a private chat transcript, short codes, and lifecycle controls
- **Scheduled messages** and **relay-token remote sharing**
- **Speech-to-speech** voice conversation with an agent, plus hands-free task announcements
- **On-device ASR** (sherpa-onnx SenseVoice) for classic voice input
- **IM bridges** to five platforms with full dispatch + reply
- **Per-session provider and subagent routing** for cost control
- **Native desktop and mobile apps**, PWA, terminal, and web chat against one backend, with signed APKs shipped on every stable release

**Where it is weaker:** no hosted/cloud option, no built-in code editor, and single-user by design — there is no team RBAC.

Model and account managers such as [Magpie](https://github.com/yetone/magpie) overlap with MultiCC’s provider, routing and session features. MultiCC focuses on task execution, isolated code changes and human intervention. Choose based on the workflow you need.

The linked survey is historical, not evidence that individual features remain exclusive. Surveyed: cc-switch, Ruflo, CLIProxyAPI, oh-my-claudecode, AionUi, vibe-kanban, cc-connect, CloudCLI, Superset, Orca, cockpit-tools — eleven peers, plus MultiCC itself, make up the 12-project landscape.

**→ The full 12-project survey and head-to-head tables: [How MultiCC compares](docs/ecosystem-comparison.md)**

---

## Architecture at a glance

```
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ Desktop Web  │  │  Mobile PWA  │  │ Flutter App  │  │ WeChat / IM  │
    │ (Terminal)   │  │   (Chat)     │  │ Android/iOS  │  │   Bridges    │
    └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
           │                 │                 │                 │
           ▼                 ▼                 ▼                 ▼
    ┌───────────────────────────────────────────────────────────────────┐
    │           MultiCC Server  (Express + ws, authenticated LAN HTTP)  │
    │  ┌────────────────────┐  ┌───────────────┐  ┌──────────────────┐  │
    │  │ tmux backend       │  │ CLI spawner   │  │ cli-switch       │  │
    │  │ (terminal mode)    │  │ (chat mode)   │  │ + handoff        │  │
    │  └─────────┬──────────┘  └───────┬───────┘  └────────┬─────────┘  │
    │            ▼                     ▼                   ▼            │
    │      claude / codex …    CLI adapters        per-CLI native       │
    │                          (stream-json, exec) session state        │
    └───────────────────────────────────────────────────────────────────┘
                                     │
                    per-session git worktree: multicc/<sessionId>
```

Key decisions: vendor transcripts are never translated; authoritative conversation and provider records remain inspectable local files, while orchestration and rebuildable search indexes use SQLite through the bundled Rust driver (`node:sqlite` remains an explicit rollback option); each session owns a branch and worktree; the network bind is fail-closed. The desktop app adds one more client without adding a second UI — it embeds this same server and serves this same web page from a loopback port.

**Built with:** Node.js · Express · ws · Rust SQLite (bundled through napi-rs) · sherpa-onnx (on-device ASR) · cli-provider-router · chokidar · tmux · Flutter · Electron (desktop shell). No frontend build step — the web client is plain JavaScript.

**→ [Architecture](docs/architecture.md)**

---

## API

MultiCC exposes a complete REST + WebSocket API — sessions, git, providers, voice, notifications, task board, sharing, tunnels.

```bash
# Switch a live chat to another CLI
curl -X POST "http://localhost:3000/api/sessions/$SESSION_ID/switch-cli" \
  -H 'Content-Type: application/json' -d '{"cli":"codex"}'
```

**→ [API reference](docs/api-reference.md)**

---

## FAQ

A few of the most common questions:

- **Is there a desktop app?** Yes — macOS (dmg), Windows (exe), and Linux (AppImage/deb) installers ship on the Releases page. Double-click and everything (backend + UI) starts locally; no Node, no terminal. See [Desktop app](docs/desktop.md).
- **Does MultiCC serve HTTPS?** No — direct LAN access is plain HTTP. Use `http://localhost` for microphone and PWA features, or a tunnel that terminates real TLS.
- **Can I use it without Claude Code?** Yes. Any one supported CLI is enough.
- **Does switching CLIs cost tokens immediately?** No. The checkpoint is queued and delivered with your *next* message.
- **Port already in use?** Use `./multicc config set PORT 3001` for a package install, or set `PORT` in the checkout's `.env`. Automatic rollover only happens in development mode.
- **`./multicc update` stopped, or says "nothing to update" while I'm behind?** `./multicc update --force` puts you on the remote's code. Local changes are stashed as `multicc-force-update-<ts>` and not restored — see [Keep it up to date](#4-keep-it-up-to-date).

**→ [Full FAQ](docs/faq.md)**

---

## 中文用户

**让智能体持续推进任务；需要你时，在手机接手一步，再让它继续。** MultiCC 将任务、工作区、跨引擎接续与人机协作放在同一个工作台。
安装、首次任务与常见问题的中文说明见 **[README.zh.md](README.zh.md)**。界面支持中英文切换，非中文系统默认英文，可通过侧栏的 EN/中 切换。

---

## License

MIT.

---

<p align="center">
  <sub>Built for Claude Code, Codex, OpenCode, ZCode, Kimi Code, Qoder, WorkBuddy, DSH, Gemini CLI, Command Code, Grok, and pi · <a href="https://github.com/lsjwzh/MultiCC">github.com/lsjwzh/MultiCC</a></sub>
</p>
