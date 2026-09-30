#!/usr/bin/env python3
"""Read-only probe: pick a MultiCC browser route for this Mac's OS tier.

Runs on the system python3 of macOS 11 (3.8) so it can be used before any
setup. It never launches a browser, never touches a profile and never
downloads anything; it only reads app bundles, PATH, `node -v` and the MultiCC
Agent status, then prints a tier plus ordered routes.

The default route on every tier is MultiCC's own executor, `mbrowser`
(<skill_dir>/bin/mbrowser): it ships with the Node runtime MultiCC installs.
BrowserAct, OpenClaw and Browser Harness stay listed as opt-in alternatives —
`which` finding their CLI is not proof they can drive a browser here, so none
of them is ever reported as `available` or picked as the default `choice`.
"""

import argparse
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import socket
import subprocess
import sys


# Chromium-family apps that expose CDP with a dedicated --user-data-dir.
APP_NAMES = ("Google Chrome for Testing", "Chromium", "Google Chrome", "Microsoft Edge",
             "Brave Browser", "Google Chrome Canary")
SKILL_DIR = Path(__file__).resolve().parent.parent
MBROWSER_BIN = SKILL_DIR / "bin" / "mbrowser"
LOCAL_BROWSER_USE = SKILL_DIR / "scripts" / "local_browser_use.py"
AGENT_BIN = Path(os.environ.get("MULTICC_AGENT_BIN", str(Path.home() / ".multicc/bin/multicc-agent")))
HARNESS_VENV_BIN = Path.home() / ".local/share/multicc-browser-use-venv/bin/browser-harness"
FIRST_DEDICATED_PORT = 9331
MIN_NODE_MAJOR = 22
HARNESS_MIN_PYTHON = (3, 11)

# Last major that still ships for each legacy macOS; Edge/Brave follow the
# same Chromium cutoffs. Informational only: compatibility is decided from each
# app's LSMinimumSystemVersion, not from this table.
FROZEN_CHROME = {11: 138, 12: 150}


def version_tuple(text):
    parts = []
    for piece in str(text or "").split("."):
        digits = "".join(ch for ch in piece if ch.isdigit())
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


def tier_for(os_version):
    major = (os_version or (0,))[0]
    if major < 11:
        return "unsupported"
    if major <= 12:
        return "legacy"
    if major == 13:
        return "transitional"
    return "current"


def run_quiet(argv, timeout=8):
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode:
        return None
    return result.stdout.decode("utf-8", "replace").strip()


def app_bundle_for(executable):
    for parent in Path(executable).parents:
        if parent.suffix == ".app":
            return parent
    return None


def inspect_app(app, os_version, machine):
    """Describe one .app bundle; compatible is True/False/None (unknown)."""
    try:
        with (app / "Contents/Info.plist").open("rb") as handle:
            info = plistlib.load(handle)
    except (OSError, ValueError, plistlib.InvalidFileException):
        return None
    executable = app / "Contents/MacOS" / str(info.get("CFBundleExecutable", ""))
    if not executable.is_file():
        return None
    minimum = info.get("LSMinimumSystemVersion") or ""
    entry = {"app": str(app), "executable": str(executable),
             "version": info.get("CFBundleShortVersionString") or "",
             "minimumMacOS": minimum, "archs": [], "compatible": None, "why": ""}
    if minimum and os_version:
        if os_version < version_tuple(minimum):
            entry["compatible"] = False
            entry["why"] = f"needs macOS {minimum}"
        else:
            entry["compatible"] = True
    archs = run_quiet(["lipo", "-archs", str(executable)])
    if archs:
        entry["archs"] = archs.split()
        # Apple silicon runs x86_64 through Rosetta; Intel cannot run arm64-only.
        if machine == "x86_64" and "x86_64" not in entry["archs"]:
            entry["compatible"] = False
            entry["why"] = "no x86_64 slice for this Intel Mac"
    if entry["compatible"] is None and not entry["why"]:
        entry["why"] = "LSMinimumSystemVersion missing; smoke on this Mac decides"
    if app.name == "Google Chrome.app":
        entry["note"] = "personal Chrome app: use only with a dedicated --user-data-dir, never its own profile"
    return entry


