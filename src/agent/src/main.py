import logging
import os
import tempfile
from pathlib import Path

from agent_framework.foundry import FoundryChatClient
from agent_framework_foundry_hosting import ResponsesHostServer
from azure.identity import DefaultAzureCredential

from agent import FUNCTION_INVOCATION_CONFIGURATION, build_agent
from azure_mcp import azure_mcp_tool
from tokens import token_source

logger = logging.getLogger("health-model-agent")

SKILLS_DIR = Path(__file__).resolve().parents[1] / "skills"


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"environment variable {name} is not set")
    return value


def create_server() -> ResponsesHostServer:
    credential = DefaultAzureCredential()
    tokens = token_source(os.environ, credential)
    client = FoundryChatClient(
        project_endpoint=required("FOUNDRY_PROJECT_ENDPOINT"),
        model=required("AZURE_AI_MODEL_DEPLOYMENT_NAME"),
        credential=credential,
        function_invocation_configuration=FUNCTION_INVOCATION_CONFIGURATION,
    )
    azure_mcp = azure_mcp_tool(required("MCP_URL"), tokens)
    agent = build_agent(client, skills_dir=SKILLS_DIR, workspace=Path(tempfile.gettempdir()), tools=[azure_mcp], tokens=tokens)
    return ResponsesHostServer(agent)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        server = create_server()
    except Exception:
        logger.exception("The agent could not start; the platform reports this as session_not_ready (HTTP 424)")
        raise
    server.run()


if __name__ == "__main__":
    main()
