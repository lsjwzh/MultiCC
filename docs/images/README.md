# README screenshots

The top-level [English README](../../README.md) and [Chinese README](../../README.zh.md)
use the current web client under `public/`. The set was refreshed on **2026-10-31**
from **v2.12.1**. English captures live in `en/`; Chinese captures live here.

These are **UI illustrations with synthetic example data**, rendered by the real
web frontend against isolated API fixtures. They are not live production sessions,
real account activity, proof of an agent completing a task, or native Flutter
screenshots. The fixtures never access the running MultiCC host or personal Chrome
profiles, call a model, or contain credentials. Power and proxy settings illustrate
the controls; taking these screenshots does not change the host's configuration.

## Current set

Each filename below exists in both language directories.

| File | Visible screen | README placement |
|---|---|---|
| `air-tasks.png` | Workspace home with running, waiting, and idle example tasks; filters and the code/worktree card | Air console |
| `air-first-run.png` | Console's three-step first-run guide, before models or a workspace are configured | Quick Start |
| `air-new-task.png` | Run config with the current engine picker, route/model controls, and subagent section | Quick Start |
| `air-mobile.png` | The responsive web task list at a 390 CSS-pixel phone viewport | Phone access |
| `air-provider.png` | Model routes with terminal-login and separate-account cards, including cross-device sharing actions | Features |
| `aux-console.png` | AI Assistant model settings, idle status, and empty run history | Features |
| `air-account-proxy.png` | A Claude official account's dedicated proxy-identity binding | Proxies and accounts |
| `air-power.png` | Mac lid-closed operation, automatic unlock, and keychain authorization state | Lid-closed workflow |

Desktop captures use **1440 × 960 CSS pixels at 2×**. The phone capture uses
**390 × 844 CSS pixels at 2×**, scrolled to the task list. Dialog and list scrolling
uses normal UI scroll containers; the script does not rewrite product labels,
styles, or controls. It only freezes animation for capture. Some current English
controls still have untranslated labels; the screenshots retain those as shipped.

The linked 38-second lid-closed video in the READMEs is a separate, explicitly
labelled **illustrated scenario** (AI-generated people and interface animation).
It is not a live recording and is not part of this screenshot set.

## Re-capture

From the project root, with Node dependencies installed and local Chrome/Chromium
available:

```bash
node scripts/capture-readme-shots.js                         # all 16 images
node scripts/capture-readme-shots.js --lang=en               # English only
node scripts/capture-readme-shots.js --lang=zh air-first-run # one screen
```

Set `MULTICC_CHROME_BIN` if Chrome is outside the usual locations. The capture
harness uses temporary browser profiles and a loopback fixture server, closing
both after each capture. It serves the current `public/` files and the real Air
sync/read-index protocol, with example API responses. Missing required UI elements
fail the run instead of silently capturing the wrong page.

[`capture-manifest.json`](capture-manifest.json) records each image's language,
viewport, package version, capture time, PNG SHA-256, frontend-tree SHA-256 and
capture-script SHA-256. Partial regeneration updates only the requested entries,
so remaining older captures keep their original provenance. Re-capture the full
set whenever shared navigation or UI contracts change, then visually review each
image before replacing the README assets.

Older images in this directory may still be used by other documentation. They are
not members of this refreshed set; do not delete them without checking references.