def find_browsers(os_version, machine, extra=()):
    seen, found = set(), []
    candidates = [Path(root) / f"{name}.app"
                  for root in ("/Applications", str(Path.home() / "Applications"))
                  for name in APP_NAMES]
    for path in extra:
        candidates.append(app_bundle_for(path) or Path(path))
    for app in candidates:
        key = str(app)
        if key in seen or app.suffix != ".app" or not app.is_dir():
            continue
        seen.add(key)
        entry = inspect_app(app, os_version, machine)
        if entry:
            found.append(entry)
    return found


def which_any(*names):
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    return None


def probe_node():
    """Locate the Node runtime that runs `mbrowser` (needs major >= 22).

    MULTICC_NODE wins over PATH because MultiCC pins the runtime it ships and
    puts on PATH. `node -v` is read-only, like the other probes here.
    """
    report = {"path": None, "version": None, "ok": False, "minMajor": MIN_NODE_MAJOR}
    for candidate in (os.environ.get("MULTICC_NODE"), shutil.which("node")):
        if not candidate:
            continue
        version = run_quiet([candidate, "-v"])
        if version is None:
            continue
        entry = {"path": candidate, "version": version.lstrip("v") or None,
                 "ok": version_tuple(version.lstrip("v")) >= (MIN_NODE_MAJOR,)}
        if entry["ok"]:
            return entry
        if report["path"] is None:
            report.update(entry)
    return report


def python_interpreter():
    """Interpreter to write into suggested commands, or None below 3.11.

    sys.executable is preferred so the printed command matches the interpreter
    already running here; otherwise the first 3.11+ python3 on PATH.
    """
    if sys.executable and version_tuple(platform.python_version()) >= HARNESS_MIN_PYTHON:
        return sys.executable
    return which_any("python3.13", "python3.12", "python3.11")


def probe_tools():
    harness = which_any("browser-harness") or (str(HARNESS_VENV_BIN) if HARNESS_VENV_BIN.is_file() else None)
    python = python_interpreter()
    return {
        "browserHarness": {"path": harness,
                           "version": run_quiet([harness, "--version"]) if harness else None},
        "python311Plus": python,
        "node": probe_node(),
        "uv": which_any("uv"),
        "browserAct": which_any("browser-act"),
        "openclaw": which_any("openclaw"),
    }


def probe_agent():
    if not (AGENT_BIN.is_file() and os.access(str(AGENT_BIN), os.X_OK)):
        return {"installed": False}
    raw = run_quiet([str(AGENT_BIN), "status"], timeout=5)
    try:
        status = json.loads(raw or "")
    except ValueError:
        return {"installed": True, "running": False}
    chrome = status.get("chrome") or {}
    return {"installed": True, "running": bool(status.get("ok")), "version": status.get("version"),
            "accessibility": bool(status.get("accessibility")),
            "screenRecording": bool(status.get("screenRecording")),
            "escMonitor": bool(status.get("escMonitor")),
            "captureBackends": (status.get("platform") or {}).get("captureBackends") or [],
            "chromeWatchdogPort": chrome.get("port") if chrome.get("enabled") else None}


def port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) != 0


def suggest_port(reserved):
    for port in range(FIRST_DEDICATED_PORT, FIRST_DEDICATED_PORT + 50):
        if port not in reserved and port_free(port):
            return port
    return None


def route(route_id, status, why, next_step, foreground=False, consent=False, label=None):
    return {"id": route_id, "status": status, "why": why, "next": next_step,
            "foreground": foreground, "requiresConsent": consent, "label": label}


