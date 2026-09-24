#!/usr/bin/env python3
"""Run Browser Use's Harness against a dedicated local Chromium profile."""

import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen


NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
SMOKE_HTML = "data:text/html,<title>MultiCC Browser Use Smoke</title><h1>MultiCC Browser Use Smoke</h1>"
SMOKE_TITLE = "MultiCC Browser Use Smoke"


def profile_path(name):
    if not NAME_RE.fullmatch(name):
        raise ValueError("name must be 1-64 ASCII letters, digits, underscores or hyphens")
    return Path.home() / "Library" / "Application Support" / "MultiCC" / "browser-use" / name


def chrome_args(executable, directory, port, headless):
    if not 1024 <= port <= 65535:
        raise ValueError("port must be between 1024 and 65535")
    args = [str(executable), f"--user-data-dir={directory}",
            f"--remote-debugging-port={port}", "--remote-debugging-address=127.0.0.1",
            "--no-first-run", "--no-default-browser-check"]
    if headless:
        args.append("--headless")
    args.append("about:blank")
    return args


def require_free_loopback_port(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise RuntimeError(f"CDP port {port} is already in use; choose another per-profile port")


def wait_for_cdp(port, process, timeout=20):
    url = f"http://127.0.0.1:{port}/json/version"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"browser exited before CDP was ready (exit {process.returncode})")
        try:
            with urlopen(url, timeout=1) as response:
                data = json.load(response)
            if data.get("webSocketDebuggerUrl") and data.get("Browser"):
                return url.removesuffix("/json/version"), data["Browser"]
        except (OSError, URLError, ValueError):
            pass
        time.sleep(0.2)
    raise RuntimeError(f"CDP endpoint did not become ready at {url}")


def stop_owned_browser(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def smoke_program(screenshot):
    return ("new_tab(" + json.dumps(SMOKE_HTML) + ")\n"
            "wait_for_load()\n"
            "title = js('document.title')\n"
            "assert title == " + json.dumps(SMOKE_TITLE) + ", repr(title)\n"
            "capture_screenshot(" + json.dumps(str(screenshot)) + ")\n"
            "print('MULTICC_BROWSER_USE_SMOKE_OK title=' + title)\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("start", "smoke"))
    parser.add_argument("--browser", required=True, type=Path,
                        help="path to a Chromium-family executable that runs on this macOS")
    parser.add_argument("--name", default="default", help="stable business/account profile name")
    parser.add_argument("--port", type=int, default=9229, help="unique loopback CDP port")
    parser.add_argument("--headless", action="store_true", help="do not show a window")
    parser.add_argument("--log-dir", type=Path, help="smoke output directory; default: temporary directory")
    parser.add_argument("--browser-use-bin", default="browser-harness",
                        help="Browser Harness (default) or Browser Use CLI executable")
    args = parser.parse_args(argv)

    if platform.system() != "Darwin":
        parser.error("this launcher currently targets macOS; use Browser Use directly elsewhere")
    if not args.browser.is_file() or not os.access(args.browser, os.X_OK):
        parser.error("--browser must name an existing executable; no browser is downloaded automatically")
    try:
        durable_profile = profile_path(args.name)
        chrome_args(args.browser, durable_profile, args.port, args.headless)
    except ValueError as error:
        parser.error(str(error))

    if args.mode == "smoke":
        log_dir = args.log_dir or Path(tempfile.mkdtemp(prefix="multicc-browser-use-smoke-"))
        log_dir.mkdir(parents=True, exist_ok=True)
        profile = Path(tempfile.mkdtemp(prefix="multicc-browser-use-profile-"))
    else:
        profile = durable_profile
        profile.mkdir(parents=True, exist_ok=True)
        log_dir = profile.parent

    require_free_loopback_port(args.port)
    log_file = log_dir / f"{args.name}-browser.log"
    with log_file.open("ab") as browser_log:
        process = subprocess.Popen(chrome_args(args.browser, profile, args.port, args.headless),
                                   stdin=subprocess.DEVNULL, stdout=browser_log, stderr=browser_log)
        try:
            endpoint, version = wait_for_cdp(args.port, process)
            print(f"browser={version} profile={profile} cdp={endpoint} log={log_file}", flush=True)
            if args.mode == "start":
                print(f"Use BU_CDP_URL={endpoint} BU_NAME={args.name} {args.browser_use_bin}; "
                      "Ctrl-C stops only this browser.",
                      flush=True)
                try:
                    process.wait()
                    return process.returncode
                except KeyboardInterrupt:
                    return 130

            cli = shutil.which(args.browser_use_bin)
            if not cli:
                raise RuntimeError(f"Browser Use CLI not found: {args.browser_use_bin}")
            screenshot = log_dir / "smoke.png"
            env = os.environ.copy()
            env.update({"BU_CDP_URL": endpoint, "BU_NAME": f"multicc-smoke-{os.getpid()}",
                        "BH_TAB_MARKER": "0"})
            result = subprocess.run([cli], input=smoke_program(screenshot), text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    env=env, timeout=90, check=False)
            output = log_dir / "browser-use.log"
            output.write_text(result.stdout, encoding="utf-8")
            if result.returncode or "MULTICC_BROWSER_USE_SMOKE_OK" not in result.stdout or not screenshot.is_file():
                raise RuntimeError(f"Browser Use smoke failed (exit {result.returncode}); inspect {output}")
            print(f"PASS title={SMOKE_TITLE} screenshot={screenshot} log={output}", flush=True)
            return 0
        finally:
            stop_owned_browser(process)
            if args.mode == "smoke":
                shutil.rmtree(profile)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"FAIL {error}", file=sys.stderr)
        sys.exit(1)
