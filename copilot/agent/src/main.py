from __future__ import annotations

import os

import uvicorn
from agent_framework.openai import OpenAIChatClient
from agent_framework_ag_ui import add_agent_framework_fastapi_endpoint
from azure.identity import ManagedIdentityCredential
from azure.monitor.opentelemetry import configure_azure_monitor
from fastapi import FastAPI

from agent import create_agent
from health_api import HealthApiClient


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Required runtime setting is missing: {name}")
    return value


def build_app() -> FastAPI:
    client_id = _required("AZURE_CLIENT_ID")
    endpoint = _required("AZURE_OPENAI_ENDPOINT")
    deployment_name = _required("AZURE_OPENAI_CHAT_DEPLOYMENT_NAME")
    health_base_url = _required("HEALTH_APP_BASE_URL")

    credential = ManagedIdentityCredential(client_id=client_id)
    monitor_connection = os.environ.get(
        "APPLICATIONINSIGHTS_CONNECTION_STRING",
        "",
    ).strip()
    if monitor_connection:
        configure_azure_monitor(
            connection_string=monitor_connection,
            credential=credential,
            enable_live_metrics=False,
        )
    # The v1 client takes a full base URL; hide the legacy endpoint after validation.
    os.environ.pop("AZURE_OPENAI_ENDPOINT", None)
    chat_client = OpenAIChatClient(
        model=deployment_name,
        credential=credential,
        base_url=f"{endpoint.rstrip('/')}/openai/v1/",
    )
    health_api = HealthApiClient(
        health_base_url,
        timeout_seconds=float(os.environ.get("HEALTH_API_TIMEOUT_SECONDS", "8")),
    )
    agent = create_agent(chat_client, health_api)

    application = FastAPI(title="Health copilot agent", docs_url=None, redoc_url=None)
    add_agent_framework_fastapi_endpoint(
        app=application,
        agent=agent,
        path="/",
    )

    @application.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.get("/ready")
    async def ready() -> dict[str, str]:
        return {
            "status": "ready",
            "authentication": "managed-identity",
            "deployment": deployment_name,
        }

    return application


app = build_app()


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("AGENT_PORT", "8000")),
    )
