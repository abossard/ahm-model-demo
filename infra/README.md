# Infrastructure

`main.bicep` provisions the whole demo at subscription scope, in one region: the resource group, a small virtual
network, a web Container App and an Azure MCP server Container App, two Entra app registrations, a Foundry account
with a project and a model, a private blob store for Sessions, and two Azure Health Models.

- Set `AZURE_LOCATION` to `swedencentral` before the first provision. Foundry hosted agents are not available
  in North Europe, and every resource uses `location`. A region cannot change in place.
- Bicep does not create the hosted agent. The deploy hook does (see Hosted agent deploy); its Entra identity exists
  only after that.

## Resources

| Resource | Module | Notes |
|----------|--------|-------|
| Container App `ca-<env>-web` in environment `cae-<env>` | `container-app.bicep`, `foundation.bicep` | Workload profiles environment with only the Consumption profile, joined to the VNet, one replica. Serves the FastAPI app and the SPA. |
| Container App `ca-<env>-mcp` | `container-app.bicep` | The Azure MCP server (`src/mcp`), external ingress, one replica. See Azure MCP server. |
| App registrations `ahm-<env>-web` and `ahm-<env>-mcp` with their service principals and federated credentials | `entra.bicep` | See Sign-in and on-behalf-of. |
| Virtual network `vnet-<env>` | `foundation.bicep` | Two subnets, one for the environment and one for private endpoints. See Network. |
| Identity `id-<env>-app` | `foundation.bicep` | The web app's workload identity. |
| Container registry (Basic) | `foundation.bicep` | Holds the web, MCP and hosted agent images. |
| Log Analytics, Application Insights, availability tests | `foundation.bicep`, `availability-tests.bicep` | One test GETs the home page and one GETs `/health` of the MCP server, each every 5 minutes. |
| Storage account with the `sessions` container, its private endpoint and private DNS zone | `storage.bicep` | Session store. |
| Foundry account, project `proj-<env>`, model, egress policy | `foundry.bicep` | See Foundry. |
| `hm-<env>`, `hm-<env>-design` | `health-model*.bicep`, `design-health-model.bicep` | See Health models. |
| Activity log diagnostics | `subscription-monitoring.bicep` | Subscription scope. |

## Network

- `vnet-<env>` is `10.42.0.0/25` with two subnets and nothing else: no network security group, route table or gateway.
  - `snet-container-apps` (`10.42.0.0/26`) is delegated to `Microsoft.App/environments` and holds only the Container
    Apps environment. A workload profiles environment needs at least a /27, and its subnet size cannot change after
    creation, so the /26 leaves room for the extra addresses a revision change uses.
  - `snet-private-endpoints` (`10.42.0.64/29`) holds the session store's private endpoint.
- `cae-<env>` joins the first subnet with `internal: false`. The web app stays reachable from the internet through the
  environment's public IP, and outbound internet access is the platform default.
