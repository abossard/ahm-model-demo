import asyncio
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

import clone
from clone import IMAGE_GIT, PASSED_ENV_KEYS, REFUSED, clone_command, clone_env, clone_tool, git_binary, repository_target
from tools import RunRecord


def fake_git(directory, fixture, body=""):
    """A `git` that copies `fixture` into the folder it is told to clone into, and records its arguments and environment."""
    path = Path(directory, "fake-git")
    path.write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$@" > "$HOME/args-seen"\n'
        'env > "$HOME/env-seen"\n'
        'for last; do :; done\n'
        f"{body}\n"
        'mkdir -p "$last"\n'
        f'cp -R "{fixture}/." "$last"\n',
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return str(path)


class AddressTests(unittest.TestCase):
    def test_only_public_github_repositories_are_cloned(self):
        cases = [
            ("a repository", "https://github.com/example/albums", "albums"),
            ("with .git", "https://github.com/example/albums.git", "albums"),
            ("with a trailing slash", "https://github.com/example/albums/", "albums"),
            ("with spaces around", "  https://github.com/example/albums  ", "albums"),
            ("a dotted name", "https://github.com/example/web.app-2", "web.app-2"),
            ("plain http", "http://github.com/example/albums", None),
            ("ssh", "git@github.com:example/albums.git", None),
            ("another host", "https://gitlab.com/example/albums", None),
            ("a host that only starts like it", "https://github.com.evil.example/example/albums", None),
            ("credentials", "https://user:secret@github.com/example/albums", None),
            ("a path below the repository", "https://github.com/example/albums/tree/main", None),
            ("a local path", "file:///tmp/albums", None),
            ("no repository", "https://github.com/example", None),
            ("a path that climbs", "https://github.com/example/..", None),
            ("an option", "--upload-pack=x", None),
        ]
        for label, url, expected in cases:
            with self.subTest(label):
                self.assertEqual(repository_target(url), expected)

    def test_the_command_allows_one_protocol_and_clones_one_commit_of_one_branch(self):
        with mock.patch.dict(os.environ, {"CLONE_GIT": "/opt/git/git"}):
            command = clone_command("https://github.com/example/albums", "albums")

        self.assertEqual(
            command,
            [
                "/opt/git/git", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
                "clone", "--depth", "1", "--single-branch", "--no-tags", "--", "https://github.com/example/albums", "albums",
            ],
        )

    def test_git_is_the_one_the_image_keeps_off_the_path_unless_told_otherwise(self):
        with mock.patch.dict(os.environ, {"CLONE_GIT": "/x/git"}):
            self.assertEqual(git_binary(), "/x/git")
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(clone.Path, "exists", return_value=True):
            self.assertEqual(git_binary(), IMAGE_GIT)
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(clone.Path, "exists", return_value=False), mock.patch.object(clone.shutil, "which", return_value="/usr/bin/git"):
            self.assertEqual(git_binary(), "/usr/bin/git")

    def test_git_sees_no_identity_and_no_configuration_of_its_own(self):
        parent = {key: "x" for key in PASSED_ENV_KEYS} | {"IDENTITY_HEADER": "secret", "OPENAI_API_KEY": "sk-1", "MCP_URL": "https://mcp", "HOME": "/home/session", "GIT_ASKPASS": "evil"}

        env = clone_env(parent, Path("/work/tasks/t-1"))

        self.assertEqual(set(env), set(PASSED_ENV_KEYS) | {"HOME", "GIT_TERMINAL_PROMPT", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_ASKPASS"})
        self.assertEqual((env["HOME"], env["GIT_TERMINAL_PROMPT"], env["GIT_CONFIG_NOSYSTEM"], env["GIT_CONFIG_GLOBAL"], env["GIT_ASKPASS"]), ("/work/tasks/t-1", "0", "1", os.devnull, "true"))


class CloneToolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.fixture = self.root / "fixture"
        (self.fixture / "src").mkdir(parents=True)
        (self.fixture / "src" / "server.js").write_text("// the products API\n", encoding="utf-8")
        (self.fixture / ".git").mkdir()
        (self.fixture / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
        self.folder = self.root / "tasks" / "t-1"
        self.record = RunRecord()

    async def clone(self, url, git=None, **environ):
        script = git or fake_git(self.root, self.fixture)
        with mock.patch.dict(os.environ, {"CLONE_GIT": script, "IDENTITY_HEADER": "secret", "OPENAI_API_KEY": "sk-1", **environ}):
            return await clone_tool(self.folder, self.record).invoke(arguments={"url": url}, skip_parsing=True)

    async def test_a_clone_lands_in_the_task_folder_under_its_name_and_is_counted_without_git_files(self):
        answer = await self.clone("https://github.com/example/albums")

        self.assertEqual(answer, "Cloned https://github.com/example/albums into albums (1 files). Read it with run_shell.")
        self.assertEqual((self.folder / "albums" / "src" / "server.js").read_text(encoding="utf-8"), "// the products API\n")
        self.assertTrue(self.record.clone_attempted)

    async def test_git_gets_the_command_and_an_environment_without_the_agents_secrets(self):
        await self.clone("https://github.com/example/albums")

        arguments = (self.folder / "args-seen").read_text(encoding="utf-8").split("\n")[:-1]
        seen = dict(line.split("=", 1) for line in (self.folder / "env-seen").read_text(encoding="utf-8").splitlines() if "=" in line)
        self.assertEqual(arguments[:6], ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "clone", "--depth"])
        self.assertEqual(arguments[-3:], ["--", "https://github.com/example/albums", "albums"])
        self.assertEqual((seen["HOME"], seen["GIT_TERMINAL_PROMPT"]), (str(self.folder), "0"))
        self.assertNotIn("IDENTITY_HEADER", seen)
        self.assertNotIn("OPENAI_API_KEY", seen)

    async def test_an_address_that_is_no_public_github_repository_is_refused_without_running_git(self):
        for url in ("https://gitlab.com/example/albums", "file:///tmp/x", "git@github.com:example/albums.git"):
            with self.subTest(url):
                self.record.clone_attempted = False

                answer = await self.clone(url)

                self.assertEqual(answer, REFUSED)
                self.assertTrue(answer.startswith("Error: refused. "))
                self.assertFalse((self.folder / "args-seen").exists())
                self.assertTrue(self.record.clone_attempted)

    async def test_a_repository_that_is_already_there_is_not_cloned_again(self):
        await self.clone("https://github.com/example/albums")
        (self.folder / "args-seen").unlink()

        answer = await self.clone("https://github.com/example/albums")

        self.assertEqual(answer, "albums is already in the Task folder.")
        self.assertFalse((self.folder / "args-seen").exists())

    async def test_a_failed_clone_leaves_nothing_behind_and_says_why(self):
        git = fake_git(self.root, self.fixture, body='echo "fatal: repository not found"; mkdir -p "$last/partial"; exit 128')

        answer = await self.clone("https://github.com/example/private", git=git)

        self.assertEqual(answer, "The clone failed (exit code 128): fatal: repository not found")
        self.assertFalse((self.folder / "private").exists())

    async def test_a_clone_that_takes_too_long_is_killed(self):
        git = fake_git(self.root, self.fixture, body="exec sleep 30")

        with mock.patch.object(clone, "CLONE_TIMEOUT_SECONDS", 0.3):
            answer = await asyncio.wait_for(self.clone("https://github.com/example/slow", git=git), 10)

        self.assertEqual(answer, "The clone failed (exit code 124): timed out after 0.3s")
        self.assertFalse((self.folder / "slow").exists())


if __name__ == "__main__":
    unittest.main()
