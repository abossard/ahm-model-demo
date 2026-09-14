# Development

## Start here

Run `azd up` from the repository root for first-time setup.
It creates the environment and deploys the app. See the [README](../README.md#get-started-from-scratch).

## Prerequisites

Use macOS, Linux, or WSL. Install Azure CLI, Azure Developer CLI (`azd`), Git, Bash, `make`, `jq`,
`curl`, and the PostgreSQL client (`psql` on your PATH). The full deployment includes AKS; have Docker
and `kubectl` available.

For local development, install [Node.js 26+](https://nodejs.org/en/download) and
[uv](https://docs.astral.sh/uv/getting-started/installation/). `uv` manages Python 3.14.
The [Makefile](../Makefile) and [agent-web/package.json](../src/agent-web/package.json) hold the runtime
requirements.

Sign in with `az login` before deployment: the provisioning hook reads your Azure CLI identity.
Use the same account and tenant when `azd` asks you to sign in. You need permission to create Azure
resources and assign roles, plus Azure OpenAI quota.

To browse beyond the application model, review the
[catalog-access instructions](../infra/README.md#model-catalog-access) printed during provisioning.

## Run locally

After that, start local development from the repository root:

```bash
make dev
```

To work against another existing environment, run `azd env select <environment>` first.

`make dev` installs dependencies, builds the React UI, and starts three services:

| Service | Local address |
|---------|---------------|
| Web app | http://localhost:8080 |
| Copilot frontend | http://localhost:3000 |
| Agent backend | http://localhost:8000 |

Use the web app to reach the embedded copilot. Press Ctrl+C to stop the services.

## Useful commands

| Command | Purpose |
|---------|---------|
| `make deps` | Install Python and frontend dependencies. |
| `make ui` | Rebuild the React UI. |
| `make env` | Print the selected environment's runtime configuration. |

Keep `.azure/` and printed connection settings out of commits.

## Checks

```bash
.venv-health-ui/bin/python -m unittest discover -s tests
npm --prefix src/web/ui run typecheck
npm --prefix src/web/ui test
```

The Python suite includes two storyboard checks for the absent `docs/scenes` directory. Those checks
currently fail.

## Local limits

- The request journey needs the private Storage Queue endpoint. Run it through the deployed app.
- `make dev` stays running if one service exits. Check that service's terminal output.
- If configuration is missing, check the selected environment and its outputs before provisioning.
