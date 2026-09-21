# Installation & service management

> How MultiCC is installed and kept running: the one-line standalone install and its flags, updating (installed package vs. source checkout), prerequisites, the `./multicc` service manager, a systemd unit, and Flutter app builds.

## Install (one line, no flags)

```bash
# macOS / Linux
curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v2.0.4/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/lsjwzh/MultiCC/v2.0.4/install.ps1 | iex
```

The tag in the URL **is** the version. The script downloads that release's
**standalone package** — the server plus a pinned Node runtime plus every
production dependency, in one archive — verifies its SHA-256, unpacks it into
`~/MultiCC` (`%USERPROFILE%\MultiCC` on Windows), clears macOS download quarantine,
writes `ACCESS_TOKEN` and `PORT`, optionally asks about start-on-login (macOS
`launchd` / Linux systemd user / Windows Startup), starts MultiCC and opens the browser. Nothing is
compiled, no APK is built, and **the target machine needs no Node, npm, git,
Homebrew or Xcode**.

When the command returns MultiCC is already ready. The same command remains the
day-to-day control surface:

```bash
cd ~/MultiCC
./multicc start              # idempotent: start/reuse it and open the browser
./multicc status             # version, state, URL, data directory
./multicc service install    # start automatically on login
```

Package layout, the boot wrappers, data/log locations and the download-and-verify
assets are documented in **[Standalone package](standalone.md)** — that document is
the authority for anything below.

**Install with options** (the flag table in full is in
[standalone.md](standalone.md)):

| Flag | Description |
|------|-------------|
| `--dir <path>` | Install directory (default: `~/MultiCC`) |
| `--version <v\|latest>` | Release to install; default is the tag in the URL |
| `--from <path\|url>` | Install from a local archive/directory or a URL instead of downloading |
| `--token <xxx>` | Pre-set `ACCESS_TOKEN` (default: auto-generated) |
| `--port <port>` | Server port (default: `3000`) |
| `--no-service` | Skip the start-on-login setup |
| `--no-start` | Install/configure only; also skips start-on-login setup |
| `--no-open` | Start the server but do not open a browser |

Windows PowerShell uses the same concepts with native parameter names:
`-InstallDir`, `-Version`, `-From`, `-AccessToken`, `-Port`, `-NoService`,
`-NoStart`, and `-NoOpen`.

Older published command lines still work through compatibility shims: `--branch
<tag>` is an alias for `--version`, `--no-clone` means "install from the current
directory" (equivalent to `--from .`), and `--no-apk` is a warning-only no-op —
installation never builds an APK. Re-running the installer on the same directory
is an in-place replacement with a rollback point — see
[standalone.md](standalone.md).

**Update anytime (installed package):**

```bash
./multicc update           # download, verify and swap in the newest release
./multicc update --check   # only compare versions
```

Your sessions, providers and chat history live in the per-user data directory, so
updating never touches them, and an interrupted swap rolls back to the previous
version rather than leaving nothing. Updating from inside the web UI is
deliberately disabled for packaged installs (`/api/update` returns 409) — for
them the package *is* the upgrade. The full mechanism is in
[standalone.md](standalone.md); the source-checkout semantics are below.

## Run from a source checkout (developers)

This is the path for hacking on MultiCC itself. It is the only path that needs a
toolchain:

```bash
git clone https://github.com/lsjwzh/MultiCC.git
cd MultiCC
npm install
node server.js
```

Here `./multicc` is a **source-checkout manager** (`start` / `stop` / `restart` /
`status` / `log` / `update` / `install` / `uninstall`), not the packaged command,
and `./multicc update` is `git pull` + `npm install` + restart. The
[standalone package](standalone.md) is what end users install.

`install.sh` is not used on this path, so create `.env` yourself (the server also
accepts the same variables from the environment):

```env
ACCESS_TOKEN=<a-long-random-string>
```

On the stable channel (`.multicc_channel` = `stable`, written by the packaged
installer) `update` checks out the newest release tag. On the dev channel it
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

Installed from the standalone package, the requirements are only these:

- **tmux** (terminal mode only; chat mode works without it). The package does not ship or install `tmux` — install it yourself with Homebrew / your system package manager if you want the terminal page.
- **At least one coding CLI** on your `PATH`, already logged in — `claude`, `codex`, `opencode`, `zcode`, `kimi`, or `qoder`. MultiCC can install the missing ones for you from the CLI switcher (see [Multi-CLI switching](cli-switching.md)). The package's runtime is prepended to `PATH`, so these Node-based CLIs run on the bundled Node and you never install Node yourself.
- **On macOS, don't use a protected location for a workspace** — Desktop, Documents, Downloads, iCloud Drive, removable and network volumes. macOS gates those behind per-process disk-access grants, so registering a directory there can fail with `Operation not permitted` no matter what you authorize. Use something like `~/working`; a symlink from a protected folder to the real repo works too. See [macOS disk permissions](standalone.md#macos-磁盘权限tcc为什么给权限常常给不上).

