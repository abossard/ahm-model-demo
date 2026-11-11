"""The one way a repository reaches the Task folder: a tool that agent code runs, not a command the model writes.

Only public repositories at https://github.com/<owner>/<repository> are fetched, as the tarball of their default branch from
codeload.github.com, which serves downloads only. The image has no git and its egress allow-list has no other GitHub host, so
nothing a command of the model runs can push or post to GitHub. The image runs Python 3.14: `tarfile`'s `data` filter unpacks
the archive, with the checks of `ArchiveRules` on top."""

from __future__ import annotations

import asyncio
import http.client
import re
import shutil
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path, PurePosixPath
from typing import Annotated, Any

from agent_framework import FunctionTool, tool
from pydantic import Field

from grounding import CLONE_MARKER

CLONE_TOOL = "clone_repository"
GITHUB_REPOSITORY = re.compile(r"https://github\.com/(?P<owner>[A-Za-z0-9][A-Za-z0-9-]{0,38})/(?P<name>[A-Za-z0-9_][A-Za-z0-9._-]{0,99}?)(?:\.git)?/?")
ARCHIVE_ORIGIN = "https://codeload.github.com"
CLONE_TIMEOUT_SECONDS = 120
SOCKET_TIMEOUT_SECONDS = 10
MEBIBYTE = 1024 * 1024
DOWNLOAD_LIMIT = 50 * MEBIBYTE
UNPACKED_LIMIT = 200 * MEBIBYTE
FILE_LIMIT = 20_000
CHUNK_BYTES = 64 * 1024
REFUSED = "Error: refused. Only public repositories at https://github.com/<owner>/<repository> are cloned."


class CloneError(Exception):
    """Why a repository was not fetched, in the words the model is told."""


def repository_target(url: str) -> str | None:
    """The folder a repository is cloned into (its name), or None for an address that is not https://github.com/<owner>/<repository>."""
    found = GITHUB_REPOSITORY.fullmatch(url.strip())
    return found["name"] if found else None


def archive_url(url: str) -> str | None:
    """Where the tarball of the repository's default branch is served, or None for an address that is not a repository."""
    found = GITHUB_REPOSITORY.fullmatch(url.strip())
    return f"{ARCHIVE_ORIGIN}/{found['owner']}/{found['name']}/tar.gz/HEAD" if found else None


def check_time(deadline: float) -> None:
    if time.monotonic() > deadline:
        raise CloneError(f"timed out after {CLONE_TIMEOUT_SECONDS}s")