def plan_routes(tier, browsers, tools, agent, port):
    """Ordered routes. Only the first 'available' one is the default choice.

    `multicc` (MultiCC's own `mbrowser`) is the only route that can ever be
    `available`; the third-party executors are opt-in and are listed with a
    status that keeps them out of `choice`.
    """
    compatible = [b for b in browsers if b["compatible"]]
    # A dedicated testing/Chromium build beats reusing the personal Chrome app.
    browser = compatible[0] if compatible else None
    harness_bin = tools["browserHarness"]["path"]
    python_bin = tools.get("python311Plus")
    node = tools.get("node") or {}

    if node.get("ok") and browser:
        why = (f"MultiCC mbrowser on a dedicated persistent profile "
               f"({Path(browser['app']).name} {browser['version']}, node {node['version']})")
        if tier == "legacy":
            why += "; legacy engine with no further security updates, keep real accounts off it unless the user accepts the risk"
        mbrowser = route("multicc", "available", why, f"{MBROWSER_BIN} doctor", label="MultiCC mbrowser")
    elif not node.get("ok"):
        found = f"found node {node['version']}" if node.get("path") else "node not found"
        mbrowser = route("multicc", "needs-setup",
                         f"{found}; mbrowser needs Node >= {MIN_NODE_MAJOR} (MultiCC ships and pins it)",
                         "restart MultiCC so it installs/updates its Node runtime, or set MULTICC_NODE to a Node >= 22",
                         label="MultiCC mbrowser")
    else:
        mbrowser = route("multicc", "needs-setup",
                         "no Chromium-family app here runs on this macOS",
                         "obtain a trusted build whose LSMinimumSystemVersion fits (see references/macos-tiers.md); nothing is downloaded automatically",
                         label="MultiCC mbrowser")

    if not browser:
        harness = route("browser-harness", "needs-setup",
                        "no Chromium-family app here runs on this macOS",
                        "obtain a trusted build whose LSMinimumSystemVersion fits (see references/macos-tiers.md); nothing is downloaded automatically")
    elif not (harness_bin and python_bin):
        missing = "browser-harness" if not harness_bin else "Python >= 3.11"
        harness = route("browser-harness", "needs-setup",
                        f"compatible browser {browser['version']} found; {missing} missing, so this optional Python route cannot run",
                        "install browser-harness==0.1.13 in a Python 3.11+ venv (references/browser-use-local.md)")
    else:
        harness = route("browser-harness", "opt-in",
                        f"Browser Harness {tools['browserHarness']['version'] or ''} + dedicated profile; Python alternative, only when the user asks for it",
                        f"{python_bin} {LOCAL_BROWSER_USE} smoke --browser '{browser['executable']}' "
                        f"--browser-use-bin '{harness_bin}' --port {port or FIRST_DEDICATED_PORT} --headless")

    if not tools["browserAct"]:
        # The interpreter this Mac already has beats a hardcoded version that
        # no `python3.x` on PATH may satisfy.
        act = route("browser-act", "unavailable", "browser-act CLI not installed",
                    "only install after the user approves "
                    f"(uv tool install browser-act-cli --python {python_bin or '3.12'})")
    elif tier == "legacy":
        act = route("browser-act", "not-recommended",
                    "opt-in alternative; its managed browsers follow current Chromium, which no longer ships for macOS 11/12",
                    "only if the user explicitly asks, and only after a smoke on this Mac proves its browser starts")
    else:
        act = route("browser-act", "installed-unverified",
                    "opt-in alternative: the CLI is on PATH, which proves nothing about its browser or session here",
                    "only if the user explicitly asks: load the browser-act skill and its core guide, then verify a dedicated 'chrome' browser (never chrome-direct)")

    if not tools["openclaw"]:
        claw = route("openclaw", "unavailable", "openclaw CLI not installed", "see references/openclaw.md")
    elif tier == "legacy":
        claw = route("openclaw", "not-recommended",
                     "opt-in alternative; managed profiles launch current Chrome",
                     "only if the user explicitly asks, and only after verifying Gateway and browser start on this Mac")
    else:
        claw = route("openclaw", "installed-unverified",
                     "opt-in alternative: CLI present; Gateway and managed profile unverified",
                     "only if the user explicitly asks: follow references/openclaw.md preflight")

    if not agent.get("installed"):
        desk = route("agent-desktop", "unavailable", "MultiCC Agent not installed (MultiCC installs it at startup)",
                     "restart MultiCC or run scripts/install-agent.sh", True, True)
    elif not (agent.get("running") and agent.get("accessibility") and agent.get("screenRecording")):
        desk = route("agent-desktop", "needs-setup", "Agent lacks Accessibility or Screen Recording, or is not running",
                     "ask the user to grant it in System Settings/Preferences (multicc-computer-use)", True, True)
    else:
        desk = route("agent-desktop", "available",
                     "desktop AX/coordinate control only; no DOM, not a CDP replacement",
                     "only after the user explicitly agrees to foreground desktop work: use multicc-computer-use",
                     True, True)

    ordered = [harness, act, claw] if tier == "legacy" else [act, harness, claw]
    return [mbrowser] + ordered + [desk]


