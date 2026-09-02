# Installation & service management

> Full install reference, migrated out of the README: install-script flags, updating, recovery from a force-push, prerequisites, the `./multicc` service manager, a systemd unit, and Flutter app builds.

## Stable Release (recommended)

```bash
curl -sSL https://raw.githubusercontent.com/lsjwzh/MultiCC/v1.6.8/install.sh | bash -s -- --branch v1.6.8
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

Detects your OS, checks prerequisites, clones the repo, installs dependencies, configures an access token, and optionally installs as a background service (macOS `launchd`). It never builds an APK; official APKs are release assets produced only when a version tag is published.

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

Updates never build or rebuild the APK. The dashboard uses a local APK when one
is present, otherwise it resolves the asset attached to the exact installed
release tag.

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

## Manual Install

```bash
git clone https://github.com/lsjwzh/MultiCC.git
cd MultiCC
npm install
node server.js
```

Open `http://localhost:3000/chat` to begin.

`install.sh` generates an `ACCESS_TOKEN`. If neither `HOST` nor
`MULTICC_ALLOW_REMOTE` is configured, that password-protected installation
automatically binds `0.0.0.0`, so other devices on the same IPv4 LAN can open:

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
