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

sys.dont_write_bytecode = True  # keep the installed skill directory free of __pycache__
sys.path.insert(0, str(Path(__file__).resolve().parent))
import browser_probe  # noqa: E402  (sibling script, shared bundle checks)


NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
SOURCE_PROFILE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,63}$")
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
            "--no-first-run", "--no-default-browser-check", "--profile-directory=Default"]
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


def incompatibility(executable):
    """Reason the browser's app bundle declares it cannot run on this macOS, else None."""
    app = browser_probe.app_bundle_for(executable)
    if not app:
        return None
    mac, _, machine = platform.mac_ver()
    entry = browser_probe.inspect_app(app, browser_probe.version_tuple(mac), machine or platform.machine())
    if entry and entry["compatible"] is False:
        return f"{app.name} {entry['version']} cannot run here: {entry['why']}"
    return None


def stop_owned_browser(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def seed_profile(source_root, source_profile, target_root):
    """One-time, offline copy into a dedicated profile; never modify the source."""
    if not SOURCE_PROFILE_RE.fullmatch(source_profile):
        raise ValueError("source profile must be a single Chrome profile directory name")
    source_root = source_root.expanduser().resolve()
    target_root = target_root.expanduser()
    if target_root.exists() or target_root.is_symlink():
        raise RuntimeError(f"target already exists; refusing to overwrite: {target_root}")
    if (source_root / "Local State").is_symlink() or not (source_root / "Local State").is_file():
        raise RuntimeError(f"not a Chrome user-data directory (Local State missing): {source_root}")
    source_dir = source_root / source_profile
    if source_dir.is_symlink() or (source_dir / "Preferences").is_symlink() or not (source_dir / "Preferences").is_file():
        raise RuntimeError(f"Chrome profile Preferences missing: {source_dir}")
    lock = source_root / "SingletonLock"
    if lock.is_symlink():
        match = re.search(r"-(\d+)$", os.readlink(lock))
        if not match:
            raise RuntimeError("source Chrome lock cannot be checked; close Chrome and inspect it before seeding")
        try:
            os.kill(int(match.group(1)), 0)
        except ProcessLookupError:
            pass
        except PermissionError:
            raise RuntimeError("source Chrome may still be running; close it before seeding")
        else:
            raise RuntimeError("source Chrome is running; close it before seeding")
    elif lock.exists():
        raise RuntimeError("source Chrome lock exists; close it before seeding")

    target_root.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{target_root.name}-seed-", dir=target_root.parent))
    try:
        def ignore_ephemeral(directory, names):
            ignored = {"Cache", "Code Cache", "GPUCache", "GrShaderCache", "Crashpad",
                       "DevToolsActivePort", "SingletonCookie", "SingletonLock", "SingletonSocket"}
            return {name for name in names if name in ignored or (Path(directory) / name).is_symlink()}

        shutil.copy2(source_root / "Local State", staging / "Local State")
        shutil.copytree(source_dir, staging / "Default", ignore=ignore_ephemeral)
        os.chmod(staging, 0o700)
        staging.rename(target_root)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return target_root


def smoke_program(screenshot):
    return ("new_tab(" + json.dumps(SMOKE_HTML) + ")\n"
            "wait_for_load()\n"
            "title = js('document.title')\n"
            "assert title == " + json.dumps(SMOKE_TITLE) + ", repr(title)\n"
            "capture_screenshot(" + json.dumps(str(screenshot)) + ")\n"
            "print('MULTICC_BROWSER_USE_SMOKE_OK title=' + title)\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("seed", "start", "smoke"))
    parser.add_argument("--browser", type=Path,
                        help="path to a Chromium-family executable that runs on this macOS")
    parser.add_argument("--source-user-data-dir", type=Path,
                        default=Path.home() / "Library/Application Support/Google/Chrome",
                        help="Chrome user-data root to copy from; used only by seed")
    parser.add_argument("--source-profile", default="Default",
                        help="source Chrome profile directory, e.g. Default or Profile 1")
    parser.add_argument("--confirm-source-closed", action="store_true",
                        help="confirm the source browser is fully closed before seed")
    parser.add_argument("--name", default="default", help="stable business/account profile name")
    parser.add_argument("--port", type=int, default=9331, help="unique loopback CDP port (9222 is the Agent watchdog, 9229 Node inspector)")
    parser.add_argument("--headless", action="store_true", help="do not show a window")
    parser.add_argument("--log-dir", type=Path, help="smoke output directory; default: temporary directory")
    parser.add_argument("--browser-use-bin", default="browser-harness",
                        help="Browser Harness (default) or Browser Use CLI executable")
    args = parser.parse_args(argv)

    if platform.system() != "Darwin":
        parser.error("this launcher currently targets macOS; use Browser Use directly elsewhere")
    try:
        durable_profile = profile_path(args.name)
    except ValueError as error:
        parser.error(str(error))

    if args.mode == "seed":
        if not args.confirm_source_closed:
            parser.error("seed requires --confirm-source-closed; quit the source Chrome first")
        try:
            target = seed_profile(args.source_user_data_dir, args.source_profile, durable_profile)
        except (OSError, RuntimeError, ValueError) as error:
            parser.error(str(error))
        print(f"SEEDED profile={target} source-profile={args.source_profile}; verify login in the dedicated browser", flush=True)
        return 0

    if not args.browser or not args.browser.is_file() or not os.access(args.browser, os.X_OK):
        parser.error("--browser must name an existing executable; no browser is downloaded automatically")
    reason = incompatibility(args.browser)
    if reason:
        parser.error(reason + "; run scripts/browser_probe.py to list browsers that fit this macOS")
    try:
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