Running from a source checkout adds one more:

- **Node.js** >= 22.16 (the server uses the built-in `node:sqlite` module; both `server.js` and the source-checkout `./multicc` manager refuse to start below this floor). This applies to the checkout path only — the standalone package carries its own pinned Node 22, which is also why it supports **macOS 11+** including Intel Macs that Homebrew and the Electron shell no longer cover.

## Network binding and LAN access

The packaged installer (and the checkout, if you set a token) generates an
`ACCESS_TOKEN`. If neither `HOST` nor `MULTICC_ALLOW_REMOTE` is configured, that
password-protected installation automatically binds `0.0.0.0`, so other devices on
the same IPv4 LAN can open:

```env
ACCESS_TOKEN=<a-long-random-string>
```

Open `http://<your-lan-ip>:3000?token=<ACCESS_TOKEN>`. To opt out, set
`HOST=127.0.0.1` or `MULTICC_ALLOW_REMOTE=0`. MultiCC never creates router
port-forwarding or a public endpoint automatically; use Tailscale Funnel for
off-LAN access. Plain HTTP over a LAN address is not a secure context, so
microphone input and PWA install will not work there — use a TLS tunnel if you
need those features.

The installer and `/api/server-info` use the same adapter ranking: physical
private Wi-Fi/Ethernet addresses are preferred, while Docker, VM, Tailscale and
VPN adapters are excluded from the LAN URL. If more than one physical LAN is
active, `server-info.lanUrls` exposes every candidate. MultiCC cannot safely
change the host firewall or an access point's client-isolation policy without
administrator/network-owner consent; the installer prints those two checks
next to the LAN URL instead of silently changing either control.

## CLI Service Manager

**Installed package** (`./multicc` in the install directory):

```bash
./multicc start             # start server (background + opens the browser)
./multicc stop              # graceful stop
./multicc restart           # restart
./multicc status            # version, state, URL, data directory
./multicc log -f            # tail live logs
./multicc config list       # read/write the env file (tokens are masked)
./multicc update            # verified download + in-place swap
./multicc service install   # auto-start on login (launchd / systemd user)
./multicc service uninstall # remove it
./multicc service status    # is it registered?
```

Windows has no service mode; every other command works there through
`multicc.cmd`. See [standalone.md](standalone.md) for the wrappers and the
stop-marker semantics.

**Source checkout** (`./multicc` in the repo root):

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

**Linux systemd user service** — the installed package writes and manages this
for you (`./multicc service install`). This is the equivalent unit by hand, for a
source checkout (`./multicc install` covers launchd on macOS only):

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

In a package install the unit points at the bundle's own launcher instead, so the
service starts the same supervised process `./multicc start` would — logs land in
`logs/service.log` in the data directory.

## Android APK distribution and iOS builds

Installation, update, and the running server never compile the Android app.
Publishing a `vX.Y.Z` tag is the only official APK build trigger: the GitHub
release workflow builds once, signs with the project's release key, and uploads
these assets to that exact Release:

- `multicc.apk`
- `multicc.apk.json`
- `multicc.apk.sha256`

Before publishing the first asset-bearing tag, configure the protected GitHub
Environment named `android-release` with
`ANDROID_RELEASE_KEYSTORE_BASE64`, `ANDROID_RELEASE_STORE_PASSWORD`,
`ANDROID_RELEASE_KEY_ALIAS`, `ANDROID_RELEASE_KEY_PASSWORD`, and
`ANDROID_RELEASE_CERT_SHA256`. The workflow fails closed when signing material
is absent or the tag does not exactly match `package.json`. The public
certificate fingerprint is pinned in `app/android/release-cert.sha256`; both
the release workflow and the runtime Release-manifest verifier require an exact
match, while the private key remains outside Git.

The internal `scripts/publish-apk.sh` helper is reserved for that release
pipeline. Flutter and the Android toolchain are release-maintainer/CI
prerequisites, not server installation prerequisites.

At runtime the APK source is deterministic:

1. A non-empty regular `public/multicc.apk` wins as a local/offline operator
   override.
2. Otherwise MultiCC requests the GitHub Release whose tag is exactly
   `v<package.json version>`, validates its APK metadata sidecar, and uses that
   release's `multicc.apk` asset.
3. It does not use `latest`, an older release, or a newer release. If the exact
   release or verified asset is absent, the dashboard reports no APK available.

`/multicc.apk` serves the local file directly or redirects to the verified exact
Release Asset. The access token is never forwarded to GitHub. Releases before v1.6.1 predate
this asset workflow and have no remote APK; the fallback is available from
v1.6.1.

The first official release-key APK cannot update an APK previously signed with
an Android debug key. Users must uninstall that debug-signed app once before
installing the official build. The release keystore and credentials must be
backed up for the lifetime of the app: losing the key prevents all future
in-place upgrades.

For iOS development, build locally (Xcode and signing are still required for an
installable package):

```bash
cd app
flutter build ios --release --no-codesign
```

---

[← Back to the README](../README.md)
