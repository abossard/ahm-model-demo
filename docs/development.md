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
| `azd hooks run postup` | Print website links again after `azd up`. |

Keep `.azure/` and printed connection settings out of commits.

## Checks

```bash
.venv-health-ui/bin/python -m unittest discover -s tests
npm --prefix src/web/ui run typecheck
npm --prefix src/web/ui test
```

The Python suite includes two storyboard checks for the absent `docs/scenes` directory. Those checks
currently fail.

## Live Playwright checks

Use the explicit live config in `src/web/ui/playwright.live.config.ts` for deployed read-only
verification:

```bash
LIVE_BASE_URL=https://<deployed-web-app-url> \
npm --prefix src/web/ui run e2e -- --config playwright.live.config.ts
```

- Default selection runs only `@live-readonly` tests.
- Live mutation tests are opt-in and gated behind `LIVE_INCLUDE_MUTATION=1`.
- `LIVE_BASE_URL` is required. The live config has no baked-in deployment fallback.
- The default local Playwright config excludes `tests/live-experience.spec.ts`.
- The local suite does not substitute fixtures on successful live paths.

## Survey application

The survey is a separate Container App, not a route in the health app. Its home page offers Create,
Join, and remembered authors' Edit links. Statements render as text. Drag handles and Up/Down
controls reorder stable question IDs. Voting locks all existing wording permanently, including
after every answer has been reset; adding and reordering remain available.

Keep the private editing URL. Its fragment contains a 256-bit capability, removed from the active
address before API calls. Losing browser storage removes the home-page Edit list; the private URL
is the recovery mechanism. Author storage failures keep the active session in memory with a
warning. QR codes contain only the public `/join/{code}` URL.

Response recognition uses a random per-survey localStorage key persisted before the first write.
There is no fingerprinting or IP recognition. The same key updates one ballot; cleared storage or
another browser can create another ballot. Storage or authentication failures never silently
replace a key. Sliders initially display 50 but are unanswered. Deliberately selecting 50 counts;
Reset/Delete answer removes that answer, restores unanswered 50, and preserves other answers.
Partial answers autosave with status and retry. Results use each question's answered count.

Codes and results are public, not confidential. Small groups and changes between aggregate reads
can reveal individual answers. This is not a one-person-one-vote system or a compliance guarantee.
No expiry or deletion policy is implemented.

Install survey dependencies with `npm --prefix src/survey/ui ci` and
`uv pip install --python .venv-health-ui/bin/python -r src/survey/requirements.txt`.
`make survey-dev` builds and serves it at `http://127.0.0.1:8081` against the selected provisioned
Azure database. This command connects to Azure; it is not an isolated test fixture. It requires the
administrator migration and existing identity's additive survey grants. It does not change `make dev`.

For isolated verification, use an explicitly disposable local PostgreSQL 16 database and a local
administrator connection in `SURVEY_TEST_DSN`. Create the test login `survey_test` there first.
Never point this variable at a shared or deployed database. The tests create/drop only named local
proof databases and apply the survey migration there.

| Command | Scope |
|---------|-------|
| `.venv-health-ui/bin/python -m unittest discover -s src/survey/tests` | Public HTTP, privacy, deployment contracts and (with `SURVEY_TEST_DSN`) real transactions/migrations |
| `npm --prefix src/survey/ui run typecheck` | Strict frontend types |
| `npm --prefix src/survey/ui test` | Immutable calculations and save/reset ordering |
| `npm --prefix src/survey/ui run e2e -- --project chromium` | Real local FastAPI-backed browser flows, requires `SURVEY_TEST_DSN`; no Azure credential or exporter |
| `npm --prefix src/survey/ui run build` | Production UI |

The built-image checks in `src/survey/tests/test_container_http.py` use
`SURVEY_CONTAINER_BASE_URL` pointing to an actual production container's HTTP endpoint.
Run the Dockerfile's normal CMD, not a source-mounted or injected application fixture.
`container_boundary.py` is an external HTTPS managed-identity/ingestion protocol fixture;
it requires disposable `SURVEY_BOUNDARY_CERT`/`SURVEY_BOUNDARY_KEY` and records only operation
names and resource-envelope counts in memory. The production image still uses its normal Azure
Identity, TLS PostgreSQL and Azure Monitor transport. These local protocol checks do not prove
Entra grants or native Azure ingestion.

The browser fixture listens only on loopback and disables access logs and telemetry export.
Its Playwright processes stop automatically. Capabilities must not be captured in persistent
traces, logs, or screenshots. Database-dependent tests skip if their explicit fixture is absent;
a skipped test is not passing native PostgreSQL evidence.

## Local limits

- The request journey needs the private Storage Queue endpoint. Run it through the deployed app.
- `make dev` stays running if one service exits. Check that service's terminal output.
- If configuration is missing, check the selected environment and its outputs before provisioning.
