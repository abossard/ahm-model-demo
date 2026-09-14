# Azure Health Model demo

Browse Azure health models, inspect signals and dependencies, submit health reports, and ask the
embedded copilot about model health.

## Get started from scratch

Clone this repository, open a terminal in its root, and run:

```bash
azd up
```

Follow the prompts to sign in and choose an environment, subscription, and region.
`azd up` creates the Azure resources, sets up the database, and deploys the applications.
Open the **web** endpoint printed at the end.

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

- [Development](docs/development.md): local commands, tests, and limits.
- [Demo guide](docs/demo.md): models, health reports, and the request journey.
- [Infrastructure](infra/README.md): deployment, resource bindings, and saving Designer layouts.

## Code

- `src/web`: FastAPI server and React UI.
- `src/agent-web`: Next.js and CopilotKit frontend.
- `src/agent-app`: Python agent and health-model tools.
- `infra`: Bicep templates. `azure.yaml` defines Container Apps and AKS hosting.
