# Installation & service management

> Full install reference, migrated out of the README: install-script flags, updating, recovery from a force-push, prerequisites, the `./multicc` service manager, a systemd unit, and Flutter app builds.

## Stable Release (recommended)

```bash
curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v1.3.0/install.sh | bash -s -- --branch v1.3.0
```

This installs the latest **stable release**. The script auto-detects your OS,
checks prerequisites, clones the repo, installs dependencies, configures an
access token, and optionally installs as a background service (macOS `launchd`).
It does not build the Android APK.

Running `./multicc update` later checks for new releases and upgrades you
when one becomes available.

## Development Snapshot (daily `main`)

> ⚠️ This pulls the current `main` branch — it may include untested changes.
> Prefer the stable release above unless you explicitly want the bleeding edge.

```bash
curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/main/install.sh | bash
```

Detects your OS, checks prerequisites, clones the repo, installs dependencies, configures an access token, and optionally installs as a background service (macOS `launchd`). APK builds are always explicit and on demand.

**Install with options:**

```bash
curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/main/install.sh | bash -s -- \
  --port 8080 --token mysecrettoken --no-service
```

| Flag | Description |
|------|-------------|
| `--dir <path>` | Install directory (default: `./MultiCC`) |
| `--token <xxx>` | Pre-set `ACCESS_TOKEN` (default: auto-generated) |
| `--port <port>` | Server port (default: `3000`) |
| `--no-service` | Skip background service install |
| `--no-clone` | Use current directory; skip git clone |
| `--branch <name>` | Git branch to clone (default: `main`) |

Older automation may still pass `--no-apk`. It is accepted as a deprecated
compatibility no-op, but is no longer an install option because installation
never builds an APK.

**After install:**

```bash
cd MultiCC && ./multicc start     # start the server
cd MultiCC && ./multicc install   # install as macOS launchd background service
```

**Update anytime:**

```bash
./multicc update           # pull latest code, reinstall deps if the manifests changed, restart
./multicc update --force   # land on the remote's code whatever the local tree/history is
./multicc update --help    # usage
```

Updates never build or rebuild the APK. If the App version changed, request a
new package from `/manage` or run `./multicc apk` after the update.

On the stable channel (`.multicc_channel` = `stable`, written by the installer when you
pass `--branch <tag>`) `update` checks out the newest release tag. On the dev channel it
fast-forwards `main`.

The v1 updater also verifies the independently packaged `cli-provider-router`
(CPR) before starting the server. Provider credentials and defaults remain in
MultiCC's existing `providers.json` / data directory; no CPR data migration is
required. If an interrupted upgrade leaves dependencies incomplete, rerun
`./multicc update` and it will repair them with `npm install` before restarting.

### When the working tree is dirty or the history diverged

The running server rewrites runtime-state files constantly, so the working tree is almost
never clean — and a plain `update` is built for that. On the dev channel it stashes local
changes (tracked **and** untracked) under `multicc-auto-update`, fast-forwards, and pops
them back. A dirty tree by itself is not what stops an update.

What a plain `update` does in the awkward cases depends on the channel:

| Situation | Dev channel (`main`) | Stable channel (release tag) |
|---|---|---|
| Dirty working tree | stash → fast-forward → pop back | `git checkout <tag>` carries the edits over, but **aborts** the update if one of them is in the way — nothing is stashed |
| Restoring the stash conflicts with what was pulled | stops; your work stays in the `multicc-auto-update` stash | n/a |
| Local commits ahead of origin | prints *Local branch is ahead of origin — nothing to update* and stops, leaving you off the release line | compares release versions, not commits — a `package.json` version ≥ the latest tag reads as *already on the latest release* |
| Upstream force-pushed / history rewritten | hard-resets to `origin/<branch>` **without** `--force`, and leaves the auto-stash unpopped | n/a |

So the honest summary is: plain `update` never clobbers your work silently, but it also
doesn't always get you onto the remote's code. `--force` does:

```bash
cd MultiCC && ./multicc update --force
```

`--force` never deletes anything, but it also never puts your changes back:

1. Everything in the working tree, **including untracked files**, is stashed under a
   labelled entry — `multicc-force-update-<timestamp>`.
2. The checkout is forced onto the target commit — `origin/main` on the dev channel
   (`git reset --hard`, so ahead / behind / diverged all end the same way), the newest
   release tag on stable (`git checkout -f`).
3. Dependencies are reinstalled if the manifests changed, and the server restarts. On the
   dev channel that happens even when `HEAD` didn't move, because the files on disk did.

The stash is **not** popped afterwards. Recover your work with `git stash list` and
`git stash pop`, or leave it there forever — it costs nothing.

