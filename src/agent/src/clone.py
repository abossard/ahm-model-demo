"""The one way a repository reaches the Task folder: a tool that agent code runs, not a command the model writes.

Only public repositories at https://github.com/<owner>/<repository> are cloned, shallow, into the Task folder. `git` itself is
kept off the shell's path (the image keeps it in /opt/git), so a command of the model cannot push or fetch anywhere."""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import shutil
from pathlib import Path
from typing import Annotated, Any

from agent_framework import FunctionTool, tool
from pydantic import Field

CLONE_TOOL = "clone_repository"
GITHUB_REPOSITORY = re.compile(r"https://github\.com/(?P<owner>[A-Za-z0-9][A-Za-z0-9-]{0,38})/(?P<name>[A-Za-z0-9_][A-Za-z0-9._-]{0,99}?)(?:\.git)?/?")
IMAGE_GIT = "/opt/git/git"
CLONE_TIMEOUT_SECONDS = 120
OUTPUT_LIMIT = 2_000
FILE_LIMIT = 20_000
PASSED_ENV_KEYS = (
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "GIT_SSL_CAINFO",
)
REFUSED = "Error: refused. Only public repositories at https://github.com/<owner>/<repository> are cloned."


def repository_target(url: str) -> str | None:
    """The folder a repository is cloned into (its name), or None for an address that is not https://github.com/<owner>/<repository>."""
    found = GITHUB_REPOSITORY.fullmatch(url.strip())
    return found["name"] if found else None


def git_binary() -> str:
    """The `git` of the image (kept off the PATH), else the one on this machine."""
    return os.environ.get("CLONE_GIT") or (IMAGE_GIT if Path(IMAGE_GIT).exists() else shutil.which("git") or "git")


def clone_env(parent: dict[str, str] | os._Environ[str], folder: Path) -> dict[str, str]:
    """What git sees: no credentials, no prompt, no configuration of its own, only the path, the proxies and the certificates."""
    env = {key: parent[key] for key in PASSED_ENV_KEYS if key in parent}
    return {**env, "HOME": str(folder), "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_ASKPASS": "true"}


def clone_command(url: str, name: str) -> list[str]:
    scheme = url.split(":", 1)[0].lower()
    return [
        git_binary(),
        "-c",
        "protocol.allow=never",
        "-c",
        f"protocol.{scheme}.allow=always",
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--no-tags",
        "--",
        url,
        name,
    ]


async def run_git(command: list[str], folder: Path) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=folder,
        env=clone_env(os.environ, folder),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), CLONE_TIMEOUT_SECONDS)
    except TimeoutError:
        process.kill()
        await process.wait()
        return 124, f"timed out after {CLONE_TIMEOUT_SECONDS}s"
    return process.returncode or 0, output.decode("utf-8", errors="replace")[-OUTPUT_LIMIT:]


def count_files(root: Path) -> int:
    count = 0
    for _, names, files in os.walk(root):
        names[:] = [name for name in names if name != ".git"]
        count += len(files)
        if count >= FILE_LIMIT:
            break
    return count


def clone_tool(folder: Path, record: Any) -> FunctionTool:
    @tool(
        name=CLONE_TOOL,
        description=(
            "Clone a public GitHub repository (https://github.com/<owner>/<repository>), shallow, into the Task folder; read "
            "it afterwards with run_shell. Nothing else is cloned."
        ),
        approval_mode="never_require",
    )
    async def clone_repository(url: Annotated[str, Field(description="https://github.com/<owner>/<repository>")]) -> str:
        record.clone_attempted = True
        name = repository_target(url)
        if name is None:
            return REFUSED
        target = folder / name
        if target.exists():
            return f"{name} is already in the Task folder."
        folder.mkdir(parents=True, exist_ok=True)
        code, output = await run_git(clone_command(url.strip(), name), folder)
        if code != 0:
            with contextlib.suppress(OSError):
                shutil.rmtree(target)
            return f"The clone failed (exit code {code}): {output.strip()}"
        return f"Cloned {url.strip()} into {name} ({count_files(target)} files). Read it with run_shell."

    return clone_repository