def notes_for(tier, os_version):
    major = (os_version or (0,))[0]
    if tier == "unsupported":
        return ["macOS 10.15 or older: no MultiCC browser route; run the browser layer on a supported Mac"]
    if tier == "legacy":
        return [f"macOS {major}: Chrome stops at {FROZEN_CHROME.get(major)} with no further security updates; "
                "keep real accounts off it unless the user accepts the risk",
                f"mbrowser still works on this tier with a compatible engine (Chrome for Testing {FROZEN_CHROME.get(major)} or older)",
                "never fall back to the personal Chrome, a cloud browser or the Agent desktop silently"]
    if tier == "transitional":
        return ["macOS 13: current Chrome still ships; Agent screenshots use screencapture, not ScreenCaptureKit"]
    return ["macOS 14+: current Chrome/Edge/Chromium/Brave all work with mbrowser; prefer dedicated persistent profiles",
            "BrowserAct/OpenClaw/Browser Harness are opt-in alternatives, not defaults"]


def probe(extra_browsers=()):
    mac, _, machine = platform.mac_ver()
    os_version = version_tuple(mac)
    machine = machine or platform.machine()
    translated = run_quiet(["sysctl", "-in", "sysctl.proc_translated"]) == "1"
    if translated:
        machine = "arm64"
    tier = tier_for(os_version)
    browsers = find_browsers(os_version, machine, extra_browsers)
    tools = probe_tools()
    agent = probe_agent()
    reserved = {agent.get("chromeWatchdogPort")} - {None}
    port = suggest_port(reserved)
    routes = plan_routes(tier, browsers, tools, agent, port)
    # Only `available` counts. Opt-in statuses (`opt-in`, `installed-unverified`,
    # `not-recommended`) and every foreground route are deliberately excluded,
    # so the third-party executors can never become the default.
    choice = next((r["id"] for r in routes if r["status"] == "available" and not r["foreground"]), None)
    return {"os": {"version": mac, "machine": machine, "tier": tier},
            "browsers": browsers, "tools": tools, "agent": agent,
            "suggestedPort": port, "reservedPorts": sorted(reserved),
            "routes": routes, "choice": choice, "notes": notes_for(tier, os_version)}


def render(report):
    os_info = report["os"]
    lines = [f"macOS {os_info['version'] or '?'} ({os_info['machine']}) tier={os_info['tier']}"]
    for browser in report["browsers"]:
        mark = {True: "ok", False: "NO", None: "??"}[browser["compatible"]]
        detail = f" ({browser['why']})" if browser["why"] else ""
        lines.append(f"  [{mark}] {Path(browser['app']).name} {browser['version']} "
                     f"min={browser['minimumMacOS'] or '-'}{detail}")
    if not report["browsers"]:
        lines.append("  no Chromium-family app found")
    node = (report.get("tools") or {}).get("node") or {}
    lines.append(f"  node: {node.get('path') or 'not found'} "
                 f"{node.get('version') or '-'} (needs >= {node.get('minMajor', MIN_NODE_MAJOR)})")
    lines.append("routes:")
    for item in report["routes"]:
        flags = " [foreground, needs consent]" if item["foreground"] else ""
        label = f" ({item['label']})" if item.get("label") else ""
        lines.append(f"  {item['id']}{label}: {item['status']}{flags} - {item['why']}")
        lines.append(f"    next: {item['next']}")
    lines.append(f"choice={report['choice'] or 'none'} suggestedPort={report['suggestedPort']}")
    lines.extend(f"note: {note}" for note in report["notes"])
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true", help="print the full machine-readable report")
    parser.add_argument("--browser", action="append", default=[],
                        help="extra Chromium-family executable or .app to check (repeatable)")
    args = parser.parse_args(argv)
    if platform.system() != "Darwin":
        parser.error("this probe targets macOS")
    report = probe(args.browser)
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else render(report))
    return 0 if report["choice"] else 2


if __name__ == "__main__":
    sys.exit(main())
