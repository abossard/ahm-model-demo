"""A stand-in for the remote Azure MCP server: streamable HTTP at `/`, a bearer on every request, and a record of what
arrived. Like the real server it answers 401 to a request without a token it knows."""

import contextlib
import json
import threading
import time

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl"


class FakeAzureMcp:
    def __init__(self, valid_tokens):
        self.valid_tokens = set(valid_tokens)
        self.requests = []
        self.secrets_to_leak = []
        self.server = MCPServer("fake-azure-mcp")

        @self.server.tool()
        def monitor_healthmodels_list() -> str:
            return json.dumps({"status": 200, "results": {"healthModels": []}})

        @self.server.tool()
        def monitor_healthmodels_inspect() -> str:
            raise ToolError(f"upstream said no for {' and '.join(self.secrets_to_leak)}")

        @self.server.tool()
        def group_resource_list() -> str:
            return f"token {JWT} for rg-example"

        @self.server.tool()
        def subscription_list() -> str:
            return "not one of the listed tools"

    def tool_calls(self):
        return [request for request in self.requests if request["rpc"] == "tools/call"]

    def app(self):
        inner = self.server.streamable_http_app(streamable_http_path="/", json_response=True)
        requests, valid = self.requests, self.valid_tokens

        async def recording(scope, receive, send):
            if scope["type"] != "http":
                return await inner(scope, receive, send)
            headers = {key.decode().lower(): value.decode() for key, value in scope["headers"]}
            body, more = b"", True
            while more:
                message = await receive()
                body += message.get("body", b"")
                more = message.get("more_body", False)
            try:
                rpc = json.loads(body).get("method", "") if body else ""
            except ValueError:
                rpc = ""
            authorization = headers.get("authorization")
            requests.append({"method": scope["method"], "rpc": rpc, "authorization": authorization, "session": headers.get("mcp-session-id")})
            if authorization is None or authorization.removeprefix("Bearer ") not in valid:
                await send({"type": "http.response.start", "status": 401, "headers": [(b"content-type", b"application/json")]})
                return await send({"type": "http.response.body", "body": b'{"error":"unauthorized"}'})

            replayed = False

            async def replay():
                nonlocal replayed
                if not replayed:
                    replayed = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await receive()

            await inner(scope, replay, send)

        return recording


@contextlib.contextmanager
def serving(fake):
    """The fake server on an ephemeral local port; yields its URL."""
    server = uvicorn.Server(uvicorn.Config(fake.app(), host="127.0.0.1", port=0, log_level="error", lifespan="on"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.02)
    if not server.started:
        raise RuntimeError("the fake MCP server did not start")
    try:
        yield f"http://127.0.0.1:{server.servers[0].sockets[0].getsockname()[1]}/"
    finally:
        server.should_exit = True
        thread.join(10)
