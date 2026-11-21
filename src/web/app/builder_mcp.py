"""The authenticated MCP Apps boundary for the first-party builder View."""

import hashlib
import logging
from urllib.parse import urlsplit

from azure.core.exceptions import AzureError
from fastapi.responses import HTMLResponse, PlainTextResponse
from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.lowlevel.helper_types import ReadResourceContents
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request

from builder import BuilderInput
from builder_apply import BuilderConflict
from config import INSTRUCTION_MAX_CHARS, MAX_BUILDER_RESOURCES
from contracts.show_me import HANDLES_SCHEMA
from obo import ConsentRequired, InteractionRequired
from sessions_store import SessionLimit, SessionNotFound, StoreUnavailable, TaskLimit
from task_runner import AgentsBusy, TaskRunning, UserBusy

URI = "ui://health-models/builder-v1.html"
MIME = "text/html;profile=mcp-app"
EXTENSION = "io.modelcontextprotocol/ui"
VIEW_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-forms"
LOG = logging.getLogger("ahm-demo")


def obj(properties, required=()):
    return {"type": "object", "properties": properties, "additionalProperties": False, "required": list(required)}


def string(limit):
    return {"type": "string", "minLength": 1, "maxLength": limit}


ARM_ID = string(2048)
SESSION = {**string(64), "pattern": "^[A-Za-z0-9_-]+$"}
SEQUENCE = {"type": "integer", "minimum": 1, "maximum": 999999999}
PROPOSAL = {"sessionId": SESSION, "proposalSeq": SEQUENCE, "proposalId": string(128)}
ROW = obj({"resourceId": ARM_ID, "displayName": string(120), "purpose": string(800),
           "impact": {"enum": ["Standard", "Limited", "Suppressed"]}}, ("resourceId", "purpose", "impact"))
REVIEWED = {"sessionId": SESSION, "analysisSeq": SEQUENCE,
            "rows": {"type": "array", "minItems": 1, "maxItems": MAX_BUILDER_RESOURCES, "items": ROW}}
TURN = {"showMeHandles": HANDLES_SCHEMA}


def ids():
    return {"type": "array", "items": ARM_ID, "maxItems": MAX_BUILDER_RESOURCES, "uniqueItems": True}


TOOLS = {
    "builder_open": ("state", "Open the health model builder or restore a saved workload.", obj({"sessionId": SESSION})),
    "builder_inventory": ("inventory", "List Azure resource groups or the resources in a group.", obj({"groupId": ARM_ID})),
    "builder_analyze": ("analyze", "Analyze selected Azure resources in a Session.",
                        obj({**TURN, "sessionId": SESSION, "groupIds": ids(), "resourceIds": ids(), "destinationGroupId": ARM_ID,
                             "modelName": string(27)}, ("groupIds", "resourceIds", "destinationGroupId", "modelName"))),
    "builder_revise": ("revise", "Revise the reviewed workload plan using the requested change and selected resources.",
                       obj({**TURN, **REVIEWED, "prompt": string(INSTRUCTION_MAX_CHARS)}, (*REVIEWED, "prompt"))),
    "builder_propose": ("propose", "Compare designs for the confirmed workload.", obj({**TURN, **REVIEWED}, REVIEWED)),
    "builder_preview": ("preview", "Inspect one compiled model, layout, plan and modelspec.", obj(PROPOSAL, PROPOSAL)),
    "builder_create": ("create", "Create the confirmed design in the destination shown to the user.",
                       obj({**PROPOSAL, "confirmed": {"const": True}}, (*PROPOSAL, "confirmed"))),
    "builder_open_model": ("open_model", "Open the model created by this Session.",
                           obj({"sessionId": SESSION, "proposalSeq": SEQUENCE}, ("sessionId", "proposalSeq"))),
    "builder_grant_monitoring": ("grant_monitoring", "Grant Monitoring Reader as the signed-in user on the approved signal sources.",
                                 obj({"sessionId": SESSION, "proposalSeq": SEQUENCE, "confirmed": {"const": True}},
                                     ("sessionId", "proposalSeq", "confirmed"))),
}


