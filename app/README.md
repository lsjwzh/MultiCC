# multicc_app

Native Flutter client for [MultiCC](../README.md) — a self-hosted server that
exposes one local `claude` CLI to many clients at once.

This package is the mobile/desktop companion to the MultiCC web UI. It talks
to the same `chat` WebSocket as `public/chat.js`, shares the same session
registry, and receives the same notifications.

## What's inside

- **Chat screen** — streaming message bubbles with tool cards, reconnect
  replay, and cancel/clear controls.
- **Multi-session sidebar** — swipe-to-close, unread badges, per-session cwd.
- **Voice input** — record via `record` plugin, upload to the server's Whisper
  endpoint, show raw + AI-refined text with SSE streaming.
- **Background notifications** via `flutter_local_notifications`, driven by the
  server's `waiting` / `completed` detector.
- **APK auto-update** — uses the server-selected `/multicc.apk`: a local package
  when present, otherwise the verified asset from the exact server release.

## Release and build

```bash
flutter build ios --release --no-codesign   # iOS (needs Xcode + signing to install)
```

Publishing a `vX.Y.Z` tag starts the GitHub release workflow. It builds Android
once, signs the APK with the project's long-lived release key, and uploads
`multicc.apk`, `multicc.apk.json`, and `multicc.apk.sha256` to that exact GitHub
Release. The internal `scripts/publish-apk.sh` helper belongs to this release
pipeline; there is no user-facing APK build command.

The server prefers a non-empty local `../public/multicc.apk` as an operator or
offline override. If it is absent, the server resolves only the verified
`multicc.apk` asset whose `vX.Y.Z` tag exactly matches `package.json`, and never
falls forward to GitHub's `latest` release. Installing or updating the server
never invokes Flutter or the Android toolchain. Release v1.5.2 has no APK asset;
remote fallback starts with the next release.

The first APK signed by the official release key cannot update a previously
installed debug-signed build in place. Uninstall the debug-signed app once, then
install the official build. Back up the release keystore and credentials for the
life of the application: losing them would break all future in-place upgrades.

## Package identifiers

| Platform | Identifier |
|----------|------------|
| Dart package | `multicc_app` |
| Android `applicationId` | `com.multicc.multicc_app` |
| iOS `PRODUCT_BUNDLE_IDENTIFIER` | `com.multicc.multiccApp` |

If you are upgrading from the old `webcc_app` builds, the new package
installs **alongside** the old one — uninstall the old app manually and
re-enter host / token / session on the setup screen.
