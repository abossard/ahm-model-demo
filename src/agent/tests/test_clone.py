import http.server
import io
import os
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

import clone
from clone import MEBIBYTE, REFUSED, ArchiveRedirects, CloneError, archive_opener, archive_url, clone_tool, download, repository_target, unpack
from grounding import CLONE_MARKER
from tools import RunRecord

TOP = "example-albums-1a2b3c"
REPOSITORY = [
    (TOP, "dir", ""),
    (f"{TOP}/src", "dir", ""),
    (f"{TOP}/src/server.js", "file", "// the products API\n"),
    (f"{TOP}/README.md", "file", "Albums\n"),
]
KINDS = {
    "file": tarfile.REGTYPE,
    "dir": tarfile.DIRTYPE,
    "symlink": tarfile.SYMTYPE,
    "hardlink": tarfile.LNKTYPE,
    "device": tarfile.CHRTYPE,
    "pipe": tarfile.FIFOTYPE,
}


def tarball(members, mode=0o644):
    """A gzipped tarball of (name, kind, content) members; the content of a link is where it points."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, kind, content in members:
            info = tarfile.TarInfo(name)
            info.type = KINDS[kind]
            info.mode = 0o755 if kind == "dir" else mode
            if kind == "file":
                data = content.encode("utf-8") if isinstance(content, str) else content
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            else:
                info.linkname = content if kind in ("symlink", "hardlink") else ""
                tar.addfile(info)
    return buffer.getvalue()


def trickle():
    """A body that never ends and gives a little every 50 ms."""
    while True:
        time.sleep(0.05)
        yield b"x" * 1024


class LocalArchive(unittest.TestCase):
    """The archive host, played by a server on this machine: `serve` maps a path to (status, headers, body), a body being bytes
    or an iterable of chunks. `requests` collects the path and headers of each request."""

    def setUp(self):
        self.requests = []
        patch = mock.patch.dict(os.environ, {"NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1", "IDENTITY_HEADER": "secret", "OPENAI_API_KEY": "sk-1"})
        patch.start()
        self.addCleanup(patch.stop)

    def serve(self, routes):
        requests = self.requests

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.path, {name.lower(): value for name, value in self.headers.items()}))
                status, headers, body = routes.get(self.path, (404, {}, b"not found"))
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                for chunk in [body] if isinstance(body, bytes) else body:
                    self.wfile.write(chunk)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.handle_error = lambda *args: None
        threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.origin = f"http://127.0.0.1:{server.server_address[1]}"
        patch = mock.patch.object(clone, "ARCHIVE_ORIGIN", self.origin)
        patch.start()
        self.addCleanup(patch.stop)


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
                self.assertEqual(archive_url(url), expected and f"https://codeload.github.com/example/{expected}/tar.gz/HEAD")

    def test_a_redirect_may_only_lead_to_the_archive_host_over_the_same_scheme(self):
        request = urllib.request.Request("https://codeload.github.com/example/albums/tar.gz/HEAD")
        cases = [
            ("the same host", "https://codeload.github.com/example/renamed/tar.gz/HEAD", True),
            ("the host in another case", "https://CODELOAD.github.com/example/renamed/tar.gz/HEAD", True),
            ("a path of the same host", "/example/renamed/tar.gz/HEAD", True),
            ("another host", "https://github.com/example/albums", False),
            ("a host that only starts like it", "https://codeload.github.com.evil.example/x", False),
            ("a host before an at sign", "https://codeload.github.com@evil.example/x", False),
            ("a port", "https://codeload.github.com:8443/x", False),
            ("plain http", "http://codeload.github.com/example/albums", False),
            ("a local file", "file:///etc/passwd", False),
        ]
        for label, location, allowed in cases:
            with self.subTest(label):
                newurl = urllib.parse.urljoin(request.full_url, location)
                if allowed:
                    self.assertEqual(ArchiveRedirects().redirect_request(request, None, 302, "Found", {}, newurl).full_url, newurl)
                else:
                    with self.assertRaisesRegex(CloneError, "redirected away from codeload.github.com"):
                        ArchiveRedirects().redirect_request(request, None, 302, "Found", {}, newurl)

    def test_the_request_follows_the_proxy_of_the_environment_and_adds_no_credentials_or_cookies(self):
        with mock.patch.dict(os.environ, {"HTTPS_PROXY": "http://proxy.invalid:3128", "NO_PROXY": "localhost"}):
            handlers = archive_opener().handlers

        proxy = next(handler for handler in handlers if isinstance(handler, urllib.request.ProxyHandler))
        self.assertEqual(proxy.proxies["https"], "http://proxy.invalid:3128")
        names = {type(handler).__name__ for handler in handlers}
        self.assertFalse(names & {"HTTPCookieProcessor", "HTTPBasicAuthHandler", "HTTPDigestAuthHandler", "ProxyBasicAuthHandler", "ProxyDigestAuthHandler"})
        self.assertIn("ArchiveRedirects", names)


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.target = self.root / "tasks" / "t-1" / "albums"
        self.target.mkdir(parents=True)

    def unpack(self, content):
        archive = self.root / "archive.tar.gz"
        archive.write_bytes(content)
        return unpack(archive, self.target, time.monotonic() + 30)

    def test_the_top_folder_is_stripped_and_plain_files_and_folders_are_unpacked_without_extra_rights(self):
        members = [*REPOSITORY, (f"{TOP}/run.sh", "file", "#!/bin/sh\n")]

        rules = self.unpack(tarball(members, mode=0o4755))

        self.assertEqual(sorted(path.relative_to(self.target).as_posix() for path in self.target.rglob("*")), ["README.md", "run.sh", "src", "src/server.js"])
        self.assertEqual((self.target / "src" / "server.js").read_text(encoding="utf-8"), "// the products API\n")
        self.assertEqual((rules.files, rules.links), (3, 0))
        self.assertEqual((self.target / "run.sh").stat().st_mode & 0o7777, 0o755)

    def test_links_are_left_out_and_counted(self):
        members = [*REPOSITORY, (f"{TOP}/docs", "symlink", "/etc"), (f"{TOP}/copy.md", "hardlink", f"{TOP}/README.md")]

        rules = self.unpack(tarball(members))

        self.assertEqual(sorted(path.name for path in self.target.iterdir()), ["README.md", "src"])
        self.assertEqual((rules.files, rules.links), (2, 2))

    def test_an_archive_that_is_no_repository_or_could_do_harm_is_refused_and_writes_nothing_outside(self):
        many = [(TOP, "dir", ""), *[(f"{TOP}/f{number}", "file", "x") for number in range(4)]]
        cases = [
            ("an absolute path", [("/etc/evil", "file", "x")], {}, "path that leaves its folder"),
            ("a path that climbs", [(TOP, "dir", ""), (f"{TOP}/../../evil", "file", "x")], {}, "path that leaves its folder"),
            ("a path that climbs from the start", [("../evil", "file", "x")], {}, "path that leaves its folder"),
            ("two top folders", [(TOP, "dir", ""), ("other", "dir", ""), (f"{TOP}/a", "file", "x")], {}, "does not hold a single folder"),
            ("a file beside the folder", [(TOP, "dir", ""), ("evil", "file", "x")], {}, "does not hold a single folder"),
            ("a file in place of the folder", [(TOP, "file", "x")], {}, "does not hold a single folder"),
            ("a device", [(TOP, "dir", ""), (f"{TOP}/null", "device", "")], {}, "neither a plain file nor a folder"),
            ("a pipe", [(TOP, "dir", ""), (f"{TOP}/pipe", "pipe", "")], {}, "neither a plain file nor a folder"),
            ("too many entries", many, {"FILE_LIMIT": 4}, "more than 4 files"),
            ("too many bytes", [(TOP, "dir", ""), (f"{TOP}/big", "file", bytes(2 * MEBIBYTE))], {"UNPACKED_LIMIT": MEBIBYTE}, "more than 1 MiB of files"),
            ("nothing", [], {}, "the archive is empty"),
        ]
        for label, members, limits, expected in cases:
            with self.subTest(label), mock.patch.dict(clone.__dict__, limits):
                with self.assertRaisesRegex(CloneError, expected):
                    self.unpack(tarball(members))

                self.assertEqual(sorted(path.name for path in self.root.rglob("evil")), [])

    def test_bytes_that_are_no_gzipped_tarball_are_refused(self):
        whole = tarball(REPOSITORY)
        for label, content in [("text", b"not an archive"), ("a cut archive", whole[: len(whole) // 2]), ("nothing", b"")]:
            with self.subTest(label):
                with self.assertRaisesRegex(CloneError, "the archive could not be unpacked"):
                    self.unpack(content)

    def test_unpacking_stops_at_the_deadline(self):
        archive = self.root / "archive.tar.gz"
        archive.write_bytes(tarball(REPOSITORY))

        with self.assertRaisesRegex(CloneError, "timed out after"):
            unpack(archive, self.target, time.monotonic() - 1)


class DownloadTests(LocalArchive):
    def setUp(self):
        super().setUp()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.destination = Path(self.directory.name, "archive.tar.gz")

    def download(self, routes, path="/example/albums/tar.gz/HEAD"):
        self.serve(routes)
        download(archive_opener(), f"{self.origin}{path}", self.destination, time.monotonic() + 30)

    def test_the_archive_is_streamed_to_a_file_with_no_credentials_or_cookies(self):
        body = tarball(REPOSITORY)

        self.download({"/example/albums/tar.gz/HEAD": (200, {}, body)})

        self.assertEqual(self.destination.read_bytes(), body)
        self.assertEqual([path for path, _ in self.requests], ["/example/albums/tar.gz/HEAD"])
        self.assertLessEqual(set(self.requests[0][1]), {"host", "user-agent", "accept-encoding", "connection"})

    def test_a_redirect_to_the_same_host_is_followed_and_one_to_another_is_not(self):
        body = tarball(REPOSITORY)
        cases = [
            ("the same host", {"Location": "/moved/tar.gz/HEAD"}, None),
            ("another host", {"Location": "http://localhost:9/x"}, "redirected away from"),
        ]
        for label, headers, refused in cases:
            with self.subTest(label):
                self.requests.clear()
                routes = {"/example/albums/tar.gz/HEAD": (302, headers, b""), "/moved/tar.gz/HEAD": (200, {}, body)}

                if refused:
                    with self.assertRaisesRegex(CloneError, refused):
                        self.download(routes)
                    self.assertEqual(len(self.requests), 1)
                else:
                    self.download(routes)
                    self.assertEqual(self.destination.read_bytes(), body)

    def test_a_download_that_cannot_be_had_says_why(self):
        cases = [
            ("not found", 404, "the repository was not found or is not public"),
            ("needs a login", 401, "the repository was not found or is not public"),
            ("forbidden", 403, "the repository was not found or is not public"),
            ("a server error", 500, "GitHub answered 500"),
        ]
        for label, status, expected in cases:
            with self.subTest(label):
                with self.assertRaisesRegex(CloneError, expected):
                    self.download({"/example/albums/tar.gz/HEAD": (status, {}, b"no")})

    def test_a_download_above_the_limit_is_stopped(self):
        with mock.patch.object(clone, "DOWNLOAD_LIMIT", MEBIBYTE), self.assertRaisesRegex(CloneError, "larger than 1 MiB"):
            self.download({"/example/albums/tar.gz/HEAD": (200, {}, bytes(2 * MEBIBYTE))})

    def test_a_download_that_never_ends_is_stopped_at_the_deadline(self):
        self.serve({"/example/albums/tar.gz/HEAD": (200, {}, trickle())})
        started = time.monotonic()

        with self.assertRaisesRegex(CloneError, "timed out after"):
            download(archive_opener(), f"{self.origin}/example/albums/tar.gz/HEAD", self.destination, time.monotonic() + 0.3)

        self.assertLess(time.monotonic() - started, 2)

    def test_a_host_that_cannot_be_reached_says_so(self):
        with self.assertRaisesRegex(CloneError, "the download failed"):
            download(archive_opener(), "http://127.0.0.1:9/x", self.destination, time.monotonic() + 30)


class CloneToolTests(LocalArchive, unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        super().setUp()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name, "tasks", "t-1")
        self.record = RunRecord()

    async def clone(self, url, routes=None):
        self.serve({"/example/albums/tar.gz/HEAD": (200, {}, tarball(REPOSITORY))} if routes is None else routes)
        return await clone_tool(self.folder, self.record).invoke(arguments={"url": url}, skip_parsing=True)

    async def test_a_clone_lands_in_the_task_folder_under_its_name_with_a_marker_and_is_counted(self):
        answer = await self.clone("https://github.com/example/albums")

        self.assertEqual(answer, "Cloned https://github.com/example/albums into albums (2 files). Read it with run_shell.")
        self.assertEqual((self.folder / "albums" / "src" / "server.js").read_text(encoding="utf-8"), "// the products API\n")
        self.assertEqual((self.folder / "albums" / CLONE_MARKER).read_text(encoding="utf-8"), f"{self.origin}/example/albums/tar.gz/HEAD")
        self.assertEqual([path for path, _ in self.requests], ["/example/albums/tar.gz/HEAD"])
        self.assertTrue(self.record.clone_attempted)

    async def test_links_that_were_not_copied_are_said(self):
        members = [*REPOSITORY, (f"{TOP}/docs", "symlink", "/etc")]

        answer = await self.clone("https://github.com/example/albums", {"/example/albums/tar.gz/HEAD": (200, {}, tarball(members))})

        self.assertEqual(answer, "Cloned https://github.com/example/albums into albums (2 files; 1 links not copied). Read it with run_shell.")
        self.assertFalse((self.folder / "albums" / "docs").exists())

    async def test_an_address_that_is_no_public_github_repository_is_refused_without_a_request(self):
        for url in ("https://gitlab.com/example/albums", "file:///tmp/x", "git@github.com:example/albums.git"):
            with self.subTest(url):
                self.record.clone_attempted = False

                answer = await self.clone(url)

                self.assertEqual(answer, REFUSED)
                self.assertTrue(answer.startswith("Error: refused. "))
                self.assertEqual(self.requests, [])
                self.assertTrue(self.record.clone_attempted)

    async def test_a_repository_that_is_already_there_is_not_fetched_again(self):
        await self.clone("https://github.com/example/albums")
        self.requests.clear()

        answer = await self.clone("https://github.com/example/albums")

        self.assertEqual(answer, "albums is already in the Task folder.")
        self.assertEqual(self.requests, [])

    async def test_a_clone_that_fails_leaves_nothing_behind_and_says_why(self):
        unsafe = tarball([(TOP, "dir", ""), (f"{TOP}/../../evil", "file", "x")])
        cases = [
            ("a repository that is not public", {}, {}, "The clone failed: the repository was not found or is not public."),
            ("an archive that is no archive", {"/example/albums/tar.gz/HEAD": (200, {}, b"<html>")}, {}, "The clone failed: the archive could not be unpacked"),
            ("an archive that leaves its folder", {"/example/albums/tar.gz/HEAD": (200, {}, unsafe)}, {}, "The clone failed: the archive has a path that leaves its folder."),
            ("a download that takes too long", {"/example/albums/tar.gz/HEAD": (200, {}, trickle())}, {"CLONE_TIMEOUT_SECONDS": 0.3}, "The clone failed: timed out after 0.3s."),
        ]
        for label, routes, limits, expected in cases:
            with self.subTest(label), mock.patch.dict(clone.__dict__, limits):
                answer = await self.clone("https://github.com/example/albums", routes)

                self.assertTrue(answer.startswith(expected), answer)
                self.assertFalse((self.folder / "albums").exists())
                self.assertFalse((self.folder / "evil").exists())


if __name__ == "__main__":
    unittest.main()