def error_result(code, message):
    return types.CallToolResult(isError=True, content=[types.TextContent(type="text", text=message)],
                                structuredContent={"error": {"code": code, "message": message}})


class BuilderServer(Server):
    def get_capabilities(self, *args, **kwargs):
        capabilities = super().get_capabilities(*args, **kwargs)
        capabilities.extensions = {EXTENSION: {"mimeTypes": [MIME]}}
        return capabilities


class BuilderMCP:
    def __init__(self, authenticated, service, view_file):
        self.authenticated = authenticated
        self.view_file = view_file
        self.server = BuilderServer("Health model builder", version="1")

        @self.server.list_tools()
        async def list_tools():
            return [types.Tool(name=name, description=description, inputSchema=schema,
                               _meta={"ui": {"resourceUri": URI, "visibility": ["app", "model"] if name == "builder_open" else ["app"]}})
                    for name, (_, description, schema) in TOOLS.items()]

        @self.server.list_resources()
        async def list_resources():
            return [types.Resource(uri=URI, name="Health model builder", mimeType=MIME)]

        @self.server.read_resource()
        async def read_resource(uri):
            if str(uri) != URI:
                raise ValueError("Unknown builder resource.")
            return [ReadResourceContents(self.view_file.read_text(encoding="utf-8"), MIME, {"ui": {"csp": {}}})]

        @self.server.call_tool()
        async def call_tool(name, arguments):
            if name not in TOOLS:
                return error_result("unknown_tool", "Unknown builder action.")
            caller = self.server.request_context.request.state.builder_caller
            try:
                result = await service(caller).perform(TOOLS[name][0], arguments)
            except (BuilderInput, ValueError, BuilderConflict) as error:
                return error_result("builder_request", str(error))
            except (AgentsBusy, UserBusy, TaskRunning):
                return error_result("task_running", "Another Task is running. Reopen your session when it finishes.")
            except (SessionLimit, TaskLimit):
                return error_result("limit_reached", "The Session or Task limit has been reached.")
            except SessionNotFound:
                return error_result("not_found", "This builder session is unavailable.")
            except StoreUnavailable:
                return error_result("store_unavailable", "The Session store is unavailable. Try again.")
            except InteractionRequired:
                return error_result("interaction_required", "Azure needs a fresh sign-in. Sign in again and reopen this builder Session.")
            except ConsentRequired:
                return error_result("consent_required", "An administrator of your directory must approve the app's delegated Azure access.")
            except AzureError as error:
                status = getattr(error, "status_code", None)
                LOG.warning("builder action=%s azure_status=%s error_type=%s", name, status, type(error).__name__)
                message = ("Your account needs Azure access at the selected scope." if status == 403 else
                           "Azure could not complete this action. Check the selected scope and try again.")
                return error_result("azure_error", message)
            except Exception:
                LOG.exception("builder action failed action=%s", name)
                return error_result("builder_failed", "The builder could not complete this action. Reopen the session and try again.")
            return types.CallToolResult(structuredContent=result, content=[types.TextContent(type="text", text=TOOLS[name][1])])

    async def __call__(self, scope, receive, send):
        request = Request(scope)
        origin = request.headers.get("origin")
        if origin:
            try:
                source = urlsplit(origin)
                allowed = source.netloc == request.headers.get("host") and source.scheme in ("http", "https")
            except ValueError:
                allowed = False
            if not allowed:
                await PlainTextResponse("Unexpected origin", status_code=403)(scope, receive, send)
                return
        request.state.builder_caller = await run_in_threadpool(self.authenticated, request)
        manager = StreamableHTTPSessionManager(self.server, json_response=True, stateless=True)
        async with manager.run():
            await manager.handle_request(scope, receive, send)

    def sandbox_view(self, digest):
        # The first-party host serves exactly the document it read through MCP in an opaque-origin frame.
        try:
            html = self.view_file.read_bytes()
        except FileNotFoundError:
            return PlainTextResponse("The builder view is unavailable.", status_code=404)
        if digest != hashlib.sha256(html).hexdigest():
            return PlainTextResponse("The builder has changed. Reopen it.", status_code=404)
        return HTMLResponse(html, headers={"Content-Security-Policy": VIEW_POLICY})
