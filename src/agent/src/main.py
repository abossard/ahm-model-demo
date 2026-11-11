import ctypes
import logging
import os
import sys
import tempfile
from pathlib import Path

from agent_framework.foundry import FoundryChatClient
from agent_framework_foundry_hosting import ResponsesHostServer
from azure.identity import DefaultAzureCredential

from agent import FUNCTION_INVOCATION_CONFIGURATION, build_agent, task_settings
from azure_mcp import azure_mcp_tool
from paths import SKILLS_DIR
from tokens import token_source

logger = logging.getLogger("health-model-agent")

PR_SET_DUMPABLE = 4


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"environment variable {name} is not set")
    return value


def protect_process() -> bool:
    """Commands of the model run as the same user as the agent. A process that is not dumpable has its /proc files (environment,
    memory) owned by root, so those commands cannot read the identity variables or the tokens of the agent. The commands
    themselves stay dumpable: the agent still finds and kills what they leave running. Only Linux has this."""
    if sys.platform != "linux":
        return False
    done = ctypes.CDLL(None, use_errno=True).prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) == 0
    if not done:
        logger.warning("The agent could not be made not dumpable: commands of the model can read its /proc files")
    return done


def create_server() -> ResponsesHostServer:
    credential = DefaultAzureCredential()
    tokens = token_source(os.environ, credential)
    model = required("AZURE_AI_MODEL_DEPLOYMENT_NAME")
    client = FoundryChatClient(
        project_endpoint=required("FOUNDRY_PROJECT_ENDPOINT"),
        model=model,
        credential=credential,
        function_invocation_configuration=FUNCTION_INVOCATION_CONFIGURATION,
    )
    azure_mcp = azure_mcp_tool(required("MCP_URL"), tokens)
    agent = build_agent(
        client,
        skills_dir=SKILLS_DIR,
        workspace=Path(tempfile.gettempdir()),
        tools=[azure_mcp],
        tokens=tokens,
        settings=task_settings(os.environ, model),
    )
    return ResponsesHostServer(agent)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    protect_process()
    try:
        server = create_server()
    except Exception:
        logger.exception("The agent could not start; the platform reports this as session_not_ready (HTTP 424)")
        raise
    server.run()


if __name__ == "__main__":
    main()
