import logging
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

logging.getLogger("asyncio").setLevel(logging.ERROR)

import main


class ProtectProcessTests(unittest.TestCase):
    def protect(self, platform, answer):
        libc = mock.Mock()
        libc.prctl.return_value = answer
        with mock.patch.object(main.sys, "platform", platform), mock.patch.object(main.ctypes, "CDLL", return_value=libc) as loaded:
            return main.protect_process(), libc, loaded

    def test_the_agent_is_made_not_dumpable_on_linux(self):
        done, libc, _ = self.protect("linux", 0)

        self.assertTrue(done)
        libc.prctl.assert_called_once_with(main.PR_SET_DUMPABLE, 0, 0, 0, 0)
        self.assertEqual(main.PR_SET_DUMPABLE, 4)

    def test_a_refusal_of_the_system_is_reported_and_not_hidden(self):
        with self.assertLogs("health-model-agent", level="WARNING") as logged:
            done, _, _ = self.protect("linux", -1)

        self.assertFalse(done)
        self.assertIn("commands of the model can read its /proc files", logged.output[0])

    def test_other_systems_have_nothing_to_set(self):
        for platform in ("darwin", "win32"):
            with self.subTest(platform):
                done, libc, loaded = self.protect(platform, 0)

                self.assertFalse(done)
                loaded.assert_not_called()
                libc.prctl.assert_not_called()


class RequiredTests(unittest.TestCase):
    def test_a_setting_that_is_missing_or_blank_stops_the_start(self):
        for label, environ in [("missing", {}), ("blank", {"MCP_URL": "  "})]:
            with self.subTest(label), mock.patch.dict(os.environ, environ, clear=True):
                with self.assertRaises(RuntimeError) as failure:
                    main.required("MCP_URL")

                self.assertEqual(str(failure.exception), "environment variable MCP_URL is not set")

    def test_a_setting_is_trimmed(self):
        with mock.patch.dict(os.environ, {"MCP_URL": " https://mcp.example.net/ "}, clear=True):
            self.assertEqual(main.required("MCP_URL"), "https://mcp.example.net/")


if __name__ == "__main__":
    unittest.main()
