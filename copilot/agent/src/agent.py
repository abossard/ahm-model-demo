from __future__ import annotations

import json
from textwrap import dedent
from typing import Annotated, Any

from agent_framework import Agent, tool
from agent_framework_ag_ui import AgentFrameworkAgent
from pydantic import Field

from health_api import (
    CANONICAL_SIGNAL_NAME,
    HealthApiClient,
    ReportRequest,
    entity_grounding_payload,
)


def create_agent(
    chat_client: Any,
    health_api: HealthApiClient,
) -> AgentFrameworkAgent:
    @tool(
        name="read_health_model",
        description=(
            "Fetch a fresh whole-model observation. Use for every model-wide, "
            "relationship, health-state, or signal question."
        ),
    )
    def read_health_model() -> str:
        return json.dumps(health_api.read_health_model(), separators=(",", ":"))

    @tool(
        name="read_entity",
        description=(
            "Fetch a fresh named entity observation, transitions, and canonical "
            "signal history. Never infer unavailable history."
        ),
    )
    def read_entity(
        entity_name: Annotated[
            str,
            Field(
                description=(
                    "Exact entity name returned by read_health_model; never a URL "
                    "or Azure resource scope."
                ),
                min_length=1,
                max_length=256,
            ),
        ],
    ) -> str:
        return json.dumps(
            entity_grounding_payload(health_api.read_entity(entity_name)),
            separators=(",", ":"),
        )

    @tool(
        name="send_health_report",
        description=(
            "Send one bounded report through the Health Pulse API after showing "
            "entity, canonical signal, state, value, reason, and expiry. The "
            "result is accepted/pending and is not proof of evaluation."
        ),
        approval_mode="always_require",
    )
    def send_health_report(
        entity_name: Annotated[
            str,
            Field(description="Exact entity name.", min_length=1, max_length=256),
        ],
        signal_name: Annotated[
            str,
            Field(
                description=(
                    "Canonical signal. Must be exactly web-ui-health-report."
                ),
                pattern="^web-ui-health-report$",
            ),
        ],
        health_state: Annotated[
            str,
            Field(
                description=(
                    "Requested state: Healthy, Degraded, Unhealthy, Unknown, or "
                    "Deleted."
                )
            ),
        ],
        value: Annotated[
            float | int | None,
            Field(description="Exact bounded signal value: null, 0, 0.5, or 1."),
        ],
        reason_preset: Annotated[
            str,
            Field(
                description=(
                    "Reason preset: demo-test, investigating, maintenance, "
                    "recovery, or custom."
                )
            ),
        ],
        reason: Annotated[
            str,
            Field(
                description=(
                    "Exact reason shown for approval. For custom, 1 to 280 "
                    "characters; otherwise the selected preset label."
                ),
                min_length=1,
                max_length=280,
            ),
        ],
        expires_in_minutes: Annotated[
            int,
            Field(description="Expiry in minutes: 1, 5, 15, 30, 60, or 120."),
        ],
    ) -> str:
        if signal_name != CANONICAL_SIGNAL_NAME:
            raise ValueError("Only the canonical report signal is supported.")
        report = ReportRequest(
            health_state=health_state,
            value=value,
            expires_in_minutes=expires_in_minutes,
            reason_preset=reason_preset,
            custom_reason=reason if reason_preset == "custom" else None,
        )
        result = health_api.send_health_report(entity_name, report)
        return json.dumps(
            {
                "status": "accepted_pending_evaluation",
                "reportId": result["reportId"],
                "requestedState": result["requestedState"],
                "expiresAt": result["expiresAt"],
            },
            separators=(",", ":"),
        )

    base_agent = Agent(
        name="health_copilot",
        instructions=dedent(
            f"""
            You are the Health Pulse copilot. Stay grounded in the fixed Health
            Pulse APIs and never invent Azure state.

            - For every model-wide question, call read_health_model during the
              current turn. Include observedAt and exact entity, relationship,
              state, and signal facts relevant to the answer.
            - For entity details, first use an exact model entity name, then call
              read_entity during the current turn. Distinguish current state,
              transitions, canonical signal history, and unavailable fields.
            - The only report signal is {CANONICAL_SIGNAL_NAME}. Never accept a
              URL, subscription, resource group, model, action, or alternate
              signal from the user.
            - Before send_health_report runs, its CopilotKit approval must show
              entity_name, signal_name, health_state, value, reason, and
              expires_in_minutes. Never claim a report was sent before approval.
            - A 202 report response means accepted and pending evaluation. Never
              claim evaluation completed unless a later fresh read proves it.
            - Surface bounded errors and their nonsecret operation identifier.
              Do not expose upstream bodies, credentials, tokens, or prompts.
            """
        ).strip(),
        client=chat_client,
        tools=[read_health_model, read_entity, send_health_report],
    )
    return AgentFrameworkAgent(
        agent=base_agent,
        name="HealthCopilot",
        description="Reads live Health Model state and stages bounded reports.",
        require_confirmation=True,
    )