class ArchiveRedirects(urllib.request.HTTPRedirectHandler):
    """A redirect may only lead to the archive host over the same scheme: the download is never sent anywhere else."""

    def redirect_request(self, req: Any, fp: Any, code: Any, msg: Any, headers: Any, newurl: str) -> Any:
        wanted, target = urllib.parse.urlsplit(ARCHIVE_ORIGIN), urllib.parse.urlsplit(newurl)
        if (target.scheme, target.netloc.lower()) != (wanted.scheme, wanted.netloc):
            raise CloneError(f"the download was redirected away from {wanted.netloc}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def archive_opener() -> urllib.request.OpenerDirector:
    """Plain requests through the proxy and the certificates of the environment: the default handlers read HTTPS_PROXY, NO_PROXY
    and SSL_CERT_FILE. No credentials, cookies or netrc are added."""
    return urllib.request.build_opener(ArchiveRedirects())


def download(opener: urllib.request.OpenerDirector, url: str, destination: Path, deadline: float) -> None:
    """Stream `url` into `destination`, at most DOWNLOAD_LIMIT bytes and until `deadline`. A stalled read ends after
    SOCKET_TIMEOUT_SECONDS, so the deadline holds to within that."""
    try:
        with opener.open(url, timeout=SOCKET_TIMEOUT_SECONDS) as response, destination.open("wb") as archive:
            received = 0
            while chunk := response.read1(CHUNK_BYTES):
                check_time(deadline)
                received += len(chunk)
                if received > DOWNLOAD_LIMIT:
                    raise CloneError(f"the repository is larger than {DOWNLOAD_LIMIT // MEBIBYTE} MiB")
                archive.write(chunk)
    except urllib.error.HTTPError as error:
        error.close()
        if error.code in (401, 403, 404):
            raise CloneError("the repository was not found or is not public") from None
        raise CloneError(f"GitHub answered {error.code}") from None
    except (OSError, http.client.HTTPException) as error:
        raise CloneError(f"the download failed ({getattr(error, 'reason', error)})") from None


class ArchiveRules:
    """The `filter` of `extractall` for one archive. It strips the single top-level folder, and allows only paths inside it, plain
    files and folders, at most FILE_LIMIT entries and UNPACKED_LIMIT bytes. Links are left out and counted; anything else that is
    not a plain file or folder refuses the archive. What it lets through passes tarfile's `data` filter too."""

    def __init__(self, deadline: float) -> None:
        self.deadline = deadline
        self.top: str | None = None
        self.entries = self.files = self.links = self.size = 0

    def __call__(self, member: tarfile.TarInfo, path: str) -> tarfile.TarInfo | None:
        check_time(self.deadline)
        self.entries += 1
        if self.entries > FILE_LIMIT:
            raise CloneError(f"the repository has more than {FILE_LIMIT} files")
        parts = PurePosixPath(member.name).parts
        if not parts or member.name.startswith("/") or ".." in parts:
            raise CloneError("the archive has a path that leaves its folder")
        self.top = self.top or parts[0]
        if parts[0] != self.top or (len(parts) == 1 and not member.isdir()):
            raise CloneError("the archive does not hold a single folder")
        if member.issym() or member.islnk():
            self.links += 1
            return None
        if not (member.isreg() or member.isdir()):
            raise CloneError("the archive holds something that is neither a plain file nor a folder")
        if len(parts) == 1:
            return None
        if member.isreg():
            self.files += 1
            self.size += member.size
            if self.size > UNPACKED_LIMIT:
                raise CloneError(f"the repository holds more than {UNPACKED_LIMIT // MEBIBYTE} MiB of files")
        return tarfile.data_filter(member.replace(name="/".join(parts[1:])), path)


def unpack(archive: Path, target: Path, deadline: float) -> ArchiveRules:
    rules = ArchiveRules(deadline)
    try:
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(target, filter=rules)
    except (tarfile.TarError, OSError, EOFError, zlib.error) as error:
        raise CloneError(f"the archive could not be unpacked ({error})") from None
    if rules.top is None:
        raise CloneError("the archive is empty")
    return rules


def fetch_repository(source: str, target: Path) -> ArchiveRules:
    """Download the archive at `source` (an address `archive_url` returned) into `target`, within CLONE_TIMEOUT_SECONDS. Nothing
    is left in `target` when it fails."""
    deadline = time.monotonic() + CLONE_TIMEOUT_SECONDS
    target.mkdir(parents=True)
    try:
        with tempfile.TemporaryDirectory() as scratch:
            archive = Path(scratch, "archive.tar.gz")
            download(archive_opener(), source, archive, deadline)
            rules = unpack(archive, target, deadline)
        (target / CLONE_MARKER).write_text(source, encoding="utf-8")
    except BaseException:
        shutil.rmtree(target, ignore_errors=True)
        raise
    return rules


def clone_tool(folder: Path, record: Any) -> FunctionTool:
    @tool(
        name=CLONE_TOOL,
        description=(
            "Clone a public GitHub repository (https://github.com/<owner>/<repository>) into the Task folder: its latest "
            "files, without history; read it afterwards with run_shell. Nothing else is cloned."
        ),
        approval_mode="never_require",
    )
    async def clone_repository(url: Annotated[str, Field(description="https://github.com/<owner>/<repository>")]) -> str:
        record.clone_attempted = True
        name, source = repository_target(url), archive_url(url)
        if name is None or source is None:
            return REFUSED
        target = folder / name
        if target.exists():
            return f"{name} is already in the Task folder."
        try:
            unpacked = await asyncio.to_thread(fetch_repository, source, target)
        except CloneError as error:
            return f"The clone failed: {error}."
        left_out = f"; {unpacked.links} links not copied" if unpacked.links else ""
        return f"Cloned {url.strip()} into {name} ({unpacked.files} files{left_out}). Read it with run_shell."

    return clone_repository
