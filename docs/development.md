# Development

## Start here

Run `azd up` from the repository root for first-time setup.
It provisions Azure, deploys the web app and creates the hosted agent. See the [README](../README.md#get-started-from-scratch).

## Prerequisites

- macOS, Linux or WSL.
- Azure CLI (`az`), Azure Developer CLI (`azd`), Git, Bash, `make`, `jq` and `curl`.
- You do not need Docker: `azd` builds the web image remotely and the `postdeploy` hook builds the agent image in the container registry.
- For local development: [Node.js](https://nodejs.org/en/download) (the web image builds the UI on Node 26, see [Dockerfile](../src/web/Dockerfile))
  and [uv](https://docs.astral.sh/uv/getting-started/installation/), which installs Python 3.14.
- Sign in with `az login` and `azd auth login` using the same account and tenant. The `postdeploy` hook calls `az` as that account.
- You need permission to create resources, custom roles and role assignments in the subscription. Owner covers it.
  [Hosted agent deploy](../infra/README.md#hosted-agent-deploy) lists what the hook needs on top.
- Quota for the model deployment. The check is in [Foundry](../infra/README.md#foundry).
- The app lists every health model the signed-in user can read, in every subscription of their directory. A user of another directory needs [an administrator's consent](../infra/README.md#another-directory).

## Commands

| Command | Purpose |
|---------|---------|
| `make deps` | Create `.venv-health-ui` (Python 3.14) with the web app requirements. Install the UI packages when `src/web/ui/node_modules` is missing. |
| `make ui` | Run `make deps`, then build the UI into `src/web/ui/dist`. |
| `make dev` | Run `make ui`, then serve the web app at http://127.0.0.1:8080 against the selected azd environment. `WEB_PORT` changes the port. |
| `make env` | Print the variables `make dev` exports. They include the Application Insights connection string. |
| `azd hooks run postup` | Print the web app links again. |
| `azd hooks run postdeploy` | Build the agent image if its tag is new, create an agent version when the definition changed and grant any missing read roles. |

Keep `.azure/` and printed connection settings out of commits.

## Run the web app locally

After `azd up`, run `make dev`. To use another existing environment, run `azd env select <environment>` first.

- `scripts/local-env.sh` exports seven variables from the selected environment and sets `SESSIONS_CONTAINER_URL=memory:`.
  It stops with `LOCAL_ENV_FAIL` when you have not selected an environment (`azd env select <name>`)
  or an output is missing (`azd provision` writes the outputs back).
- Sessions stay in process memory and a restart clears them. The session store takes only private endpoint traffic,
  so a local run cannot reach it ([Session store](../infra/README.md#session-store)).
- `make dev` signs nobody in (`AUTH_MODE=local`). To sign in to a local server on port 8080 with Entra, add
  `http://localhost:8080/` to the deployed web app registration: `azd env set ENTRA_ALLOW_LOCAL_REDIRECT true`, then
  `azd provision`. It is off by default because that registration accepts any directory. Set it back to `false` and
  provision again when you are done.
- The app runs as your `az login` identity. For the agent and the health models your account needs the access Bicep gives the web identity ([infra/README.md](../infra/README.md)):
  - Foundry Agent Consumer on the Foundry project
  - the health model roles
- Tasks run on the deployed agent and Apply writes live health models. [Without Azure](#without-azure) avoids that.

### Without Azure

`FOUNDRY_PROJECT_ENDPOINT=fake:` replaces the hosted agent with a scripted agent that returns a canned result per Task type.
It also replaces health model reads and writes with two fixture models named by `HEALTH_MODEL_NAME` and `HEALTH_MODEL_DESIGN_NAME`.
The app accepts health reports and drops them.

`make dev` exports the endpoint from the azd environment, so start uvicorn yourself with placeholders for the other variables.
The block keeps Sessions in memory with `SESSIONS_CONTAINER_URL=memory:`, as `make dev` does:

```bash
export AUTH_MODE=local AZURE_SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000000 AZURE_RESOURCE_GROUP=rg-local \
  HEALTH_MODEL_NAME=hm-local HEALTH_MODEL_DESIGN_NAME=hm-local-design FOUNDRY_AGENT_NAME=health-model-agent \
  SESSIONS_CONTAINER_URL=memory: FOUNDRY_PROJECT_ENDPOINT=fake: \
  'APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=http://127.0.0.1:9/'
make ui
.venv-health-ui/bin/python -m uvicorn --app-dir src/web/app --host 127.0.0.1 --port 8080 main:app
```

Add `FIXTURE_LIVE_SECONDS=60` to make the fixture model change over time (a scripted incident of that period: `orders-db` degrades, fails and recovers, `orders-api` follows) and `HUB_POLL_SECONDS=2` to push it quickly. Without them the fixture stays still, as the specs expect.

The connection string sends telemetry to a closed local port, so nothing leaves the machine. The Azure Monitor exporter logs warnings.
`src/web/ui/playwright.real.config.ts` runs the app with the same values: change both together.

## Run the agent locally

[src/agent/README.md](../src/agent/README.md) has the steps: set five variables, start the agent on port 8088 against the deployed MCP server and send a Task with `curl`.

- You need `uv` and `az login`. `azmcp` is built in the registry from `src/mcp`, not on your machine.
- The web app reaches the agent only through the Foundry project endpoint, so a local agent takes `curl` requests. To use an agent change in Tasks, ship it with `azd hooks run postdeploy`.
- The image tag hashes the agent sources. An unchanged tag skips the build.
  See [Hosted agent deploy](../infra/README.md#hosted-agent-deploy).

## Checks

```bash
.venv-health-ui/bin/python -m unittest discover -s tests
npm --prefix src/web/ui run typecheck
npm --prefix src/web/ui test
npm --prefix src/web/ui run e2e -- --project=chromium
npm --prefix src/web/ui run e2e -- --config playwright.real.config.ts
uv run --project src/agent python -m unittest discover -s src/agent/tests
az bicep build --file infra/main.bicep --stdout > /dev/null
```

- The Python suite needs `.venv-health-ui` (`make deps`). It covers the web app and the infrastructure; `tests/test_infra.py` compiles `infra/main.bicep`.
- The e2e suite builds the UI, serves it with `vite preview` and stubs the API, so it needs no Azure. The stubs answer `GET /api/config` as `local`: nobody signs in.
  `tests/entra.spec.ts` runs the real MSAL library through the redirect flow against a stand-in for the Entra endpoints, under the policy the web app sends: the sign-in page, a directory named by domain, ID or subscription ID, and a personal account that lands in no directory.
  Playwright needs its browser once: `npm --prefix src/web/ui exec playwright -- install chromium`.
- The real-backend run (`tests/real-backend.spec.ts`, 4 tests) builds the UI and starts uvicorn in the offline mode above on a free port.
  It drives the real web app with the scripted agent and the fixture models, so the run stubs nothing and reaches nothing in Azure. It needs `.venv-health-ui` (`make deps`).
- The agent suite skips the test that starts the real `azmcp` unless `AZMCP_PATH` points to one.

For graph or workspace changes, run targeted browser checks before the full suite:

```bash
npm --prefix src/web/ui run e2e -- tests/adaptive-graph.spec.ts tests/graph-ux.spec.ts tests/spa.spec.ts tests/workspace.spec.ts --project=chromium
```

`tests/visual-c1.spec.ts` checks text containment and overlap across the layouts. It saves light and dark screenshots
and measured reports in `.playwright-mcp/visual-c1/`.
`tests/workspace-visual.spec.ts` saves light and dark screenshots of the Session workspace and phone screenshots in `.playwright-mcp/workspace/`.
They are evidence for review: no assertion compares pixels.

## Live Playwright checks

Use the live config in `src/web/ui/playwright.live.config.ts` for read-only checks of a deployed app:

```bash
LIVE_BASE_URL=https://<deployed-web-app-url> \
npm --prefix src/web/ui run e2e -- --config playwright.live.config.ts
```

- It runs only `@live-readonly` tests: the shell and its policy, the catalog, every model, layouts, search, the selected entity above the timeline, the Sessions workspace,
  finished Tasks, addresses, light and dark and a phone width. They change nothing and cost no model tokens. Each fails on a console error,
  a security policy violation, a failed request or an unhandled rejection. None clicks Apply.
- `@live-mutation` tests run only with `LIVE_INCLUDE_MUTATION=1`. They send a health report with a 1 minute expiry on `LIVE_REPORT_ENTITY`
  (default `session-storage`), create a Session and run an Explain Task, which costs model tokens.
- The config needs `LIVE_BASE_URL` and has no default.
- A deployment in Entra mode needs a signed-in browser, which cannot be had unattended. `LIVE_STORAGE_STATE` names a Playwright storage state saved after
  a sign-in; without it every live test skips and says why. A deployment without sign-in needs neither.
- The default config ignores `tests/live-experience.spec.ts` and `tests/real-backend.spec.ts`.

## Local limits

- `make dev` has no auto-reload. Restart it after a change; it rebuilds the UI on start.
- `make deps` stops with `VENV_MISMATCH` when `.venv-health-ui` runs another Python than 3.14. Remove the directory and run `make deps` again.
- The local web app never calls a local agent. Tasks in the UI run on the deployed agent or on the scripted one.
