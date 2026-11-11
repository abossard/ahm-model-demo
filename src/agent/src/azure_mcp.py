from collections.abc import Iterable

from agent_framework import MCPStreamableHTTPTool
from mcp import types

from redaction import redact
from tokens import AzureUnavailable, TokenSource, secure_url
from tools import CURRENT_RUN

ACTIVITY_LOG_TOOL = "monitor_activitylog_list"
AZURE_MCP_TOOLS = (
    "monitor_healthmodels_list",
    "monitor_healthmodels_get",
    "monitor_healthmodels_inspect",
    "monitor_metrics_definitions",
    "monitor_metrics_query",
    "monitor_workspace_log_query",
    "group_resource_list",
    ACTIVITY_LOG_TOOL,
)

REQUEST_TIMEOUT_SECONDS = 120


def current_secrets(tokens: TokenSource) -> list[str]:
    """The nonce of the Task of this run and the token held for it."""
    record = CURRENT_RUN.get()
    nonce = record.nonce if record else ""
    return [secret for secret in (nonce, tokens.cached(nonce)) if secret]


def bearer_header(tokens: TokenSource) -> dict[str, str]:
    """The header of every request this run sends to the MCP server: the token held for the Task of this run."""
    record = CURRENT_RUN.get()
    token = tokens.cached(record.nonce if record else None)
    if token is None:
        raise AzureUnavailable(record.blocked if record and record.blocked else "There is no token for this Task.")
    return {"Authorization": f"Bearer {token}"}


class AzureMCPTool(MCPStreamableHTTPTool):
    """The remote Azure MCP server. The server needs the user's token for every request, handshake included, so the
    tool connects only inside a run that has one. The agent opens its tools once when the server starts, outside any run:
    that entry, and a run without a token, leave the tool unconnected and the run without Azure tools."""

    async def connect(self, *, reset: bool = False) -> None:
        record = CURRENT_RUN.get()
        if record is not None and not record.blocked:
            await super().connect(reset=reset)


def azure_mcp_tool(url: str, tokens: TokenSource) -> AzureMCPTool:
    return AzureMCPTool(
        name="azure",
        url=secure_url(url, "MCP_URL"),
        approval_mode="never_require",
        allowed_tools=AZURE_MCP_TOOLS,
        load_prompts=False,
        parse_tool_results=lambda result: parse_result(result, current_secrets(tokens)),
        request_timeout=REQUEST_TIMEOUT_SECONDS,
        header_provider=lambda _runtime_arguments: bearer_header(tokens),
    )


def parse_result(result: types.CallToolResult, secrets: Iterable[str] = ()) -> str:
    """The server answers with text. Results and errors alike pass through redact, since errors become the tool error."""
    return redact("\n".join(item.text for item in result.content if isinstance(item, types.TextContent)), secrets)
