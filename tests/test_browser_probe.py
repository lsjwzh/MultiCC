"""Standard-library checks for the tiered macOS browser probe."""

import importlib.util
from pathlib import Path
import plistlib
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
SCRIPTS = Path(__file__).resolve().parents[1] / "skills/multicc-browser/scripts"


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sys.path.insert(0, str(SCRIPTS))
probe = load("browser_probe")
launcher = load("local_browser_use")


def fake_app(root, name, version, minimum):
    app = Path(root) / f"{name}.app"
    (app / "Contents/MacOS").mkdir(parents=True)
    executable = app / "Contents/MacOS" / name
    executable.write_text("#!/bin/sh\n")
    info = {"CFBundleExecutable": name, "CFBundleShortVersionString": version}
    if minimum:
        info["LSMinimumSystemVersion"] = minimum
    with (app / "Contents/Info.plist").open("wb") as handle:
        plistlib.dump(info, handle)
    return app, executable


TOOLS_NONE = {"browserHarness": {"path": None, "version": None}, "python311Plus": None,
              "uv": None, "browserAct": None, "openclaw": None}
TOOLS_ALL = {"browserHarness": {"path": "/bin/browser-harness", "version": "0.1.13"},
             "python311Plus": "/bin/python3.12", "uv": "/bin/uv",
             "browserAct": "/bin/browser-act", "openclaw": "/bin/openclaw"}
AGENT_READY = {"installed": True, "running": True, "accessibility": True, "screenRecording": True}


class BrowserProbeTests(unittest.TestCase):
    def test_tiers_follow_chrome_support_windows(self):
        cases = {(10, 15, 7): "unsupported", (11, 7, 10): "legacy", (12, 7): "legacy",
                 (13, 6): "transitional", (14, 0): "current", (26, 0): "current"}
        for version, tier in cases.items():
            with self.subTest(version=version):
                self.assertEqual(probe.tier_for(version), tier)
        self.assertEqual(probe.version_tuple("11.7.10"), (11, 7, 10))
        self.assertEqual(probe.version_tuple("13.0"), (13, 0))

    def test_bundle_minimum_decides_compatibility(self):
        with tempfile.TemporaryDirectory() as directory:
            old, _ = fake_app(directory, "Chromium", "138.0.7204.0", "11.0")
            new, _ = fake_app(directory, "Google Chrome", "153.0.1", "13.0")
            unknown, _ = fake_app(directory, "Brave Browser", "1.0", "")
            with patch.object(probe, "run_quiet", return_value=None):
                self.assertTrue(probe.inspect_app(old, (11, 7), "x86_64")["compatible"])
                entry = probe.inspect_app(new, (11, 7), "x86_64")
                self.assertFalse(entry["compatible"])
                self.assertIn("13.0", entry["why"])
                self.assertIn("dedicated", entry["note"])
                self.assertIsNone(probe.inspect_app(unknown, (11, 7), "x86_64")["compatible"])
            with patch.object(probe, "run_quiet", return_value="arm64"):
                self.assertFalse(probe.inspect_app(old, (11, 7), "x86_64")["compatible"])
                self.assertTrue(probe.inspect_app(old, (11, 7), "arm64")["compatible"])

    def test_legacy_prefers_harness_and_never_picks_desktop(self):
        browsers = [{"app": "/A/Chromium.app", "executable": "/A/Chromium.app/Contents/MacOS/Chromium",
                     "version": "138.0", "compatible": True}]
        routes = probe.plan_routes("legacy", browsers, TOOLS_ALL, AGENT_READY, 9331)
        self.assertEqual([r["id"] for r in routes],
                         ["browser-harness", "browser-act", "openclaw", "agent-desktop"])
        self.assertEqual(routes[0]["status"], "available")
        self.assertIn("--port 9331", routes[0]["next"])
        self.assertEqual(routes[1]["status"], "not-recommended")
        desk = routes[-1]
        self.assertTrue(desk["foreground"] and desk["requiresConsent"])

        stuck = probe.plan_routes("legacy", [], TOOLS_ALL, AGENT_READY, 9331)
        self.assertEqual(stuck[0]["status"], "needs-setup")
        self.assertIsNone(next((r["id"] for r in stuck
                                if r["status"] == "available" and not r["foreground"]), None))

    def test_current_prefers_browser_act_when_installed(self):
        routes = probe.plan_routes("current", [], TOOLS_ALL, {"installed": False}, 9331)
        self.assertEqual(routes[0]["id"], "browser-act")
        self.assertEqual(routes[0]["status"], "available")
        self.assertIn("chrome-direct", routes[0]["next"])
        bare = probe.plan_routes("current", [], TOOLS_NONE, {"installed": False}, None)
        self.assertEqual({r["status"] for r in bare}, {"unavailable", "needs-setup"})

    def test_launcher_refuses_browser_built_for_newer_macos(self):
        with tempfile.TemporaryDirectory() as directory:
            _, executable = fake_app(directory, "Google Chrome", "153.0.1", "99.0")
            _, runs = fake_app(directory, "Chromium", "138.0", "10.0")
            with patch.object(probe, "run_quiet", return_value=None):
                self.assertIn("needs macOS 99.0", launcher.incompatibility(executable))
                self.assertIsNone(launcher.incompatibility(runs))
                self.assertIsNone(launcher.incompatibility(Path(directory) / "loose-binary"))


if __name__ == "__main__":
    unittest.main()
