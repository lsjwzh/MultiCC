#!/usr/bin/env python3
"""Read-only probe: pick a MultiCC browser route for this Mac's OS tier.

Runs on the system python3 of macOS 11 (3.8) so it can be used before any
setup. It never launches a browser, never touches a profile and never
downloads anything; it only reads app bundles, PATH and the MultiCC Agent
status, then prints a tier plus ordered routes.
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
AGENT_BIN = Path(os.environ.get("MULTICC_AGENT_BIN", str(Path.home() / ".multicc/bin/multicc-agent")))
HARNESS_VENV_BIN = Path.home() / ".local/share/multicc-browser-use-venv/bin/browser-harness"
FIRST_DEDICATED_PORT = 9331

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


def probe_tools():
    harness = which_any("browser-harness") or (str(HARNESS_VENV_BIN) if HARNESS_VENV_BIN.is_file() else None)
    python = which_any("python3.13", "python3.12", "python3.11")
    return {
        "browserHarness": {"path": harness,
                           "version": run_quiet([harness, "--version"]) if harness else None},
        "python311Plus": python,
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


def route(route_id, status, why, next_step, foreground=False, consent=False):
    return {"id": route_id, "status": status, "why": why, "next": next_step,
            "foreground": foreground, "requiresConsent": consent}


def plan_routes(tier, browsers, tools, agent, port):
    """Ordered routes. Only the first 'available' one is the default choice."""
    compatible = [b for b in browsers if b["compatible"]]
    # A dedicated testing/Chromium build beats reusing the personal Chrome app.
    browser = compatible[0] if compatible else None
    script = "skills/multicc-browser/scripts/local_browser_use.py"
    harness_bin = tools["browserHarness"]["path"]

    if not browser:
        harness = route("browser-harness", "needs-setup",
                        "no Chromium-family app here runs on this macOS",
                        "obtain a trusted build whose LSMinimumSystemVersion fits (see references/macos-tiers.md); nothing is downloaded automatically")
    elif not (harness_bin and tools["python311Plus"]):
        harness = route("browser-harness", "needs-setup",
                        f"compatible browser {browser['version']} found; Python 3.11+ or browser-harness missing",
                        "install browser-harness==0.1.13 in a Python 3.12 venv (references/browser-use-local.md)")
    else:
        harness = route("browser-harness", "available",
                        f"{Path(browser['app']).name} {browser['version']} + dedicated profile over loopback CDP",
                        f"python3.12 {script} smoke --browser '{browser['executable']}' "
                        f"--browser-use-bin '{harness_bin}' --port {port or 9331} --headless")

    if not tools["browserAct"]:
        act = route("browser-act", "unavailable", "browser-act CLI not installed",
                    "only install after the user approves (uv tool install browser-act-cli --python 3.12)")
    elif tier == "legacy":
        act = route("browser-act", "not-recommended",
                    "its managed browsers follow current Chromium, which no longer ships for macOS 11/12",
                    "use only after a smoke on this Mac proves its browser starts")
    else:
        act = route("browser-act", "available", "verified local executor for current macOS",
                    "load the browser-act skill and its core guide; use a dedicated 'chrome' browser, not chrome-direct")

    if not tools["openclaw"]:
        claw = route("openclaw", "unavailable", "openclaw CLI not installed", "see references/openclaw.md")
    elif tier == "legacy":
        claw = route("openclaw", "not-recommended", "managed profiles launch current Chrome",
                     "verify Gateway and browser start on this Mac first")
    else:
        claw = route("openclaw", "needs-verify", "CLI present; Gateway and managed profile unverified",
                     "follow references/openclaw.md preflight")

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
    return ordered + [desk]


def notes_for(tier, os_version):
    major = (os_version or (0,))[0]
    if tier == "unsupported":
        return ["macOS 10.15 or older: no MultiCC browser route; run the browser layer on a supported Mac"]
    if tier == "legacy":
        return [f"macOS {major}: Chrome stops at {FROZEN_CHROME.get(major)} with no further security updates; "
                "keep real accounts off it unless the user accepts the risk",
                "never fall back to the personal Chrome, a cloud browser or the Agent desktop silently"]
    if tier == "transitional":
        return ["macOS 13: current Chrome still ships; Agent screenshots use screencapture, not ScreenCaptureKit"]
    return ["macOS 14+: all local routes supported; prefer dedicated persistent browsers over chrome-direct"]


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
    lines.append("routes:")
    for item in report["routes"]:
        flags = " [foreground, needs consent]" if item["foreground"] else ""
        lines.append(f"  {item['id']}: {item['status']}{flags} - {item['why']}")
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
