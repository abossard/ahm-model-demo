# Project guide for agents

This project deploys a web application, an API, and an AI agent for working with Azure health models.
It also deploys a separate synthetic shop model. The shop is a demo, not the application itself.

## Setup and local work

- First-time deployment: follow [README.md](README.md#get-started-from-scratch). The entrypoint is
  `azd up`; it creates billable Azure resources.
- Installing dependencies, running locally, or testing: read
  [docs/development.md](docs/development.md). `make dev` requires a provisioned environment and still
  connects to Azure. Runtime requirements live in the Makefile and dependency manifests.
- Understanding the demo and its side effects: read [docs/demo.md](docs/demo.md).
  Health reports change model signals; the request journey writes to PostgreSQL and Storage Queue.

## Follow the request path

- Website and API: `src/web/ui` renders the graph; `src/web/app` serves the UI and health-model API.
- AI integration: `src/agent-web` hosts CopilotKit; `src/agent-app` runs the agent and calls the web API.
  The public web app proxies the assistant through `/agent`.
- Deployment: `azure.yaml` wires Container Apps and AKS. Bicep outputs provide runtime configuration.
  `scripts/hooks/postup.sh` prints the public links after `azd up`.

## Change the relevant surface

- For infrastructure, health-model topology, permissions, or hooks, read
  [infra/README.md](infra/README.md) first. Inspect an existing environment before applying templates;
  saved images and Designer positions may differ from the live deployment.
- Keep the application model and shop model distinct. Derive Azure IDs from deployment outputs.
  Synthetic Healthy signals do not establish real resource health; payment providers are simulations.
- For Python changes, follow the existing `unittest` and `subTest` patterns. Use the relevant package
  scripts for frontend changes. Run checks covering the changed behavior before handing off.
- Deploy only when requested. For configuration or documentation work, use local checks and
  read-only inspection.
