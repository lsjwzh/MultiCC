"""Standard-library checks for the macOS Browser Use launcher."""

import argparse
import contextlib
import importlib.util
import io
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / "skills/multicc-browser/scripts/local_browser_use.py"
SPEC = importlib.util.spec_from_file_location("local_browser_use", SCRIPT)
browser_use = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(browser_use)


class FakeProcess:
    """Stand-in for a launched browser: alive until stopped."""

    def __init__(self, returncode=0):
        self.returncode = returncode
        self.terminated = False

    def poll(self):
        return self.returncode if self.terminated else None

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.terminated = True

    def wait(self, timeout=None):
        self.terminated = True
        return self.returncode


class LocalBrowserUseTests(unittest.TestCase):
    def profile(self, root, name):
        return root / "home/Library/Application Support/MultiCC/browser-use" / name

    def launch_start(self, root, name, arguments=()):
        """Run `start` end to end against a stubbed browser; returns exit code, argv, CDP mock, stdout."""
        browser = root / "Chromium"
        browser.write_text("#!/bin/sh\n")
        browser.chmod(0o755)
        launched = []
        stdout = io.StringIO()
        with patch.object(Path, "home", return_value=root / "home"), \
                patch.object(browser_use.platform, "system", return_value="Darwin"), \
                patch.object(browser_use, "require_free_loopback_port"), \
                patch.object(browser_use, "security_agent_running", return_value=False), \
                patch.object(browser_use, "wait_for_cdp",
                             return_value=("http://127.0.0.1:9331", "Chrome/138.0.7204.183")) as ready, \
                patch.object(browser_use.subprocess, "Popen",
                             side_effect=lambda argv, **kwargs: launched.append(argv) or FakeProcess()), \
                contextlib.redirect_stdout(stdout):
            code = browser_use.main(["start", "--browser", str(browser), "--name", name, *arguments])
        return code, launched, ready, stdout.getvalue()

    def test_dedicated_profile_and_loopback_debugging(self):
        with patch.object(Path, "home", return_value=Path("/fake/home")):
            profile = browser_use.profile_path("account-one")
        self.assertEqual(profile, Path("/fake/home/Library/Application Support/MultiCC/browser-use/account-one"))
        args = browser_use.chrome_args(Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
                                       profile, 9331, True)
        self.assertIn(f"--user-data-dir={profile}", args)
        self.assertIn("--remote-debugging-address=127.0.0.1", args)
        self.assertIn("--remote-debugging-port=9331", args)
        self.assertIn("--profile-directory=Default", args)
        self.assertIn("--headless", args)
        self.assertNotIn("--use-mock-keychain", args, "the mock keychain must stay opt-in")
        self.assertIn("--use-mock-keychain", browser_use.chrome_args(
            Path("/Applications/Chromium.app/Contents/MacOS/Chromium"), profile, 9331, False, True))

    def test_invalid_name_or_port_fails_closed(self):
        for name in ("../private", "two words", "", "a/../../b"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                browser_use.profile_path(name)
        for port in (0, 80, 65536):
            with self.subTest(port=port), self.assertRaises(ValueError):
                browser_use.chrome_args("chrome", "/tmp/profile", port, False)

    def test_smoke_proves_real_browser_action_and_screenshot(self):
        with tempfile.TemporaryDirectory() as directory:
            screenshot = Path(directory) / "smoke.png"
            program = browser_use.smoke_program(screenshot)
            self.assertIn("new_tab(", program)
            self.assertIn("document.title", program)
            self.assertIn("capture_screenshot(", program)
            self.assertIn(str(screenshot), program)
            self.assertIn("MULTICC_BROWSER_USE_SMOKE_OK", program)

    def test_seed_copies_only_selected_profile_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            selected = source / "Profile 1"
            selected.mkdir(parents=True)
            (source / "Local State").write_text("local-state")
            (selected / "Preferences").write_text("preferences")
            (selected / "Cookies").write_text("cookie-data")
            (selected / "Cache").mkdir()
            (selected / "Cache" / "cached").write_text("skip")
            (source / "Default").mkdir()
            (source / "Default" / "Preferences").write_text("other")
            target = root / "dedicated"

            self.assertEqual(browser_use.seed_profile(source, "Profile 1", target), target)
            self.assertEqual((target / "Local State").read_text(), "local-state")
            self.assertEqual((target / "Default" / "Cookies").read_text(), "cookie-data")
            self.assertFalse((target / "Default" / "Cache").exists())
            self.assertFalse((target / "Profile 1").exists())
            self.assertTrue((target / browser_use.SEEDED_MARKER).is_file())
            self.assertEqual((selected / "Cookies").read_text(), "cookie-data")
            with self.assertRaisesRegex(RuntimeError, "refusing to overwrite"):
                browser_use.seed_profile(source, "Profile 1", target)

    def test_seed_rejects_live_source_and_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            profile = source / "Default"
            profile.mkdir(parents=True)
            (source / "Local State").write_text("state")
            (profile / "Preferences").write_text("prefs")
            with self.assertRaises(ValueError):
                browser_use.seed_profile(source, "../Default", root / "out")
            (source / "SingletonLock").symlink_to("machine-12345")
            with patch.object(browser_use.os, "kill") as kill:
                with self.assertRaisesRegex(RuntimeError, "running"):
                    browser_use.seed_profile(source, "Default", root / "out")
            kill.assert_called_once_with(12345, 0)
            self.assertFalse((root / "out").exists())

    def test_cdp_timeout_rejects_values_that_would_never_expire(self):
        for value in ("0", "-1", "abc", "", "nan", "inf"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                browser_use.positive_seconds(value)
        self.assertEqual(browser_use.positive_seconds("7.5"), 7.5)
        self.assertEqual(browser_use.DEFAULT_CDP_TIMEOUT, 45)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as rejected:
            browser_use.main(["smoke", "--cdp-timeout", "0"])
        self.assertEqual(rejected.exception.code, 2)

    def test_start_plumbs_cdp_timeout_and_pins_mock_keychain_on_a_fresh_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            code, launched, ready, _ = self.launch_start(root, "mk-fresh", ["--cdp-timeout", "7", "--mock-keychain"])
            self.assertEqual(code, 0)
            self.assertEqual(ready.call_args.args[0], 9331)
            self.assertEqual(ready.call_args.args[2], 7.0)
            self.assertIn("--use-mock-keychain", launched[0])
            self.assertTrue((self.profile(root, "mk-fresh") / browser_use.MOCK_KEYCHAIN_MARKER).is_file())

    def test_start_refuses_mock_keychain_on_an_existing_unmarked_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = self.profile(root, "mk-existing")
            profile.mkdir(parents=True)
            (profile / "Local State").write_text("state")
            stderr = io.StringIO()
            with self.assertRaises(SystemExit) as refused, contextlib.redirect_stderr(stderr):
                self.launch_start(root, "mk-existing", ["--mock-keychain"])
            self.assertEqual(refused.exception.code, 2)
            self.assertIn(browser_use.MOCK_KEYCHAIN_MARKER, stderr.getvalue())
            self.assertFalse((profile / browser_use.MOCK_KEYCHAIN_MARKER).exists(),
                             "a refused launch must not leave a marker behind")

    def test_a_marked_profile_applies_mock_keychain_without_the_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = self.profile(root, "mk-used")
            profile.mkdir(parents=True)
            (profile / "Local State").write_text("state")
            (profile / browser_use.MOCK_KEYCHAIN_MARKER).write_text("marker")
            code, launched, _, stdout = self.launch_start(root, "mk-used")
            self.assertEqual(code, 0)
            self.assertIn("--use-mock-keychain", launched[0])
            self.assertIn(browser_use.MOCK_KEYCHAIN_MARKER, stdout)

    def test_start_refuses_mock_keychain_on_a_seeded_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = self.profile(root, "mk-seeded")
            profile.mkdir(parents=True)
            (profile / "Local State").write_text("state")
            (profile / browser_use.SEEDED_MARKER).write_text("seeded")
            stderr = io.StringIO()
            with self.assertRaises(SystemExit) as refused, contextlib.redirect_stderr(stderr):
                self.launch_start(root, "mk-seeded", ["--mock-keychain"])
            self.assertEqual(refused.exception.code, 2)
            self.assertIn("was seeded from a personal Chrome profile", stderr.getvalue())
            code, launched, _, _ = self.launch_start(root, "mk-seeded")
            self.assertEqual(code, 0, "a seeded profile still starts on the real keychain")
            self.assertNotIn("--use-mock-keychain", launched[0])

    def test_seed_refuses_mock_keychain(self):
        stderr = io.StringIO()
        with patch.object(browser_use.platform, "system", return_value="Darwin"), \
                self.assertRaises(SystemExit) as refused, contextlib.redirect_stderr(stderr):
            browser_use.main(["seed", "--mock-keychain", "--confirm-source-closed"])
        self.assertEqual(refused.exception.code, 2)
        self.assertIn("--mock-keychain", stderr.getvalue())

    def test_security_agent_probe_is_read_only_and_tolerates_a_missing_pgrep(self):
        with patch.object(browser_use.subprocess, "run",
                          return_value=subprocess.CompletedProcess([], 1)) as run:
            self.assertFalse(browser_use.security_agent_running())
            self.assertEqual(run.call_args.args[0], ["pgrep", "-x", "SecurityAgent"])
        with patch.object(browser_use.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
            self.assertTrue(browser_use.security_agent_running())
        with patch.object(browser_use.subprocess, "run", side_effect=OSError("no pgrep")):
            self.assertFalse(browser_use.security_agent_running())

    def test_cdp_timeout_error_names_the_keychain_prompt_and_security_agent(self):
        with patch.object(browser_use, "security_agent_running", return_value=False):
            quiet = browser_use.cdp_timeout_hint()
            self.assertIn("Chrome Safe Storage", quiet)
            self.assertIn("--mock-keychain", quiet)
            self.assertIn("--cdp-timeout", quiet)
            self.assertNotIn("SecurityAgent is running", quiet)
            with self.assertRaisesRegex(RuntimeError, "CDP endpoint did not become ready.*--mock-keychain"):
                browser_use.wait_for_cdp(1, FakeProcess(), timeout=0.1)
        with patch.object(browser_use, "security_agent_running", return_value=True):
            self.assertIn("SecurityAgent is running", browser_use.cdp_timeout_hint())
            with self.assertRaisesRegex(RuntimeError, "SecurityAgent is running"):
                browser_use.wait_for_cdp(1, FakeProcess(), timeout=0.1)


if __name__ == "__main__":
    unittest.main()
