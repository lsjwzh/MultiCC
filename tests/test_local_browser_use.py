"""Standard-library checks for the macOS Browser Use launcher."""

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "skills/multicc-browser/scripts/local_browser_use.py"
SPEC = importlib.util.spec_from_file_location("local_browser_use", SCRIPT)
browser_use = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(browser_use)


class LocalBrowserUseTests(unittest.TestCase):
    def test_dedicated_profile_and_loopback_debugging(self):
        with patch.object(Path, "home", return_value=Path("/fake/home")):
            profile = browser_use.profile_path("account-one")
        self.assertEqual(profile, Path("/fake/home/Library/Application Support/MultiCC/browser-use/account-one"))
        args = browser_use.chrome_args(Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
                                       profile, 9331, True)
        self.assertIn(f"--user-data-dir={profile}", args)
        self.assertIn("--remote-debugging-address=127.0.0.1", args)
        self.assertIn("--remote-debugging-port=9331", args)
        self.assertIn("--headless", args)

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


if __name__ == "__main__":
    unittest.main()