- Keep the VNet clear of the address ranges Container Apps reserves, listed in
  [custom virtual networks](https://learn.microsoft.com/azure/container-apps/custom-virtual-networks).
- An environment created without a VNet cannot be joined to one. Delete the web app and `cae-<env>`, then provision.

## Session store

- Storage account `stahm<token>`: Entra only (`allowSharedKeyAccess: false`), no public blob access, TLS 1.2, and
  `publicNetworkAccess: Disabled`. A governance policy forces public network access off on storage accounts, so the web
  app reaches the store through a private endpoint.
- `pe-<env>-blob` is a `blob` private endpoint in `snet-private-endpoints`. The private DNS zone
  `privatelink.blob.<storage suffix>` is linked to the VNet, and a zone group on the endpoint fills it, so inside the
  VNet `<account>.blob.core.windows.net` resolves to the endpoint's private address.
- One private container, `sessions`. The workload identity has Storage Blob Data Contributor on that container only.
- Output and web env var `SESSIONS_CONTAINER_URL`: `https://<account>.blob.core.windows.net/sessions`. It is the
  public host name, which resolves privately only inside the VNet.
- Nothing outside the VNet reaches the store, so `make dev` exports `SESSIONS_CONTAINER_URL=memory:` and keeps
  Sessions in process memory.
- Blob diagnostics go to Log Analytics. The agent never touches the store, so its egress policy has no blob host.

## Foundry

- `foundry.bicep` creates the AIServices account, the project, the `gpt-5.4-mini` deployment (GlobalStandard) and
  the `agent-egress` RAI policy. The deployment capacity is in thousands of tokens per minute:
  `AZURE_MODEL_CAPACITY`, default 500. A Task sends 200k to 780k tokens (mostly cached), so 100 answered 429 when
  runs started under 90 s apart or two people used the app at once. If quota is short, lower it with
  `azd env set AZURE_MODEL_CAPACITY <n>` before `azd provision`; fewer concurrent Tasks fit then.
- The policy lists the Microsoft.DefaultV2 content filters explicitly, because the service rejects a custom policy
  without them and an empty list would carry none.
- Check quota before provisioning: `az cognitiveservices usage list -l swedencentral`, row
  `OpenAI.GlobalStandard.gpt-5.4-mini` (`currentValue` plus the new capacity must stay under `limit`).
- The policy denies all session egress except exact hosts: this account's own `<account>.services.ai.azure.com`,
  `<account>.openai.azure.com` and `<account>.cognitiveservices.azure.com`, the web app, the MCP server, `github.com`
  and `codeload.github.com`. The web and MCP hosts are the apps' names on the environment's default domain, so they are
  known before the apps exist. ARM, Entra login and `api.loganalytics.io` are not listed: the agent holds no Azure
  token, and the MCP server exchanges the user's token itself. There are no wildcards: they would also match other
  tenants, and Application Insights ingestion with a foreign key needs no authentication, so it would be an
  exfiltration route. The project has no Application Insights connection, and Foundry's required platform
  connectivity is allowed separately. Each agent version must reference `FOUNDRY_AGENT_EGRESS_POLICY_ID`; a missing
  reference fails open.
- Roles in Bicep: the project identity gets Foundry User on the account and AcrPull on the registry. The web
  identity gets Foundry Agent Consumer on the project. The deployer (`principalId`) gets Foundry Project Manager.
- The hosted agent runs under its own Entra agent identity and has no Azure role. Its tools run in the MCP server as
  the signed-in user.

## Image-based hosted agent

The agent ships as a container image from the registry, because its `azmcp` binary is over the 250 MB ZIP limit.

- The project identity pulls the image. The registry is Basic and pinned to `LegacyRegistryPermissions` mode,
  where AcrPull is the pull role. Container Registry Repository Reader is the pull role for registries in ABAC mode
  (`AbacRepositoryPermissions`), which this template does not use.
- The registry keeps `azureADAuthenticationAsArmPolicy` enabled. Do not disable it.
- The image is `linux/amd64`, built in the registry by the deploy hook.
- If a version fails with `image_pull_failed`, check the two settings above and the image tag. The azd agent path
  also grants AcrPull to the agent's own identity at deploy time; do the same if the project identity is not enough.

## Hosted agent deploy

The `postdeploy` hook in `azure.yaml` runs `src/agent/deploy/deploy-agent.sh` once, after `azd deploy` or `azd up` has
deployed every service. azd exports the environment values to it. Run it alone with `azd hooks run postdeploy`.

- It builds the image in the registry (`az acr build`) and creates the agent or a new version through the Foundry REST
  API with `FOUNDRY_AGENT_EGRESS_POLICY_ID` as the egress policy. If a new version does not reference the policy, the
  run deletes it and fails, because its sessions would have open egress. Then it waits until the version is active.
  A version still provisioning from an earlier run is reused, not duplicated.
- Then it hands the agent identity to the web app, which uses it to recognise the agent's token requests. Two commands,
  the second one so that no second provision is needed:

  ```bash
  azd env set FOUNDRY_AGENT_PRINCIPAL_ID "$PRINCIPAL_ID"
  az containerapp update --subscription "$AZURE_SUBSCRIPTION_ID" --resource-group "$AZURE_RESOURCE_GROUP" --name "$SERVICE_WEB_NAME" --set-env-vars "FOUNDRY_AGENT_PRINCIPAL_ID=$PRINCIPAL_ID" --output none
  ```

  `FOUNDRY_AGENT_PRINCIPAL_ID` is a `main.bicep` parameter (empty by default) that the web app's environment carries,
  so the next `azd provision` keeps the value. The second command starts a new web revision.
- The deployer needs Foundry Project Manager on the project (Bicep grants it to `principalId`), and Contributor or
  Container Registry Tasks Contributor on the registry for the build. Right after provisioning Foundry may answer 403
  while that role propagates; the script retries for a while. The machine needs `az`, `jq`, `curl` and `git`.
- A deleted and recreated agent gets a new identity: run the hook again so the web app learns it.
- The agent name is `FOUNDRY_AGENT_NAME`, the name the web app calls. Optional overrides, set with `azd env set` or in
  the shell: `AGENT_NAME` (replaces the name, so the web app would not call that agent), `ACTIVATION_TIMEOUT_SECONDS`
  (600), `POLL_INTERVAL_SECONDS` (5) and `FORBIDDEN_RETRY_SECONDS` (180).

## Health models

| Model | What it describes |
|-------|-------------------|
| `hm-<env>` | The app: 15 authored entities and 16 relationships over live metrics, log queries and the availability tests, plus an Application Insights discovery rule. The web app selects it by default. |
| `hm-<env>-design` | Empty until a Design task's approved changes are applied. It has its own identity with Reader and Monitoring Reader. |

`hm-<env>` topology, top to bottom:

- Root `Health Pulse` alerts at Sev2 when Unhealthy.
- User flows: View Health Model, Send Health Reports, Run agent tasks.
- System components: App Hosting (shared by all three flows), then Agent Runtime, AI Inference and Session Store
  (under Run agent tasks). Agent Runtime holds the hosted agent and the Azure MCP server.
- Resources hold every signal:

| Entity | Bound to | Signals |
|--------|----------|---------|
| `container-app` | The web Container App | CPU, memory, response time (5 minute grain: it reports only for minutes with requests). Failed requests (HTTP 5xx only, not 4xx), exceptions, home page availability. Resource Health is off: Container Apps do not support it (HTTP 422). |
| `hosted-agent` | The Foundry project | `agent-task-failures` (degraded above 0, unhealthy above 2 in 15 minutes) and `agent-task-latency` (p95 over 15 minutes, degraded above 120 s, unhealthy above 300 s), both over the web app's `foundry.agent.*` spans in `AppDependencies`. |
| `mcp-server` | The MCP Container App | CPU, memory, response time (all 5 minute grain; the response time threshold of 10 s is an assumption: no traffic has run through it yet) and the availability of `/health`. No request-based signal: the server's exporter has no credential for the Entra-only Application Insights, so its requests never reach `AppRequests`. Resource Health is off. |
| `foundry-account` | The Foundry account | Client errors, server errors, throttled requests (`ModelRequests` with `StatusCode eq '429'`, which has no series and reads Unknown until the first 429). |
| `session-storage` | The blob service of the session store | Availability, end-to-end latency. Storage emits both only for minutes with blob transactions, so they read Unknown while Sessions are idle. |

- `platform-context` (Limited impact) reads activity log events. The activity log spans the subscription, so the
  failed-operations signal counts this resource group only, and the workspace records a failure as `Failure`.
- `discovered-app-topology` (Suppressed) has no children. The discovery rule builds its own tree (rule entity, the
  application's role, the storage account) with no parent, so discovered entities never roll up into the root. The rule
  adds no recommended signals: its storage account defaults (latency above 15 ms is Unhealthy) turned a healthy account Unhealthy.
- Logical entities roll up `WorstOf` and ignore Unknown children. Every entity has a 99% health objective.
- The agent signals read telemetry the web app emits: CLIENT spans named `foundry.agent.*` (`foundry.agent.respond`
  per Task run). With no task in the window the latency query returns no row, so it reads Unknown.
- A query signal evaluates over its `timeGrain`, which is intersected with the query's own `ago()`. Keep them equal:
  a 15 minute query on a 5 minute grain answered 33% while its 15 minute run said 40%. A test enforces it.
- After a monitored resource is deleted and recreated under the same id, its metric signals stay frozen on the old
  "not found" error until the signal definition changes or the entity is recreated. A provision that changes nothing
  does not re-arm them: change the grain or another property of each frozen signal, then provision.
- Turning `addRecommendedSignals` off on a discovery rule does not remove the signals already added to discovered
  entities. They stay until a PUT of the entity without them.
- The model identity has Reader and Monitoring Reader on the resource group. The web identity has no health model
  role: reads, reports and Apply run as the signed-in user.
- Bicep uses API version `2026-05-01-preview`. The GA `2026-11-01` is registered for all CloudHealth types, but
  Bicep 0.46 has no types for it and warns on every resource. Switch all of them once `az bicep` is 0.49 or later.

## Sign-in and on-behalf-of

Users sign in with Entra ID, and the web app and the agent reach Azure as that user (ADR 0006, plan.md). There is no
catalog scope and no health model role for the app: the model selector lists what the user can read.

- `entra.bicep` uses the Microsoft Graph Bicep extension (`infra/bicepconfig.json`, Bicep 0.36.1 or later) and creates
  two single-tenant app registrations with service principals, named `ahm-<env>-web` and `ahm-<env>-mcp`:
  - `web` is the SPA and its API. Redirect URIs `https://<web host>/` and `http://localhost:8080/`, scope
    `access_as_user`, token version 2. It needs ARM `user_impersonation`, the `mcp` scope and its own scope.
  - `mcp` is the Azure MCP server. Scope `Mcp.Tools.ReadWrite`, token version 2, pre-authorizing `web`. It needs ARM
    `user_impersonation` and Log Analytics `Data.Read`.
  - Each has a federated credential that trusts the workload identity `id-<env>-app` (subject: its object id, audience
    `api://AzureADTokenExchange`), so no client secret exists. Both apps sign the on-behalf-of exchange with it.
- Each app is declared twice in `entra.bicep` with the same `uniqueName`, because identifier URIs and the two apps'
  references to each other need an application id that exists only after creation. A uniqueName that survives an
  out-of-band delete conflicts on the next provision (restore the app or purge it from the deleted items), and a new
  app takes a short while to replicate.
- On-behalf-of has no consent screen. After `azd provision` the `postprovision` hook
  (`scripts/hooks/postprovision.sh`) grants tenant-wide admin consent for both apps and waits for replication. A
  deployer needs Global Administrator, Privileged Role Administrator, Cloud Application Administrator or
  Application Administrator. Without one the hook fails before it changes anything and prints the manual commands,
  to be run by an administrator in this order: `az ad app permission admin-consent --id <ENTRA_MCP_CLIENT_ID>`, then
  `az ad app permission admin-consent --id <ENTRA_CLIENT_ID>`. Until then every token request answers a claims
  challenge.
- What users need in Azure RBAC, because every call runs as them: Reader on the resource group or subscription to browse
  and select a model, and Microsoft.CloudHealth read (included in Reader) for history. Health reports need
  `Microsoft.CloudHealth/healthmodels/entities/ingestHealthReport/action`, and Apply needs write and delete on the
  model's entities, relationships and signal definitions (for example Contributor on the group). The agent reads with
  the same rights as the user, through Monitoring Reader or Reader and Log Analytics Reader for queries.
- Outputs and web app environment: `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` (web), `ENTRA_API_SCOPE`
  (`api://<web id>/access_as_user`), `MCP_SCOPE` (`api://<mcp id>/Mcp.Tools.ReadWrite`), `MCP_URL` (the MCP app's URL;
  the server answers at `/`) and `FOUNDRY_AGENT_PRINCIPAL_ID`. `ENTRA_MCP_CLIENT_ID` is an output only, for the hook.
- `ENTRA_ALLOW_AZURE_CLI` (default `false`, `azd env set ENTRA_ALLOW_AZURE_CLI true`, then `azd provision`) pre-authorizes
  the Azure CLI for the `access_as_user` scope of the web app only, so an unattended check can run
  `az account get-access-token --scope <ENTRA_API_SCOPE>` as the signed-in developer and call the API with that token,
  still bounded by the developer's own Azure RBAC. It is off by default because it lets any user in the tenant script
  the API the same way; the MCP app is never pre-authorized for it, so the MCP scope stays reachable only through the
  web app's exchange.
- `AUTH_MODE=local` is what `make dev` exports: no managed identity, so no on-behalf-of. The web app acts as the
  developer's `az login` identity and nobody signs in. The app refuses this mode inside a Container App.
- Removing the old grants from an existing environment: incremental deployment does not delete the web identity's
  custom role assignments, the three custom role definitions, or the agent identity's Azure role assignments. List and
  delete them with `az role assignment list --all --assignee <principal id>` and `az role definition list
  --custom-role-only true`, then `az role assignment delete` and `az role definition delete`.

## Azure MCP server

- `src/mcp/Dockerfile` builds `azmcp` from `AZMCP_REPO` and `AZMCP_REF` (build arg defaults) on the .NET SDK image
  `AZMCP_SDK`, an exact tag such as `10.0.403`, because the floating `sdk:10.0` tag broke the build. Keep it in step
  with the `sdk.version` in the `global.json` of `AZMCP_REF`. The runtime is the chiseled `runtime-deps` image, with
  invariant globalization (no ICU) and a non-root user. To build another source, change the defaults in the
  Dockerfile: azd passes no build args, and an unset one would blank the default.
- The container runs `azmcp server start --transport http --outgoing-auth-strategy UseOnBehalfOf --mode all
  --namespace monitor --namespace group --read-only`. Every request needs a user token for the `mcp` app with the
  `Mcp.Tools.ReadWrite` scope; the server exchanges it for ARM and Log Analytics tokens as that user.
- Environment (`AzureAd__*`) comes from `entra.bicep` and the workload identity as a managed identity signed
  assertion. TLS ends at the ingress, so HTTPS redirection is off and `X-Forwarded-Proto` is trusted. `/health` is
  anonymous and answers the availability probe. Port 8080, path `/`.
- Telemetry is off (`AZURE_MCP_COLLECT_TELEMETRY=false`): the server's exporter has no credential, Application Insights
  here accepts only Entra tokens, and product telemetry stays inside the deployment.
- External ingress, because the hosted agent calls it from Foundry's network. Every request still needs a token.
- The first provision runs a placeholder image on the app until `azd deploy mcp` publishes the real one, so the MCP
  availability signal and the `mcp-server` entity read Unhealthy until then.

## Deploying

For a first deployment, follow [Get started from scratch](../README.md#get-started-from-scratch).

- `azd up` provisions and deploys. `azd provision` changes infrastructure and then grants admin consent.
  `azd deploy` publishes the web and MCP images, then runs the agent deploy hook.
- azd sets `AZURE_PRINCIPAL_ID`, the deployer who becomes Foundry Project Manager.
- The subscription-scope module is deployed as `subscription-monitoring-<region>`. A deployment record's name is bound to
  its region, so a bare name collides with an environment in another region (`InvalidDeploymentLocation`).
- Optional azd environment values: `AZURE_MODEL_CAPACITY`. Set by the deploy hooks: `SERVICE_WEB_IMAGE_NAME`,
  `SERVICE_MCP_IMAGE_NAME` (azd, after `azd deploy`) and `FOUNDRY_AGENT_PRINCIPAL_ID` (the agent deploy script).
- Do not provision this template over an environment created by an older version: its region, its Container Apps
  environment (the VNet cannot be added, changed or removed in place) and its health model entities cannot be updated
  in place, and incremental deployment does not delete entities or relationships removed from Bicep. Use a new azd
  environment.
- Inspect any existing environment before provisioning. Saved Designer layouts and portal edits to Bicep-defined
  entities are overwritten.

## Designer layout round-trip

The `canvasPosition` values in `health-model-entities.bicep` are the saved layout. After Arrange or manual
positioning, save in Designer, export `hm-<env>` as Bicep, and copy the final coordinates into the module.
Otherwise the next provision restores the old positions. Coordinates prove placement, not readability.

```bash
az group export --subscription <sub> --name rg-<env> \
  --resource-ids <model-id> --export-format bicep --include-parameter-default-value
```

## Verifying

```bash
BASE="https://management.azure.com/subscriptions/<sub>/resourceGroups/rg-<env>/providers/Microsoft.CloudHealth/healthmodels"

az rest --subscription <sub> --method get --url "$BASE?api-version=2026-05-01-preview" # two models
az rest --subscription <sub> --method get --url "$BASE/hm-<env>/entities?api-version=2026-05-01-preview" # 15 plus discovered
az rest --subscription <sub> --method get --url "$BASE/hm-<env>/relationships?api-version=2026-05-01-preview" # 16 plus discovered
```

- An entity's `properties.healthState` is `Unknown` until its first evaluation, a few minutes after deployment.
- Follow `nextLink`: relationship pages hold 50.
- Missing data is not a successful check. Take two samples at least five minutes apart and require each signal's
  `reportedAt` to advance.