One asymmetry to know about: on the **stable** channel the version check runs before
`--force` is consulted, so at the newest release tag `update --force` reports *already on
the latest release* and stops — no stash, no forced checkout, no restart. It prints the
`git checkout -f <tag>` to run by hand if you wanted the clean checkout rather than the
new version. On the dev channel `--force` at `origin`'s tip does reset and restart.

### One-click update from the browser

Click the **version number at the bottom of the `/manage` sidebar**. The dialog shows your
current version against the latest release, with a *强制更新* checkbox that maps to
`--force`. Confirming runs the same `./multicc update` detached from the server process,
tails its log into the dialog, and reloads the page once the restarted server answers
again. A failed update keeps its full output in the dialog and offers a force retry.

Because the update restarts the server, in-flight agent turns are interrupted (their
partial output is saved). The dialog warns you when any session is mid-stream.

Under the hood: `POST /api/update` with `{"force": true|false}` starts it, `GET
/api/update/status` reports progress from `logs/update.log` — see the
[API reference](api-reference.md#server-info--update). Both are `ACCESS_TOKEN`-gated like
`/api/restart`.

## Prerequisites

- **Node.js** >= 20.19 (required by `chokidar` 5 ESM — backported `require(ESM)` support landed in Node 20.19 / 22.12)
- **tmux** (for terminal mode; chat mode works without it)
- **At least one coding CLI** on your `PATH`, already logged in — `claude`, `codex`, `opencode`, `zcode`, `kimi`, or `qoder`. MultiCC can install the missing ones for you from the CLI switcher (see [Multi-CLI switching](cli-switching.md)).
- **Flutter** >= 3.8 plus the Android toolchain — required only when an Android
  APK build is explicitly requested. A server-only install does not need them.

## Manual Install

```bash
git clone https://github.com/lsjwzh/MultiCC.git
cd MultiCC
npm install
node server.js
```

Open `http://localhost:3000/chat` to begin.

MultiCC binds to `127.0.0.1` by default and will **refuse to start** on any other host unless you opt in explicitly. To reach it from other devices on your LAN, set all three in `.env`:

```env
HOST=0.0.0.0
MULTICC_ALLOW_REMOTE=1
ACCESS_TOKEN=<a-long-random-string>
```

Then open `http://<your-lan-ip>:3000?token=<ACCESS_TOKEN>`. Note that plain HTTP over a LAN address is not a secure context, so microphone input and PWA install will not work there — use a tunnel (see [FAQ](faq.md)) if you need those.

## CLI Service Manager

```bash
./multicc start       # start server
./multicc stop        # stop server
./multicc restart     # restart server
./multicc status      # check if running
./multicc log         # tail live logs
./multicc update      # pull latest, reinstall deps, restart
./multicc update -f   # ...forcibly, discarding local changes to a stash (see above)
./multicc install     # install launchd agent (macOS auto-start on login)
./multicc uninstall   # remove launchd agent
```

**Linux systemd user service:**

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/multicc.service <<'UNIT'
[Unit]
Description=MultiCC Server
After=network.target
[Service]
ExecStart=$(which node) $PWD/server.js
WorkingDirectory=$PWD
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now multicc
```

## Build the Flutter App

Installation and update never compile the Flutter app. Android builds have two
explicit entry points:

- In `/manage`, use the **APK** area to start a background build or rebuild. You
  can leave the page while it runs. If an older APK already exists, it remains
  downloadable throughout the build and is replaced only after the new file is
  complete.
- From a shell, run `./multicc apk`.

```bash
./multicc apk                             # Android; publishes to public/multicc.apk
cd app
flutter build ios --release --no-codesign # iOS (needs Xcode + signing)
```

Flutter >= 3.8 and the Android toolchain must be available to the process that
starts an Android build. In particular, a build started from `/manage` needs
`flutter` on the MultiCC service's `PATH`; their absence does not affect server
installation or updates, but the requested build will fail with its log retained.

The APK and its `.json` / `.sha1` sidecars are ignored local artifacts, not
Git-tracked files. The dashboard serves the complete atomically-published file
at `/multicc.apk`.
`./multicc apk --if-missing` keeps an existing package only when its metadata
matches the current `app/pubspec.yaml` version. The `/manage` action is explicit:
choosing rebuild starts a new build even when the existing package is current.

Android release builds currently use the host's Android debug keystore. Rebuilds
on the same host retain that identity, but moving the server to a host with a
different keystore cannot update an already-installed APK in place; uninstall
the old app once or configure a shared release-signing key before migration.

A future distribution path may use a GitHub Release APK asset as a fallback on
hosts without Flutter. That fallback is not implemented yet: today every APK
offered by this server must first be built locally through one of the explicit
entry points above.

---

[← Back to the README](../README.md)
