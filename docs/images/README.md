# README demo assets

Screenshots and GIFs referenced by the top-level `README.md` live here. Nothing
is committed yet — the README keeps the markup commented out so the page never
renders a broken image.

## Wanted

| File | What it should show | Suggested capture |
|---|---|---|
| `cli-switch.gif` | The headline feature: a live chat mid-task, opening the CLI badge in the chat header, switching `claude` → `codex`, sending a follow-up that the new CLI answers with full context, then switching back. Keep it under ~15 s and ~3 MB. | 1280×720 browser window, `/chat` page, light or dark theme (be consistent across assets). |
| `manage-dashboard.png` | `/manage` with two or three sessions in one directory, different CLIs, showing parallel worktrees. | Same window size. |
| `mobile-chat.png` | The Flutter app or mobile PWA on the same session, to make the "pick it up on your phone" claim concrete. | Device frame optional. |

## Conventions

- Redact any real access token, provider API key, or private repository path
  before committing — the dashboard displays tokens in the connection panel.
- Prefer GIF over video so it plays inline on GitHub.
- Reference assets from the README as `docs/images/<file>`, and uncomment the
  corresponding block once the file exists.

---

[← Back to the README](../../README.md)
