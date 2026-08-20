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
- **APK auto-update** — polls `/multicc.apk` mtime and prompts when a newer
  build is available.

## Build

```bash
../multicc apk                              # Android + publish to ../public/multicc.apk
flutter build ios --release --no-codesign   # iOS (needs Xcode + signing to install)
```

The publisher builds the release APK and atomically copies it to the ignored
`../public/multicc.apk` local artifact. The `/manage` APK area can start the same
build in the background or explicitly rebuild it; an existing APK remains
downloadable until the new package is ready. Flutter and the Android toolchain
are build-time prerequisites only: installing or updating the MultiCC server
never invokes them.

## Package identifiers

| Platform | Identifier |
|----------|------------|
| Dart package | `multicc_app` |
| Android `applicationId` | `com.multicc.multicc_app` |
| iOS `PRODUCT_BUNDLE_IDENTIFIER` | `com.multicc.multiccApp` |

If you are upgrading from the old `webcc_app` builds, the new package
installs **alongside** the old one — uninstall the old app manually and
re-enter host / token / session on the setup screen.
