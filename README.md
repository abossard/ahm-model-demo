# Azure Health Model demo

A web application, API, and AI agent for viewing and modifying Azure health models.
The website and agent can inspect models and submit health reports.
The deployment also includes a separate shop demo health model.

## Get started from scratch

Clone this repository, open a terminal in its root, and run:

```bash
azd up
```

Follow the prompts to sign in and choose an environment, subscription, and region.
`azd up` creates the Azure resources, sets up the database, and deploys the applications.
At the end, it prints links to the web application, AI assistant, API, and shop demo.

See [prerequisites](docs/development.md#prerequisites) for the required tools and permissions.
Deployment creates billable Azure resources.

## Develop locally

After `azd up`, run:

```bash
make dev
```

Open [localhost:8080](http://localhost:8080). Local development still uses your Azure resources.
`make dev` is for local development; `azd up` is the first-time setup.

## Models

| Model | Purpose |
|-------|---------|
| `hm-<env>` | Application health from metrics, logs, availability tests, and health reports. |
| `hm-<env>-shop` | An 18-node shop with two simulated payment providers and six real Azure-resource links. |

The shop uses synthetic signals. A green shop node does not prove that its Azure resource is healthy.

## Documentation

- [Azure Developer CLI documentation](https://learn.microsoft.com/azure/developer/azure-developer-cli/).
- [Development](docs/development.md): local commands, tests, and limits.
- [Demo guide](docs/demo.md): models, health reports, and the request journey.
- [Infrastructure](infra/README.md): deployment, resource bindings, and saving Designer layouts.
- [Agent guide](AGENTS.md): setup and project context for coding agents.

## Code

- `src/web`: FastAPI server and React UI.
- `src/agent-web`: Next.js and CopilotKit frontend.
- `src/agent-app`: Python agent and health-model tools.
- `infra`: Bicep templates. `azure.yaml` defines Container Apps and AKS hosting.
