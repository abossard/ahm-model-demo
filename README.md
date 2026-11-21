# Azure Health Model demo

- A web app for browsing Azure health models, sending health reports and running agent Tasks on them.
- Review, Explain and Design Tasks run in shared Sessions on one Foundry hosted agent. A Review or Design task ends in a Health model diff that you approve and the web app applies.
- The agent only reads Azure, through the Azure MCP server. Only the web app writes health models.
- One Container App in a small VNet, one hosted agent, Sessions in Blob Storage behind a private endpoint, one region.
- Sign in with Microsoft, choose an Azure directory, and open the workspace. Azure RBAC determines which resources you see. Your Sessions belong to your account in that directory. Sign out to choose another directory. [Sign-in guide](docs/demo.md#sign-in).

## Get started from scratch

Clone this repository, open a terminal in its root, and run:

```bash
azd up
```

- Sign in, then choose an environment name (1 to 20 characters), a subscription and a region.
- Choose `swedencentral`. Foundry hosted agents are not available in North Europe, and a region cannot change after the first provision.
- Use a new environment. Provisioning cannot update an older version's environment in place ([details](infra/README.md#deploying)).
- `azd up` provisions the resources, deploys the web app, then builds the agent image and creates the hosted agent with its read roles.
- It prints the links to the web app at the end.
- Deployment creates [billable Azure resources](infra/README.md#resources). See [prerequisites](docs/development.md#prerequisites) for tools, permissions and model quota.

## What you can do

- Browse every health model you can read in every subscription of the directory you signed in to. The first sign-in of a directory needs [an administrator's consent](infra/README.md#another-directory).
- Send a health report to an entity and watch the state roll up.
- Create a health model from Azure resources or groups. Review the assistant's analysis, compare designs, download the plan and model specification, then create the selected design with its layout. [Builder walkthrough](docs/demo.md#create-a-health-model)
- Start a Task in a Session: Review a model, Explain why an entity has its state, or Design a model for a workload. The Activity timeline shows each agent step.
- Approve some or all changes of a Health model diff and Apply them to a live model, as you, where your Azure role allows it. Apply has no undo.

## Models

| Model | Purpose |
|-------|---------|
| `hm-<env>` | The application: web app, hosted agent, Foundry account and session storage, from metrics, log queries, an availability test and health reports. Selected by default. |
| `hm-<env>-design` | Starts empty. The target of Design tasks. |

## Develop locally

After `azd up`, run `make dev` and open [127.0.0.1:8080](http://127.0.0.1:8080).
It runs the web app against the deployed hosted agent and health models. Sessions stay in memory, because the session store takes only private endpoint traffic.

## Documentation

- [Development](docs/development.md): prerequisites, local runs, checks and limits.
- [Demo guide](docs/demo.md): a walkthrough and its side effects.
- [Architecture and plan](docs/redesign/plan.md), [decisions](docs/adr/) and [glossary](GLOSSARY.md).
- [Infrastructure](infra/README.md): resources, roles, health model topology and saving Designer layouts.
- [Agent](src/agent/README.md): the hosted agent, its local run and its deploy script.
- [Agent guide](AGENTS.md): setup and project context for coding agents.
- [Azure Developer CLI documentation](https://learn.microsoft.com/azure/developer/azure-developer-cli/).

## Code

- `src/web/app`: FastAPI API and static host for the UI.
- `src/web/ui`: React UI with Fluent UI v9, zustand and a React Flow graph.
- `src/agent`: hosted agent image, health model skills and the deploy script.
- `infra`: Bicep templates. `azure.yaml` wires the web service and the `postdeploy` hook.
- `tests`: Python tests for the web app and the infrastructure.
- `scripts`: the local environment export and the `postup` hook.
