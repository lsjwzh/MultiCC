"""Standard-library checks for the tiered macOS browser probe."""

import contextlib
import importlib.util
import io
import os
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


NODE_OK = {"path": "/bin/node", "version": "26.8.1", "ok": True, "minMajor": 22}
NODE_OLD = {"path": "/bin/node", "version": "20.11.0", "ok": False, "minMajor": 22}
TOOLS_NONE = {"browserHarness": {"path": None, "version": None}, "python311Plus": None,
              "node": NODE_OLD, "uv": None, "browserAct": None, "openclaw": None}
TOOLS_ALL = {"browserHarness": {"path": "/bin/browser-harness", "version": "0.1.13"},
             "python311Plus": "/bin/python3.12", "node": NODE_OK, "uv": "/bin/uv",
             "browserAct": "/bin/browser-act", "openclaw": "/bin/openclaw"}
AGENT_READY = {"installed": True, "running": True, "accessibility": True, "screenRecording": True}
BROWSER = {"app": "/A/Chromium.app", "executable": "/A/Chromium.app/Contents/MacOS/Chromium",
           "version": "138.0", "compatible": True}


def with_tools(tools, **overrides):
    return dict(tools, **overrides)


def choice_of(routes):
    return next((r["id"] for r in routes if r["status"] == "available" and not r["foreground"]), None)


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

    def test_mbrowser_is_the_choice_on_every_tier(self):
        for tier in ("legacy", "transitional", "current"):
            with self.subTest(tier=tier):
                routes = probe.plan_routes(tier, [BROWSER], TOOLS_ALL, AGENT_READY, 9331)
                first = routes[0]
                self.assertEqual(first["id"], "multicc")
                self.assertEqual(first["status"], "available")
                self.assertEqual(first["label"], "MultiCC mbrowser")
                self.assertFalse(first["foreground"])
                self.assertEqual(choice_of(routes), "multicc")
                # `next` must be an absolute path into this skill install.
                self.assertEqual(first["next"], f"{probe.MBROWSER_BIN} doctor")
                self.assertTrue(Path(first["next"].split(" ")[0]).is_absolute())
                self.assertEqual(Path(first["next"].split(" ")[0]),
                                 SCRIPTS.parent / "bin/mbrowser")

    def test_mbrowser_needs_node_22_and_a_compatible_browser(self):
        old_node = with_tools(TOOLS_ALL, node=NODE_OLD)
        routes = probe.plan_routes("current", [BROWSER], old_node, AGENT_READY, 9331)
        self.assertEqual(routes[0]["id"], "multicc")
        self.assertEqual(routes[0]["status"], "needs-setup")
        self.assertIn("node 20.11.0", routes[0]["why"])
        self.assertIsNone(choice_of(routes), "no third-party route may become the default")

        no_browser = probe.plan_routes("legacy", [], TOOLS_ALL, AGENT_READY, 9331)
        self.assertEqual(no_browser[0]["status"], "needs-setup")
        self.assertIn("no Chromium-family app", no_browser[0]["why"])
        self.assertIsNone(choice_of(no_browser))

    def test_third_party_executors_are_opt_in_and_never_the_default(self):
        routes = probe.plan_routes("current", [BROWSER], TOOLS_ALL, {"installed": False}, 9331)
        by_id = {r["id"]: r for r in routes}
        self.assertEqual([r["id"] for r in routes],
                         ["multicc", "browser-act", "browser-harness", "openclaw", "agent-desktop"])
        self.assertEqual(by_id["browser-act"]["status"], "installed-unverified")
        self.assertEqual(by_id["browser-harness"]["status"], "opt-in")
        self.assertEqual(by_id["openclaw"]["status"], "installed-unverified")
        for route_id in ("browser-act", "browser-harness", "openclaw"):
            route = by_id[route_id]
            self.assertNotEqual(route["status"], "available",
                                "only mbrowser may be reported as the verified local executor")
            # Each opt-in route says who is allowed to ask for it.
            self.assertIn("user", f"{route['why']} {route['next']}")
        self.assertEqual(choice_of(routes), "multicc")
        # CLI on PATH is not evidence of a working executor.
        self.assertNotIn("verified local executor", by_id["browser-act"]["why"])
        # A suggested install command names an interpreter this Mac actually has.
        missing_act = {r["id"]: r for r in
                       probe.plan_routes("current", [BROWSER], with_tools(TOOLS_ALL, browserAct=None),
                                         AGENT_READY, 9331)}["browser-act"]
        self.assertIn("--python /bin/python3.12", missing_act["next"])

    def test_legacy_keeps_marking_third_party_routes_not_recommended(self):
        routes = probe.plan_routes("legacy", [BROWSER], TOOLS_ALL, AGENT_READY, 9331)
        self.assertEqual([r["id"] for r in routes],
                         ["multicc", "browser-harness", "browser-act", "openclaw", "agent-desktop"])
        by_id = {r["id"]: r for r in routes}
        self.assertEqual(by_id["browser-act"]["status"], "not-recommended")
        self.assertEqual(by_id["openclaw"]["status"], "not-recommended")
        self.assertIn("Chromium", by_id["browser-act"]["why"])
        desk = routes[-1]
        self.assertTrue(desk["foreground"] and desk["requiresConsent"])
        self.assertFalse(desk["label"])

    def test_missing_tools_report_what_is_missing(self):
        bare = probe.plan_routes("current", [], TOOLS_NONE, {"installed": False}, None)
        self.assertEqual({r["status"] for r in bare}, {"unavailable", "needs-setup"})
        self.assertIsNone(choice_of(bare))
        harness = {r["id"]: r for r in
                   probe.plan_routes("current", [BROWSER], with_tools(TOOLS_ALL, python311Plus=None),
                                     AGENT_READY, 9331)}["browser-harness"]
        self.assertEqual(harness["status"], "needs-setup")
        self.assertIn("Python >= 3.11", harness["why"])
        # Without a known interpreter the install hint falls back to a version
        # `uv` can provision itself, never to a path that does not exist.
        act = {r["id"]: r for r in
               probe.plan_routes("current", [BROWSER], with_tools(TOOLS_NONE, python311Plus=None),
                                 AGENT_READY, 9331)}["browser-act"]
        self.assertIn("--python 3.12", act["next"])

    def test_harness_command_is_absolute_and_uses_a_discovered_interpreter(self):
        routes = probe.plan_routes("current", [BROWSER], TOOLS_ALL, AGENT_READY, 9331)
        harness = {r["id"]: r for r in routes}["browser-harness"]
        self.assertTrue(probe.LOCAL_BROWSER_USE.is_absolute())
        self.assertTrue(harness["next"].startswith("/bin/python3.12 "))
        self.assertIn(f" {probe.LOCAL_BROWSER_USE} smoke ", harness["next"])
        self.assertNotIn("python3.12 skills/multicc-browser", harness["next"])
        with_port = probe.plan_routes("current", [BROWSER], TOOLS_ALL, AGENT_READY, None)
        self.assertIn(f"--port {probe.FIRST_DEDICATED_PORT}",
                      {r["id"]: r for r in with_port}["browser-harness"]["next"])

    def test_python_interpreter_prefers_this_one_and_needs_311(self):
        with patch.object(probe.platform, "python_version", return_value="3.12.4"), \
             patch.object(probe.sys, "executable", "/usr/local/bin/python3.12"):
            self.assertEqual(probe.python_interpreter(), "/usr/local/bin/python3.12")
        with patch.object(probe.platform, "python_version", return_value="3.9.6"), \
             patch.object(probe.sys, "executable", "/usr/bin/python3"), \
             patch.object(probe, "which_any", return_value="/opt/py3.13/bin/python3.13"):
            self.assertEqual(probe.python_interpreter(), "/opt/py3.13/bin/python3.13")
        with patch.object(probe.platform, "python_version", return_value="3.9.6"), \
             patch.object(probe.sys, "executable", "/usr/bin/python3"), \
             patch.object(probe, "which_any", return_value=None):
            self.assertIsNone(probe.python_interpreter())

    def test_node_probe_reads_env_then_path_and_requires_major_22(self):
        env = {"MULTICC_NODE": "/opt/multicc/node/bin/node"}
        with patch.dict(os.environ, env), \
             patch.object(probe, "run_quiet", return_value="v22.13.1"), \
             patch.object(probe.shutil, "which", return_value="/usr/local/bin/node"):
            entry = probe.probe_node()
        self.assertTrue(entry["ok"])
        self.assertEqual(entry["path"], "/opt/multicc/node/bin/node")
        self.assertEqual(entry["version"], "22.13.1")

        def versions(argv, timeout=8):
            return "v18.0.0" if argv[0] == env["MULTICC_NODE"] else "v26.8.1"

        with patch.dict(os.environ, env), \
             patch.object(probe, "run_quiet", side_effect=versions), \
             patch.object(probe.shutil, "which", return_value="/usr/local/bin/node"):
            fallback = probe.probe_node()
        self.assertTrue(fallback["ok"], "an old MULTICC_NODE must not hide a newer node on PATH")
        self.assertEqual(fallback["path"], "/usr/local/bin/node")

        with patch.dict(os.environ, {"MULTICC_NODE": ""}), \
             patch.object(probe, "run_quiet", return_value=None), \
             patch.object(probe.shutil, "which", return_value=None):
            missing = probe.probe_node()
        self.assertFalse(missing["ok"])
        self.assertIsNone(missing["path"])

    def test_exit_code_is_2_only_without_a_choice(self):
        def report(routes):
            return {"os": {"version": "11.7.10", "machine": "x86_64", "tier": "legacy"},
                    "browsers": [], "tools": {}, "agent": {}, "suggestedPort": None,
                    "reservedPorts": [], "routes": routes, "choice": choice_of(routes), "notes": []}

        ready = report(probe.plan_routes("legacy", [BROWSER], TOOLS_ALL, AGENT_READY, 9331))
        stuck = report(probe.plan_routes("legacy", [], TOOLS_ALL, AGENT_READY, 9331))
        for payload, expected in ((ready, 0), (stuck, 2)):
            with patch.object(probe, "probe", return_value=payload), \
                 patch.object(probe.platform, "system", return_value="Darwin"), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(probe.main([]), expected)

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
