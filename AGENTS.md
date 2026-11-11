# Project guide for agents

This project deploys a web app, one Foundry hosted agent and two Azure health models.
Users run Tasks on health models in shared Sessions. The agent proposes a Health model diff and the web app applies it.
Terms follow [GLOSSARY.md](GLOSSARY.md).

## Setup and local work

- First-time deployment: follow [README.md](README.md#get-started-from-scratch). The entrypoint is
  `azd up`; it creates billable Azure resources.
- Installing dependencies, running locally, or testing: read
  [docs/development.md](docs/development.md). `make dev` requires a provisioned environment and still
  connects to Azure.
- Understanding the demo and its side effects: read [docs/demo.md](docs/demo.md).
  Health reports change model signals; Apply writes to live models and has no undo.

## Follow the request path

- Web UI: `src/web/ui` renders the graph, Sessions, the Activity timeline and the Health model diff. It calls the web app's `/api`.
- Web app: `src/web/app` serves the UI and the API: model catalog, health reports, Sessions and Tasks in Blob Storage, and Apply.
  It is the only caller of the hosted agent and the only writer of health models.
- Hosted agent: `src/agent` runs each Task with the healthmodel skills and ends it with `submit_result`.
  The web app calls it through the Foundry project endpoint.
- Azure MCP: `src/mcp` is a read-only `azmcp` Container App. The agent calls it over HTTP with the signed-in user's token,
  which it gets from the web app's token broker, to read health models, metrics, logs and resources.
- Contracts: the HTTP API, the Task result and the Session store layout are in
  [docs/redesign/plan.md](docs/redesign/plan.md). The reasons are in [docs/adr](docs/adr/).
- Deployment: `azure.yaml` deploys the web service, then its `postdeploy` hook runs `src/agent/deploy/deploy-agent.sh`.
  Bicep outputs configure the app at runtime. `scripts/hooks/postup.sh` prints the public link after `azd up`.

## Change the relevant surface

- For infrastructure, health model topology, permissions, or hooks, read
  [infra/README.md](infra/README.md) first. Inspect an existing environment before applying templates;
  saved Designer positions and portal edits may differ from the live deployment.
- Derive Azure IDs, names and endpoints from deployment outputs.
- Keep the agent read-only: its tools read Azure or work inside its sandbox. Only the web app writes health models,
  after the user approves a Health model diff.
- Keep the two copies of `task-result.schema.json` (`src/agent/src/contracts/`, `src/web/app/contracts/`) byte-identical.
  A change to the Task result also changes `src/agent/src/instructions.py` and the contract in `docs/redesign/plan.md`.
- The agent signals of `hm-<env>` query the web app's `foundry.agent.*` spans. Rename a span and its signal together.
- The limits of the public app live in `src/web/app/config.py`.
  [docs/demo.md](docs/demo.md#limits-of-the-public-app) lists their values: change both.
- Write parametrized tests in the style of the file you edit: `unittest` with `subTest` in Python, `it.each` in vitest.
- Run the checks of each area you changed before handing off:
  - Web app and infrastructure: `.venv-health-ui/bin/python -m unittest discover -s tests` (`make deps` creates the venv)
  - UI: `npm --prefix src/web/ui run typecheck` and `npm --prefix src/web/ui test`, plus
    `npm --prefix src/web/ui run e2e -- --project=chromium` for graph or workspace changes and
    `npm --prefix src/web/ui run e2e -- --config playwright.real.config.ts` for changes to the API the UI calls
  - Agent: `uv run --project src/agent python -m unittest discover -s src/agent/tests`
- Deploy only when requested. When you change configuration or documentation, run local checks and inspect Azure read-only.
