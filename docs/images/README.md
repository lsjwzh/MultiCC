# README demo assets

Screenshots and GIFs referenced by the top-level `README.md` / `README.zh.md`
live here.

## Registered (v2.0 README revision)

The following screenshots are already referenced by the READMEs. Capture them in
the docker test environment (or any clean instance), redact secrets, and commit
them under these exact paths:

| File | What it should show | Referenced from |
|---|---|---|
| `air-first-run.png` | The `/air` first-run setup card (prepare a model + configure AI Assistant). | Quick Start, step 2 |
| `air-tasks.png` | The `/air` directory home — the task-first main surface (formerly the `manage-dashboard.png` wishlist item; `/manage` now redirects to `/air`). | "The Air console" section |
| `air-new-task.png` | The new-task composer with the AI configuration pill (CLI / line / model). | Quick Start, step 3 |
| `air-provider.png` | CLI and provider settings in the Air console. | Models & cost / features |
| `aux-console.png` | The AI Assistant (aux) console page. | Features |
| `air-mobile.png` | MultiCC on a phone-width screen (the `/air` directory home in a 390px viewport). | Quick Start, mobile step |

## English captures (`docs/images/en/`)

`README.md` (English) references the English copies in `docs/images/en/`;
`README.zh.md` keeps the Chinese captures above. The English set is generated
deterministically against a mocked fixture — no live server, no secrets:

```bash
node scripts/capture-readme-shots.js            # all six
node scripts/capture-readme-shots.js air-mobile # a single shot
```

## Still wanted

| File | What it should show | Suggested capture |
|---|---|---|
| `cli-switch.gif` | The headline feature: a live chat mid-task, opening the CLI badge in the chat header, switching `claude` → `codex`, sending a follow-up that the new CLI answers with full context, then switching back. Keep it under ~15 s and ~3 MB. | 1280×720 browser window, `/chat` page, light or dark theme (be consistent across assets). |

## Conventions

- Redact any real access token, provider API key, or private repository path
  before committing — the console displays tokens in the connection panel.
- Prefer GIF over video so it plays inline on GitHub.
- Reference assets from the README as `docs/images/<file>`, and uncomment the
  corresponding block once the file exists.

---

[← Back to the README](../../README.md)
