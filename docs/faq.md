# FAQ

> The full FAQ. The README keeps the entries a first-time user hits most often.

## Does MultiCC serve HTTPS?

No — it listens over plain HTTP and binds to `127.0.0.1` by default. Browser features that need a secure context (microphone, PWA install, service worker) work over `http://localhost`. For any other host, put a real TLS front-end in front of MultiCC: Tailscale Funnel (built into `/manage` → Tunnel), ngrok, or your own reverse proxy. MultiCC does not generate certificates.

## Claude command not found

MultiCC searches common install paths on startup. If it still can't find `claude`:

```bash
echo 'CLAUDE_CMD=/path/to/claude' >> .env
```

## Codex command not found

MultiCC searches Homebrew, local-bin, Cargo, and shell PATH. If needed:

```bash
echo 'CODEX_CMD=/path/to/codex' >> .env
```

## Which provider does a session use?

Each session records `cli` (`claude` or `codex`) and an optional `provider` id. If `provider` is empty, the session uses the local default login. If set, only that session's spawned process gets the provider override — siblings can use different providers safely. Check `/manage` → session card for the active provider.

## How do I switch a session's model?

On `/manage`: click the session card → "Model" dropdown shows provider-specific options. On the chat page: the model picker is in the header bar. Switching a session's provider automatically clears the model override so the new provider's default takes effect.

## "此浏览器不支持录音" (Browser doesn't support recording)

`MediaRecorder` requires a secure context. Use `http://localhost:3000` on the same machine, or reach MultiCC through a tunnel that terminates real TLS (Tailscale Funnel, ngrok). Plain `http://<lan-ip>:3000` will not get microphone access in any modern browser.

## How do I use S2S (speech-to-speech) real-time voice?

1. Install `edge-tts` (Python): `pip install edge-tts`
2. Install `ffmpeg`: `brew install ffmpeg` (macOS) or `sudo apt install ffmpeg` (Linux)
3. In the chat page, click the phone icon to start a voice session
4. Speak naturally; the system will confirm your request, then the agent runs and reads its reply aloud
5. Interrupt by speaking — the agent stops and listens

## Flutter app can't reach the server from my phone

- Check the phone is on the same LAN.
- MultiCC binds to `127.0.0.1` by default. To accept connections from other devices you must set both `HOST=0.0.0.0` and `MULTICC_ALLOW_REMOTE=1` in `.env` (the server refuses a non-loopback bind otherwise), plus an `ACCESS_TOKEN`. A tunnel is usually the better option.
- Confirm `ACCESS_TOKEN` is set in the Flutter setup screen if the server has one.

## How do I access MultiCC from the public internet?

Use the **Tunnel** section in `/manage` → toggle **Tailscale Funnel** (requires Tailscale installed and authenticated). For 花生壳 DDNS users, the tunnel monitor keeps the phtunnel process alive.

## tmux sessions pile up

Terminal-mode sessions are named `multicc-<id>`. To clean up orphans:

```bash
tmux list-sessions | grep multicc | cut -d: -f1 | xargs -I{} tmux kill-session -t {}
```

## Port is already in use

Set a different `PORT` in `.env`. Automatic rollover to the next free port only happens in development mode (`NODE_ENV=development` or `MULTICC_DEV=true`); in normal operation an occupied port is a hard startup failure, so the port you configure is the port you get.

## How do I update MultiCC?

```bash
cd MultiCC
./multicc update
```

It pulls the latest code, reinstalls dependencies if the manifests changed, and restarts
the server. You can also click the version number at the bottom of the `/manage` sidebar
and let MultiCC do it for you.

## `./multicc update` stopped, or reports "nothing to update" while I'm behind

Use the force variant:

```bash
cd MultiCC
./multicc update --force     # -f works too
```

An ordinary dirty tree does not need this — on the dev channel a plain `update` stashes
your changes as `multicc-auto-update`, fast-forwards, and pops them back. `--force` is for
the cases that plain `update` can't finish on its own:

- the stash pop conflicts with what was just pulled (update stops, changes left in the stash);
- on the stable channel, `git checkout <tag>` refuses because a local edit is in the way;
- your branch has local commits, so `update` prints *Local branch is ahead of origin —
  nothing to update* and leaves you off the release line.

`--force` gets you onto the remote's code regardless.

It does **not** delete anything: your changes (including untracked files) go into a stash
labelled `multicc-force-update-<timestamp>` first. But it does **not** put them back
either — you end up on a clean checkout, and you recover your work yourself:

```bash
git stash list          # find multicc-force-update-<timestamp>
git stash pop           # or: git stash apply stash@{N}
```

The server restarts at the end, which interrupts any agent turn that is mid-stream
(partial output is saved). In the web UI the same thing is the *强制更新* checkbox in the
update dialog.

Full detail: [Installation → when the working tree is dirty](installation.md#when-the-working-tree-is-dirty-or-the-history-diverged).

## How do I share a chat conversation?

In the chat page, select messages and click "Share" — you'll get a read-only link. You can optionally set a password and allow viewers to operate. Shares are revoked when you delete the session.

## I upgraded from WebCC — what changed?

The rename changed persistence keys (`webcc_*` → `multicc_*`) and Android/iOS package identifiers (`com.webcc.*` → `com.multicc.*`):

- **Web UI:** you'll get logged out once; notification/voice toggles reset to defaults.
- **Flutter app:** install as a **new app** (old one stays side-by-side until you uninstall it). Setup screen asks for host / token / session again.
- **launchd service:** `./webcc uninstall` first, then `./multicc install` — the `Label` changed from `com.webcc.server` to `com.multicc.server`.
- **tmux sessions** named `webcc-*` are orphaned; kill with the command above (substituting `webcc`).

## How do I add a Telegram / Discord / Slack bridge?

In `/manage` → Bridges section, select the platform, enter your bot token or app credentials, create a gateway session, then start. Each bridge runs its own gateway session and supports the same dispatch + reply flow as WeChat/Feishu.

---

[← Back to the README](../README.md)
